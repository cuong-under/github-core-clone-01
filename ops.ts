// ops.ts — the domain operations the REST, GraphQL and MCP surfaces share:
// creating issues, pull requests and comments, and the squash merge with its
// three-way conflict detection. One implementation, three surfaces, one store.
import { buildTree } from './gitobj.ts';
import {
  DEFAULT_BRANCH,
  FIXED_TIMESTAMP,
  type FileChange,
  type IssueRecord,
  type PullRecord,
  type RepoState,
  type Store,
} from './store.ts';

// ---------------------------------------------------------------- issues

export function createIssue(
  store: Store,
  repo: RepoState,
  title: string,
  body: string,
  labelNames: readonly string[],
): { issue: IssueRecord } | { error: string } {
  for (const name of labelNames) {
    if (!repo.labels.has(name)) return { error: `label "${name}" does not exist` };
  }
  const issue: IssueRecord = {
    id: store.allocateId(),
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    labels: [...labelNames],
    comments: [],
  };
  repo.issues.set(issue.number, issue);
  return { issue };
}

// ---------------------------------------------------------------- pull requests

/** Normalize a head/base ref as the API accepts it: `branch`, `owner:branch`, or a full ref. */
export function normalizeBranchRef(ref: string): string {
  let out = ref.trim();
  if (out.startsWith('refs/heads/')) out = out.slice('refs/heads/'.length);
  const colon = out.indexOf(':');
  if (colon >= 0) out = out.slice(colon + 1);
  return out;
}

export function createPull(
  store: Store,
  repo: RepoState,
  head: string,
  base: string,
  title: string,
  body: string,
): { pull: PullRecord } | { error: string } {
  const headRef = normalizeBranchRef(head);
  const baseRef = normalizeBranchRef(base);
  const headSha = repo.branchTip(headRef);
  const baseSha = repo.branchTip(baseRef);
  if (headSha === null) return { error: `head branch "${headRef}" does not exist` };
  if (baseSha === null) return { error: `base branch "${baseRef}" does not exist` };
  const pull: PullRecord = {
    id: store.allocateId(),
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    headRef,
    baseRef,
    headSha,
    baseSha,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    comments: [],
  };
  repo.pulls.set(pull.number, pull);
  return { pull };
}

export function addComment(
  store: Store,
  record: IssueRecord | PullRecord,
  body: string,
): { id: number; body: string } {
  const comment = { id: store.allocateId(), body };
  record.comments.push(comment);
  return comment;
}

// ---------------------------------------------------------------- merge machinery

/** Build a tree object from a flat path -> blob map, storing every intermediate tree. */
export function buildTreeFromFiles(
  repo: RepoState,
  files: ReadonlyMap<string, { oid: string; mode: string }>,
): string {
  const build = (paths: Array<[string, { oid: string; mode: string }]>): string => {
    const direct: Array<{ mode: string; name: string; oid: string }> = [];
    const grouped = new Map<string, Array<[string, { oid: string; mode: string }]>>();
    for (const [path, entry] of paths) {
      const slash = path.indexOf('/');
      if (slash < 0) {
        direct.push({ mode: entry.mode, name: path, oid: entry.oid });
      } else {
        const dir = path.slice(0, slash);
        const rest = path.slice(slash + 1);
        const list = grouped.get(dir) ?? [];
        list.push([rest, entry]);
        grouped.set(dir, list);
      }
    }
    for (const [dir, children] of grouped) {
      direct.push({ mode: '40000', name: dir, oid: build(children) });
    }
    return repo.putObject('tree', buildTree(direct));
  };
  return build([...files.entries()]);
}

export interface MergeContext {
  baseTip: string;
  headTip: string;
  baseTree: string;
  headTree: string;
  mergeBaseTree: string | null;
}

/** Resolve a pull request's live tips and trees, or null when a branch is gone. */
export function mergeContext(repo: RepoState, pull: PullRecord): MergeContext | null {
  const baseTip = repo.branchTip(pull.baseRef);
  const headTip = repo.branchTip(pull.headRef);
  if (baseTip === null || headTip === null) return null;
  const baseCommit = repo.parseCommit(baseTip);
  const headCommit = repo.parseCommit(headTip);
  if (baseCommit === null || headCommit === null) return null;
  const base = repo.mergeBase(baseTip, headTip);
  const mergeBaseTree = base === null ? null : (repo.parseCommit(base)?.tree ?? null);
  return { baseTip, headTip, baseTree: baseCommit.tree, headTree: headCommit.tree, mergeBaseTree };
}

/**
 * Whether the three-way merge conflicts: some path changed on both sides of the
 * merge base to different results (a delete against a modify counts as different).
 */
export function mergeConflicts(repo: RepoState, context: MergeContext): boolean {
  const baseFiles = repo.flattenTree(context.baseTree);
  const headFiles = repo.flattenTree(context.headTree);
  const mbFiles = context.mergeBaseTree === null ? new Map() : repo.flattenTree(context.mergeBaseTree);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys(), ...mbFiles.keys()]);
  for (const path of paths) {
    const b = baseFiles.get(path)?.oid ?? null;
    const h = headFiles.get(path)?.oid ?? null;
    const m = mbFiles.get(path)?.oid ?? null;
    const changedBase = b !== m;
    const changedHead = h !== m;
    if (changedBase && changedHead && b !== h) return true;
  }
  return false;
}

/** The file diff of a pull request: merge base .. head. */
export function pullRequestFiles(repo: RepoState, pull: PullRecord): FileChange[] {
  const context = mergeContext(repo, pull);
  if (context === null) return [];
  return repo.diffTrees(context.mergeBaseTree, context.headTree);
}

export type MergeOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: 'conflict' | 'missing-branch' | 'already-merged' };

/**
 * Squash-merge a pull request: one commit on the base branch whose parent is the
 * base tip and whose tree is the head's diff applied onto the base tree. The pull
 * request becomes closed and merged; the base ref moves to the squash commit.
 */
export function squashMerge(repo: RepoState, pull: PullRecord): MergeOutcome {
  if (pull.merged || pull.state !== 'open') return { ok: false, reason: 'already-merged' };
  const context = mergeContext(repo, pull);
  if (context === null) return { ok: false, reason: 'missing-branch' };
  if (mergeConflicts(repo, context)) return { ok: false, reason: 'conflict' };
  const baseFiles = repo.flattenTree(context.baseTree);
  const headFiles = repo.flattenTree(context.headTree);
  const mbFiles = context.mergeBaseTree === null ? new Map() : repo.flattenTree(context.mergeBaseTree);
  const merged = new Map(baseFiles);
  const paths = new Set<string>([...headFiles.keys(), ...mbFiles.keys()]);
  for (const path of paths) {
    const h = headFiles.get(path);
    const m = mbFiles.get(path);
    const changedHead = (h?.oid ?? null) !== (m?.oid ?? null);
    if (!changedHead) continue;
    if (h === undefined) merged.delete(path);
    else merged.set(path, h);
  }
  const tree = buildTreeFromFiles(repo, merged);
  const sha = repo.createCommit(tree, [context.baseTip], pull.title);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = FIXED_TIMESTAMP;
  pull.mergeCommitSha = sha;
  return { ok: true, sha };
}

export { DEFAULT_BRANCH };
