// store.ts — the forge's whole state, in memory: repositories, git objects and refs,
// labels, issues, pull requests and comments. Nothing here reads the clock or any
// randomness: every timestamp and identity is a fixed constant, so two runs over the
// same requests hold byte-identical state.
import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  type CommitInfo,
  type ObjectType,
  type StoredObject,
  type TreeEntry,
} from './gitobj.ts';

/** The login the suite's token names: the fixed scenario viewer (wire.ts SCENARIO_SEED). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;

/** The fixed timestamp every stored object and commit carries (SCENARIO_EPOCH_SEC). */
export const FIXED_EPOCH_SEC = 1735689600;
export const FIXED_TIMESTAMP = '2025-01-01T00:00:00.000Z';
/** The fixed git identity of commits the forge itself authors (contents API, merges). */
export const FORGE_IDENT = 'Forge <forge@forge.invalid> 1735689600 +0000';

export const DEFAULT_BRANCH = 'main';

// ---------------------------------------------------------------- records

export interface CommentRecord {
  id: number;
  body: string;
}

export interface IssueRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRecord[];
}

export interface PullRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  comments: CommentRecord[];
}

export interface LabelRecord {
  name: string;
  color: string;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
}

// ---------------------------------------------------------------- one repository

export class RepoState {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  isPrivate: boolean;
  description: string;
  readonly defaultBranch = DEFAULT_BRANCH;

  /** Git objects by id. */
  readonly objects = new Map<string, StoredObject>();
  /** Memoized deflated bytes per object id (pack building). */
  readonly deflated = new Map<string, Buffer>();
  /** Memoized parsed commits/trees/tags: objects are immutable, so parsing once is safe. */
  readonly commitCache = new Map<string, CommitInfo>();
  readonly treeCache = new Map<string, TreeEntry[]>();
  readonly tagCache = new Map<string, { object: string; type: ObjectType }>();
  /** Full ref name -> tip oid. HEAD always means refs/heads/main. */
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, LabelRecord>();
  readonly issues = new Map<number, IssueRecord>();
  readonly pulls = new Map<number, PullRecord>();
  /** Issues and pull requests share one numbering sequence, as on GitHub. */
  nextNumber = 1;

  constructor(id: number, owner: string, name: string, isPrivate: boolean, description: string) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.isPrivate = isPrivate;
    this.description = description;
  }

  // ------------------------------------------------------------ objects

  getObject(oid: string): StoredObject | undefined {
    return this.objects.get(oid);
  }

  putObject(type: ObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  putObjects(objects: ReadonlyMap<string, StoredObject>): void {
    for (const [oid, object] of objects) {
      if (!this.objects.has(oid)) this.objects.set(oid, object);
    }
  }

  parseCommit(oid: string): CommitInfo | null {
    const cached = this.commitCache.get(oid);
    if (cached !== undefined) return cached;
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    const parsed = parseCommit(object.data);
    this.commitCache.set(oid, parsed);
    return parsed;
  }

  parseTree(oid: string): TreeEntry[] | null {
    const cached = this.treeCache.get(oid);
    if (cached !== undefined) return cached;
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'tree') return null;
    const parsed = parseTree(object.data);
    this.treeCache.set(oid, parsed);
    return parsed;
  }

  /** Resolve a tag id to its ultimate non-tag target, following tag chains. */
  peelTag(oid: string): string {
    let current = oid;
    for (let depth = 0; depth < 16; depth += 1) {
      const object = this.objects.get(current);
      if (object === undefined || object.type !== 'tag') return current;
      let cached = this.tagCache.get(current);
      if (cached === undefined) {
        const parsed = parseTag(object.data);
        cached = { object: parsed.object, type: parsed.type };
        this.tagCache.set(current, cached);
      }
      current = cached.object;
    }
    return current;
  }

  // ------------------------------------------------------------ refs

  /** Resolve a ref name, HEAD, or raw oid to a commit oid (tags are peeled). */
  resolveToCommit(ref: string): string | null {
    if (ref === 'HEAD') ref = `refs/heads/${this.defaultBranch}`;
    let oid: string | undefined;
    if (ref.startsWith('refs/')) {
      oid = this.refs.get(ref);
    } else if (isOid(ref)) {
      oid = ref;
    } else {
      oid = this.refs.get(`refs/heads/${ref}`) ?? this.refs.get(`refs/tags/${ref}`);
    }
    if (oid === undefined || oid === ZERO_OID) return null;
    if (!this.objects.has(oid)) return null;
    const peeled = this.peelTag(oid);
    const object = this.objects.get(peeled);
    if (object === undefined || object.type !== 'commit') return null;
    return peeled;
  }

  /** The tip of a branch, or null when the branch has no commit yet. */
  branchTip(branch: string): string | null {
    const oid = this.refs.get(`refs/heads/${branch}`);
    return oid === undefined ? null : oid;
  }

  /** All refs, sorted by name, as [name, oid] pairs. */
  sortedRefs(): Array<[string, string]> {
    return [...this.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  // ------------------------------------------------------------ graph walks

  /**
   * Walk ancestors from `tip`, newest first, following parents in order, each commit
   * once. `limit` bounds the walk when given.
   */
  walkCommits(tip: string, limit?: number): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.parseCommit(oid);
      if (commit === null) continue;
      out.push(oid);
      if (limit !== undefined && out.length >= limit) break;
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i]!);
    }
    return out;
  }

  /** Whether `ancestor` is reachable from `tip` (or equal to it). */
  isAncestor(ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.parseCommit(oid);
      if (commit === null) continue;
      for (const parent of commit.parents) stack.push(parent);
    }
    return false;
  }

  /** The merge base of two tips: the nearest common ancestor by breadth-first distance. */
  mergeBase(a: string, b: string): string | null {
    if (a === b) return a;
    const distA = new Map<string, number>();
    const queueA: Array<[string, number]> = [[a, 0]];
    while (queueA.length > 0) {
      const [oid, dist] = queueA.shift()!;
      if (distA.has(oid)) continue;
      distA.set(oid, dist);
      const commit = this.parseCommit(oid);
      if (commit === null) continue;
      for (const parent of commit.parents) queueA.push([parent, dist + 1]);
    }
    let best: string | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    const seenB = new Set<string>();
    const queueB: Array<[string, number]> = [[b, 0]];
    while (queueB.length > 0) {
      const [oid, dist] = queueB.shift()!;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      const da = distA.get(oid);
      if (da !== undefined && da + dist < bestDist) {
        best = oid;
        bestDist = da + dist;
      }
      if (dist + 1 >= bestDist) continue;
      const commit = this.parseCommit(oid);
      if (commit === null) continue;
      for (const parent of commit.parents) queueB.push([parent, dist + 1]);
    }
    return best;
  }

  // ------------------------------------------------------------ trees

  /** Flatten a tree (recursively) into path -> {oid, mode} for regular files. */
  flattenTree(treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    const entries = this.parseTree(treeOid);
    if (entries === null) return out;
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') this.flattenTree(entry.oid, path, out);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
    return out;
  }

  /** Look a path up in a tree: the blob entry, a directory marker, or null. */
  lookupPath(
    treeOid: string,
    parts: readonly string[],
  ): { kind: 'file'; oid: string; mode: string } | { kind: 'dir'; oid: string } | null {
    let current = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const entries = this.parseTree(current);
      if (entries === null) return null;
      const entry = entries.find((candidate) => candidate.name === parts[i]);
      if (entry === undefined) return null;
      const last = i === parts.length - 1;
      if (entry.mode === '40000') {
        if (last) return { kind: 'dir', oid: entry.oid };
        current = entry.oid;
      } else {
        if (!last) return null;
        return { kind: 'file', oid: entry.oid, mode: entry.mode };
      }
    }
    return { kind: 'dir', oid: treeOid };
  }

  /**
   * Return a new root tree oid with `parts` set to `blobOid` (a file write) or removed
   * (`blobOid` null). Intermediate trees are created or pruned as needed; every new tree
   * object is stored. The original tree is untouched.
   */
  updateTree(rootOid: string | null, parts: readonly string[], blobOid: string | null): string {
    if (parts.length === 0) throw new Error('updateTree needs a non-empty path');
    const [head, ...rest] = parts as [string, ...string[]];
    const entries = rootOid === null ? [] : (this.parseTree(rootOid) ?? []);
    const next: TreeEntry[] = [];
    let found = false;
    for (const entry of entries) {
      if (entry.name !== head) {
        next.push(entry);
        continue;
      }
      found = true;
      if (rest.length === 0) {
        // The leaf itself.
        if (blobOid !== null) next.push({ mode: '100644', name: head, oid: blobOid });
        // else: drop the entry (a delete).
      } else if (entry.mode === '40000') {
        const child = this.updateTree(entry.oid, rest, blobOid);
        const childEntries = this.parseTree(child) ?? [];
        if (childEntries.length > 0) next.push({ mode: '40000', name: head, oid: child });
        // else: the directory emptied out; drop it.
      } else {
        // A file sits where a directory must go: replace it with the new subtree.
        const child = this.updateTree(null, rest, blobOid);
        next.push({ mode: '40000', name: head, oid: child });
      }
    }
    if (!found) {
      if (rest.length === 0) {
        if (blobOid !== null) next.push({ mode: '100644', name: head, oid: blobOid });
      } else {
        const child = this.updateTree(null, rest, blobOid);
        next.push({ mode: '40000', name: head, oid: child });
      }
    }
    return this.putObject('tree', buildTree(next));
  }

  // ------------------------------------------------------------ diffs

  /** The file-level diff between two trees (base -> head), sorted by path. */
  diffTrees(baseOid: string | null, headOid: string | null): FileChange[] {
    const base = baseOid === null ? new Map() : this.flattenTree(baseOid);
    const head = headOid === null ? new Map() : this.flattenTree(headOid);
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    const changes: FileChange[] = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
      if (b === undefined && h !== undefined) {
        changes.push({ path, status: 'added', additions: countLines(this.blobText(h.oid)), deletions: 0 });
      } else if (b !== undefined && h === undefined) {
        changes.push({ path, status: 'removed', additions: 0, deletions: countLines(this.blobText(b.oid)) });
      } else if (b !== undefined && h !== undefined) {
        const { additions, deletions } = diffLines(this.blobText(b.oid), this.blobText(h.oid));
        changes.push({ path, status: 'modified', additions, deletions });
      }
    }
    return changes;
  }

  blobText(oid: string): string {
    const object = this.objects.get(oid);
    if (object === undefined || object.type !== 'blob') return '';
    return object.data.toString('utf8');
  }

  // ------------------------------------------------------------ authoring

  /** Create a commit object (stored) with the forge's fixed identity and timestamp. */
  createCommit(treeOid: string, parents: readonly string[], message: string): string {
    const data = buildCommit({
      tree: treeOid,
      parents: [...parents],
      author: FORGE_IDENT,
      committer: FORGE_IDENT,
      message,
    });
    return this.putObject('commit', data);
  }
}

// ---------------------------------------------------------------- line diffs

/** The number of lines in `text` (a trailing newline does not add an empty line). */
export function countLines(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.length;
}

/**
 * A multiset line diff: lines gained and lines lost between two texts. Exact enough for
 * the small files the suite diffs, and linear in the number of lines.
 */
export function diffLines(before: string, after: string): { additions: number; deletions: number } {
  const count = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    if (text === '') return map;
    const parts = text.split('\n');
    if (parts[parts.length - 1] === '') parts.pop();
    for (const line of parts) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const a = count(before);
  const b = count(after);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of b) {
    const d = n - (a.get(line) ?? 0);
    if (d > 0) additions += d;
  }
  for (const [line, n] of a) {
    const d = n - (b.get(line) ?? 0);
    if (d > 0) deletions += d;
  }
  return { additions, deletions };
}

// ---------------------------------------------------------------- global ids

/** An opaque, stable GraphQL global id: base64 of `Type:key`, never the bare number. */
export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

/** Decode a global id back to its type and key, or null when it is not one. */
export function parseGlobalId(id: string): { type: string; key: string } | null {
  if (typeof id !== 'string' || id === '') return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const colon = text.indexOf(':');
  if (colon <= 0) return null;
  const type = text.slice(0, colon);
  const key = text.slice(colon + 1);
  if (key === '') return null;
  return { type, key };
}

// ---------------------------------------------------------------- the store

export class Store {
  readonly repos = new Map<string, RepoState>();
  nextRepoId = 1;
  /** One global counter for issue, pull request and comment ids alike. */
  nextGlobalId = 1;

  static key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): RepoState | undefined {
    return this.repos.get(Store.key(owner, name));
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): RepoState {
    const repo = new RepoState(this.nextRepoId++, owner, name, isPrivate, description);
    this.repos.set(Store.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(Store.key(owner, name));
  }

  /** The token owner's repositories, in creation order. */
  reposOf(owner: string): RepoState[] {
    const out: RepoState[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  allocateId(): number {
    return this.nextGlobalId++;
  }
}
