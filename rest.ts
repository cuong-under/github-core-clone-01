// rest.ts — the REST v3 API under /api/v3: repositories, branches, commits,
// contents, labels, issues, comments and pull requests. Every reply is JSON and
// carries X-GitHub-Request-Id (set by the dispatcher); unknown routes are 404
// JSON; malformed JSON bodies are 400.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FIXED_TIMESTAMP,
  VIEWER_ID,
  VIEWER_LOGIN,
  globalId,
  type IssueRecord,
  type PullRecord,
  type RepoState,
} from './store.ts';
import { createIssue, createPull, addComment, mergeConflicts, mergeContext, pullRequestFiles, squashMerge } from './ops.ts';
import type { RequestContext } from './app.ts';
import { sendError, sendJson } from './app.ts';

// ---------------------------------------------------------------- shapes

function userObject(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, node_id: globalId('User', VIEWER_LOGIN), type: 'User' };
}

/** Shared with the MCP surface so tool results and REST replies describe one store. */
export function repoObject(ctx: RequestContext, req: IncomingMessage, repo: RepoState): Record<string, unknown> {
  const origin = ctx.originOf(req);
  return {
    id: repo.id,
    node_id: globalId('Repository', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userObject(),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP,
    pushed_at: FIXED_TIMESTAMP,
    homepage: '',
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: repo.issues.size + repo.pulls.size,
    license: null,
    allow_forking: true,
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
    html_url: `${origin}/${repo.owner}/${repo.name}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

function labelObject(name: string, color: string): Record<string, unknown> {
  return { name, color, description: '' };
}

export function issueObject(ctx: RequestContext, req: IncomingMessage, repo: RepoState, issue: IssueRecord): Record<string, unknown> {
  const origin = ctx.originOf(req);
  const base = `${origin}/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.owner}/${repo.name}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => labelObject(name, repo.labels.get(name)?.color ?? 'ededed')),
    user: userObject(),
    assignees: [],
    comments: issue.comments.length,
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP,
    closed_at: issue.state === 'closed' ? FIXED_TIMESTAMP : null,
    author_association: 'OWNER',
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${base}/issues/${issue.number}`,
    comments_url: `${base}/issues/${issue.number}/comments`,
  };
}

function pullAsIssueObject(ctx: RequestContext, req: IncomingMessage, repo: RepoState, pull: PullRecord): Record<string, unknown> {
  const origin = ctx.originOf(req);
  const base = `${origin}/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    labels: [],
    user: userObject(),
    assignees: [],
    comments: pull.comments.length,
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP,
    closed_at: pull.state === 'closed' ? FIXED_TIMESTAMP : null,
    author_association: 'OWNER',
    pull_request: { url: `${base}/pulls/${pull.number}`, html_url: `${origin}/${repo.owner}/${repo.name}/pull/${pull.number}` },
    html_url: `${origin}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${base}/issues/${pull.number}`,
    comments_url: `${base}/issues/${pull.number}/comments`,
  };
}

export function pullObject(ctx: RequestContext, req: IncomingMessage, repo: RepoState, pull: PullRecord): Record<string, unknown> {
  const origin = ctx.originOf(req);
  const base = `${origin}/api/v3/repos/${repo.owner}/${repo.name}`;
  const context = mergeContext(repo, pull);
  const mergeable = pull.state === 'open' && context !== null && !mergeConflicts(repo, context);
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${repo.owner}/${repo.name}#${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    user: userObject(),
    labels: [],
    assignees: [],
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP,
    closed_at: pull.state === 'closed' ? FIXED_TIMESTAMP : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable,
    mergeable_state: mergeable ? 'clean' : 'dirty',
    merged_by: pull.merged ? userObject() : null,
    draft: false,
    head: {
      ref: pull.headRef,
      sha: pull.headSha,
      label: `${repo.owner}:${pull.headRef}`,
      user: userObject(),
      repo: repoObject(ctx, req, repo),
    },
    base: {
      ref: pull.baseRef,
      sha: pull.baseSha,
      label: `${repo.owner}:${pull.baseRef}`,
      user: userObject(),
      repo: repoObject(ctx, req, repo),
    },
    html_url: `${origin}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${base}/pulls/${pull.number}`,
  };
}

function commentObject(comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', String(comment.id)),
    body: comment.body,
    user: userObject(),
    created_at: FIXED_TIMESTAMP,
    updated_at: FIXED_TIMESTAMP,
  };
}

// ---------------------------------------------------------------- helpers

type JsonObject = Record<string, unknown>;

function parseBody(body: Buffer): { ok: true; value: JsonObject } | { ok: false } {
  if (body.length === 0) return { ok: true, value: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return { ok: false };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { ok: false };
  return { ok: true, value: parsed as JsonObject };
}

function decodeSegment(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function pageParams(url: URL): { page: number; perPage: number } {
  const pageRaw = Number.parseInt(url.searchParams.get('page') ?? '1', 10);
  const perRaw = Number.parseInt(url.searchParams.get('per_page') ?? '30', 10);
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? pageRaw : 1;
  const perPage = Number.isFinite(perRaw) && perRaw >= 1 ? Math.min(perRaw, 100) : 30;
  return { page, perPage };
}

/** Slice a page and build the Link header (absolute URLs on the request's origin). */
function paginate<T>(items: readonly T[], page: number, perPage: number): { slice: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { slice: items.slice(start, start + perPage), totalPages };
}

function linkHeader(ctx: RequestContext, req: IncomingMessage, url: URL, page: number, perPage: number, totalPages: number): string | null {
  if (totalPages <= 1) return null;
  const origin = ctx.originOf(req);
  const build = (p: number): string => {
    const next = new URL(url.pathname, origin);
    const params = new URLSearchParams(url.searchParams);
    params.set('page', String(p));
    params.set('per_page', String(perPage));
    next.search = params.toString();
    return next.toString();
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`<${build(page + 1)}>; rel="next"`);
  links.push(`<${build(totalPages)}>; rel="last"`);
  if (page > 1) links.push(`<${build(1)}>; rel="first"`, `<${build(page - 1)}>; rel="prev"`);
  return links.join(', ');
}

function sendPage(
  ctx: RequestContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  items: readonly unknown[],
): void {
  const { page, perPage } = pageParams(url);
  const { slice, totalPages } = paginate(items, page, perPage);
  const link = linkHeader(ctx, req, url, page, perPage, totalPages);
  sendJson(res, 200, slice, link === null ? undefined : { link });
}

function parseIdent(ident: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(ident);
  if (match === null) return { name: ident, email: '', date: FIXED_TIMESTAMP };
  const date = new Date(Number(match[3]) * 1000).toISOString();
  return { name: match[1]!, email: match[2]!, date: Number.isNaN(Date.parse(date)) ? FIXED_TIMESTAMP : date };
}

function commitObject(repo: RepoState, oid: string): Record<string, unknown> | null {
  const commit = repo.parseCommit(oid);
  if (commit === null) return null;
  const author = parseIdent(commit.author);
  const committer = parseIdent(commit.committer);
  return {
    sha: oid,
    node_id: globalId('Commit', oid),
    commit: {
      message: commit.message,
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((sha) => ({ sha })),
    author: null,
    committer: null,
  };
}

// ---------------------------------------------------------------- the router

export async function handleRestRequest(
  ctx: RequestContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: Buffer,
): Promise<void> {
  const rawSegments = url.pathname.slice('/api/v3'.length).split('/').filter((segment) => segment !== '');
  const segments: string[] = [];
  for (const segment of rawSegments) {
    const decoded = decodeSegment(segment);
    if (decoded === null) {
      sendError(res, 400, 'bad path encoding');
      return;
    }
    segments.push(decoded);
  }
  const method = req.method ?? 'GET';

  // The API root and the meta/user views.
  if (segments.length === 0) {
    if (method !== 'GET') return sendError(res, 404, 'not found');
    const origin = ctx.originOf(req);
    sendJson(
      res,
      200,
      {
        current_user_url: `${origin}/api/v3/user`,
        repository_url: `${origin}/api/v3/repos/{owner}/{repo}`,
        user_repos_url: `${origin}/api/v3/user/repos`,
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
    return;
  }
  if (segments.length === 1 && segments[0] === 'meta') {
    if (method !== 'GET') return sendError(res, 404, 'not found');
    sendJson(res, 200, {
      verifiable_password_authentication: true,
      ssh_key_fingerprints: {},
      ssh_keys: [],
      hooks: [],
      web: [],
      api: [],
      built_by: 'forge',
      installed_version: '1.0.0',
    });
    return;
  }
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') return sendError(res, 404, 'not found');
    sendJson(res, 200, { ...userObject(), name: VIEWER_LOGIN, email: null, type: 'User', site_admin: false });
    return;
  }
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      sendPage(ctx, req, res, url, ctx.store.reposOf(VIEWER_LOGIN).map((repo) => repoObject(ctx, req, repo)));
      return;
    }
    if (method === 'POST') {
      const parsed = parseBody(body);
      if (!parsed.ok) return sendError(res, 400, 'malformed JSON body');
      const name = parsed.value.name;
      if (typeof name !== 'string' || name === '' || /[/\s]/.test(name)) {
        return sendError(res, 422, 'name is required');
      }
      if (ctx.store.getRepo(VIEWER_LOGIN, name) !== undefined) {
        return sendError(res, 422, 'name already exists on this account');
      }
      const repo = ctx.store.createRepo(
        VIEWER_LOGIN,
        name,
        parsed.value.private === true,
        typeof parsed.value.description === 'string' ? parsed.value.description : '',
      );
      sendJson(res, 201, repoObject(ctx, req, repo));
      return;
    }
    return sendError(res, 404, 'not found');
  }

  // Everything below is repository-scoped.
  if (segments[0] !== 'repos' || segments.length < 3) return sendError(res, 404, 'not found');
  const owner = segments[1]!;
  const repoName = segments[2]!;
  const repo = ctx.store.getRepo(owner, repoName);
  if (repo === undefined) return sendError(res, 404, 'repository not found');
  const rest = segments.slice(3);

  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoObject(ctx, req, repo));
      return;
    }
    if (method === 'PATCH') {
      const parsed = parseBody(body);
      if (!parsed.ok) return sendError(res, 400, 'malformed JSON body');
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      if (typeof parsed.value.private === 'boolean') repo.isPrivate = parsed.value.private;
      sendJson(res, 200, repoObject(ctx, req, repo));
      return;
    }
    if (method === 'DELETE') {
      ctx.store.deleteRepo(owner, repoName);
      res.writeHead(204);
      res.end();
      return;
    }
    return sendError(res, 404, 'not found');
  }

  const head = rest[0]!;
  if (head === 'branches') return handleBranches(ctx, req, res, repo, rest.slice(1), method);
  if (head === 'commits') return handleCommits(ctx, req, res, url, repo, method);
  if (head === 'git') return handleGitData(ctx, req, res, repo, rest.slice(1), method, body);
  if (head === 'contents') return handleContents(ctx, req, res, url, repo, rest.slice(1), method, body);
  if (head === 'labels') return handleLabels(ctx, req, res, repo, method, body);
  if (head === 'issues') return handleIssues(ctx, req, res, url, repo, rest.slice(1), method, body);
  if (head === 'pulls') return handlePulls(ctx, req, res, url, repo, rest.slice(1), method, body);
  return sendError(res, 404, 'not found');
}

// ---------------------------------------------------------------- branches & commits

function handleBranches(
  _ctx: RequestContext,
  _req: IncomingMessage,
  res: ServerResponse,
  repo: RepoState,
  rest: readonly string[],
  method: string,
): void {
  if (method !== 'GET') return sendError(res, 404, 'not found');
  if (rest.length === 0) {
    const branches: Array<Record<string, unknown>> = [];
    for (const [name, oid] of repo.sortedRefs()) {
      if (!name.startsWith('refs/heads/')) continue;
      branches.push({ name: name.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
    }
    branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    sendJson(res, 200, branches);
    return;
  }
  const branch = rest.join('/');
  const tip = repo.branchTip(branch);
  if (tip === null) return sendError(res, 404, 'branch not found');
  sendJson(res, 200, { name: branch, commit: { sha: tip }, protected: false });
}

function handleCommits(
  _ctx: RequestContext,
  _req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: RepoState,
  method: string,
): void {
  if (method !== 'GET') return sendError(res, 404, 'not found');
  const ref = url.searchParams.get('sha') ?? repo.defaultBranch;
  const tip = repo.resolveToCommit(ref);
  if (tip === null) {
    // An unborn branch reads as an empty history; an unknown ref is a 404.
    const known = ref === repo.defaultBranch || repo.branchTip(ref) !== null || repo.refs.has(`refs/tags/${ref}`);
    if (known) return sendJson(res, 200, []);
    return sendError(res, 404, 'ref not found');
  }
  const out: Array<Record<string, unknown>> = [];
  for (const oid of repo.walkCommits(tip)) {
    const object = commitObject(repo, oid);
    if (object !== null) out.push(object);
  }
  sendJson(res, 200, out);
}

// ---------------------------------------------------------------- git data (refs)

function handleGitData(
  _ctx: RequestContext,
  _req: IncomingMessage,
  res: ServerResponse,
  repo: RepoState,
  rest: readonly string[],
  method: string,
  body: Buffer,
): void {
  if (rest.length === 1 && rest[0] === 'refs') {
    if (method === 'GET') {
      sendJson(
        res,
        200,
        repo.sortedRefs().map(([ref, oid]) => ({
          ref,
          node_id: globalId('Ref', ref),
          url: '',
          object: { sha: oid, type: repo.getObject(oid)?.type ?? 'commit', url: '' },
        })),
      );
      return;
    }
    if (method === 'POST') {
      const parsed = parseBody(body);
      if (!parsed.ok) return sendError(res, 400, 'malformed JSON body');
      const ref = parsed.value.ref;
      const sha = parsed.value.sha;
      if (typeof ref !== 'string' || !ref.startsWith('refs/') || typeof sha !== 'string' || repo.getObject(sha) === undefined) {
        return sendError(res, 422, 'ref and sha are required and the sha must exist');
      }
      if (repo.refs.has(ref)) return sendError(res, 422, 'reference already exists');
      repo.refs.set(ref, sha);
      sendJson(res, 201, {
        ref,
        node_id: globalId('Ref', ref),
        url: '',
        object: { sha, type: repo.getObject(sha)?.type ?? 'commit', url: '' },
      });
      return;
    }
    return sendError(res, 404, 'not found');
  }
  if (rest.length >= 2 && rest[0] === 'refs') {
    if (method !== 'GET') return sendError(res, 404, 'not found');
    const ref = `refs/${rest.slice(1).join('/')}`;
    const oid = repo.refs.get(ref);
    if (oid === undefined) return sendError(res, 404, 'ref not found');
    sendJson(res, 200, {
      ref,
      node_id: globalId('Ref', ref),
      url: '',
      object: { sha: oid, type: repo.getObject(oid)?.type ?? 'commit', url: '' },
    });
    return;
  }
  return sendError(res, 404, 'not found');
}

// ---------------------------------------------------------------- contents

function contentsFileObject(
  ctx: RequestContext,
  req: IncomingMessage,
  repo: RepoState,
  path: string,
  blobOid: string,
): Record<string, unknown> | null {
  const object = repo.getObject(blobOid);
  if (object === undefined || object.type !== 'blob') return null;
  const origin = ctx.originOf(req);
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size: object.data.length,
    name,
    path,
    sha: blobOid,
    content: object.data.toString('base64'),
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
  };
}

function handleContents(
  ctx: RequestContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: RepoState,
  rest: readonly string[],
  method: string,
  body: Buffer,
): void {
  const path = rest.join('/');
  if (method === 'GET') {
    const ref = url.searchParams.get('ref') ?? repo.defaultBranch;
    const tip = repo.resolveToCommit(ref);
    if (tip === null) return sendError(res, 404, 'ref not found');
    const commit = repo.parseCommit(tip);
    if (commit === null) return sendError(res, 404, 'ref not found');
    if (path === '') {
      // The repository root.
      const entries = repo.parseTree(commit.tree) ?? [];
      sendJson(res, 200, entries.map((entry) => dirEntryObject(ctx, req, repo, '', entry)));
      return;
    }
    const found = repo.lookupPath(commit.tree, path.split('/'));
    if (found === null) return sendError(res, 404, 'path not found');
    if (found.kind === 'file') {
      const object = contentsFileObject(ctx, req, repo, path, found.oid);
      if (object === null) return sendError(res, 404, 'path not found');
      sendJson(res, 200, object);
      return;
    }
    const entries = repo.parseTree(found.oid) ?? [];
    sendJson(res, 200, entries.map((entry) => dirEntryObject(ctx, req, repo, path, entry)));
    return;
  }

  if (method === 'PUT') {
    const parsed = parseBody(body);
    if (!parsed.ok) return sendError(res, 400, 'malformed JSON body');
    const message = parsed.value.message;
    const content = parsed.value.content;
    if (typeof message !== 'string' || message === '') return sendError(res, 422, 'message is required');
    if (typeof content !== 'string') return sendError(res, 422, 'content is required');
    if (path === '') return sendError(res, 422, 'a file path is required');
    const branch = typeof parsed.value.branch === 'string' && parsed.value.branch !== '' ? parsed.value.branch : repo.defaultBranch;
    const sha = typeof parsed.value.sha === 'string' ? parsed.value.sha : undefined;
    const bytes = Buffer.from(content, 'base64');
    // A branch that does not exist yet forks from the default branch's tip.
    let tip = repo.branchTip(branch);
    if (tip === null && branch !== repo.defaultBranch) {
      tip = repo.branchTip(repo.defaultBranch);
    }
    let currentOid: string | null = null;
    let isDir = false;
    if (tip !== null) {
      const commit = repo.parseCommit(tip);
      if (commit !== null) {
        const found = repo.lookupPath(commit.tree, path.split('/'));
        if (found !== null && found.kind === 'file') currentOid = found.oid;
        if (found !== null && found.kind === 'dir') isDir = true;
      }
    }
    if (isDir) return sendError(res, 422, 'the path is a directory');
    if (currentOid !== null) {
      if (sha === undefined) return sendError(res, 422, 'sha is required to update a file');
      if (sha !== currentOid) return sendError(res, 409, 'the file changed since the given sha');
    } else if (sha !== undefined) {
      return sendError(res, 422, 'sha must be omitted when creating a file');
    }
    const blobOid = repo.putObject('blob', bytes);
    const parentTree = tip === null ? null : (repo.parseCommit(tip)?.tree ?? null);
    const tree = repo.updateTree(parentTree, path.split('/'), blobOid);
    const parents = tip === null ? [] : [tip];
    const commitSha = repo.createCommit(tree, parents, message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    const object = contentsFileObject(ctx, req, repo, path, blobOid);
    sendJson(res, currentOid !== null ? 200 : 201, {
      content: object,
      commit: { sha: commitSha, message, author: { name: 'Forge' }, committer: { name: 'Forge' } },
    });
    return;
  }

  if (method === 'DELETE') {
    const parsed = parseBody(body);
    if (!parsed.ok) return sendError(res, 400, 'malformed JSON body');
    const message = parsed.value.message;
    const sha = parsed.value.sha;
    if (typeof message !== 'string' || message === '') return sendError(res, 422, 'message is required');
    if (typeof sha !== 'string') return sendError(res, 422, 'sha is required');
    if (path === '') return sendError(res, 422, 'a file path is required');
    const branch = typeof parsed.value.branch === 'string' && parsed.value.branch !== '' ? parsed.value.branch : repo.defaultBranch;
    const tip = repo.branchTip(branch);
    if (tip === null) return sendError(res, 404, 'branch not found');
    const commit = repo.parseCommit(tip);
    if (commit === null) return sendError(res, 404, 'branch not found');
    const found = repo.lookupPath(commit.tree, path.split('/'));
    if (found === null || found.kind !== 'file') return sendError(res, 404, 'path not found');
    if (found.oid !== sha) return sendError(res, 409, 'the file changed since the given sha');
    const tree = repo.updateTree(commit.tree, path.split('/'), null);
    const commitSha = repo.createCommit(tree, [tip], message);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    sendJson(res, 200, { commit: { sha: commitSha, message }, content: null });
    return;
  }

  return sendError(res, 404, 'not found');
}

function dirEntryObject(
  ctx: RequestContext,
  req: IncomingMessage,
  repo: RepoState,
  dir: string,
  entry: { mode: string; name: string; oid: string },
): Record<string, unknown> {
  const origin = ctx.originOf(req);
  const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
  const isDir = entry.mode === '40000';
  const object = repo.getObject(entry.oid);
  return {
    type: isDir ? 'dir' : 'file',
    size: !isDir && object?.type === 'blob' ? object.data.length : 0,
    name: entry.name,
    path,
    sha: entry.oid,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `${origin}/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${path}`,
  };
}

// ---------------------------------------------------------------- labels

function handleLabels(
  _ctx: RequestContext,
  _req: IncomingMessage,
  res: ServerResponse,
  repo: RepoState,
  method: string,
  body: Buffer,
): void {
  if (method === 'GET') {
    sendJson(res, 200, [...repo.labels.values()].map((label) => labelObject(label.name, label.color)));
    return;
  }
  if (method === 'POST') {
    const parsed = parseBody(body);
    if (!parsed.ok) return sendError(res, 400, 'malformed JSON body');
    const name = parsed.value.name;
    if (typeof name !== 'string' || name === '') return sendError(res, 422, 'name is required');
    const color = typeof parsed.value.color === 'string' && parsed.value.color !== '' ? parsed.value.color : 'ededed';
    const existing = repo.labels.get(name);
    if (existing !== undefined) {
      sendJson(res, 201, labelObject(existing.name, existing.color));
      return;
    }
    repo.labels.set(name, { name, color });
    sendJson(res, 201, labelObject(name, color));
    return;
  }
  return sendError(res, 404, 'not found');
}

// ---------------------------------------------------------------- issues

function resolveIssueOrPull(repo: RepoState, number: number): { kind: 'issue'; record: IssueRecord } | { kind: 'pull'; record: PullRecord } | null {
  const issue = repo.issues.get(number);
  if (issue !== undefined) return { kind: 'issue', record: issue };
  const pull = repo.pulls.get(number);
  if (pull !== undefined) return { kind: 'pull', record: pull };
  return null;
}

function handleIssues(
  ctx: RequestContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: RepoState,
  rest: readonly string[],
  method: string,
  body: Buffer,
): void {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const direction = url.searchParams.get('direction') ?? 'asc';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (direction === 'desc' ? b.number - a.number : a.number - b.number));
      sendPage(ctx, req, res, url, issues.map((issue) => issueObject(ctx, req, repo, issue)));
      return;
    }
    if (method === 'POST') {
      const parsed = parseBody(body);
      if (!parsed.ok) return sendError(res, 400, 'malformed JSON body');
      const title = parsed.value.title;
      if (typeof title !== 'string' || title === '') return sendError(res, 422, 'title is required');
      const labelNames: string[] = [];
      if (Array.isArray(parsed.value.labels)) {
        for (const entry of parsed.value.labels) {
          if (typeof entry === 'string') labelNames.push(entry);
          else if (typeof entry === 'object' && entry !== null && typeof (entry as JsonObject).name === 'string') {
            labelNames.push((entry as JsonObject).name as string);
          }
        }
      }
      const created = createIssue(ctx.store, repo, title, typeof parsed.value.body === 'string' ? parsed.value.body : '', labelNames);
      if ('error' in created) return sendError(res, 422, created.error);
      sendJson(res, 201, issueObject(ctx, req, repo, created.issue));
      return;
    }
    return sendError(res, 404, 'not found');
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return sendError(res, 404, 'not found');
  const found = resolveIssueOrPull(repo, number);

  if (rest.length === 1) {
    if (found === null) return sendError(res, 404, 'issue not found');
    if (method === 'GET') {
      sendJson(res, 200, found.kind === 'issue' ? issueObject(ctx, req, repo, found.record) : pullAsIssueObject(ctx, req, repo, found.record));
      return;
    }
    if (method === 'PATCH') {
      const parsed = parseBody(body);
      if (!parsed.ok) return sendError(res, 400, 'malformed JSON body');
      if (parsed.value.state === 'open' || parsed.value.state === 'closed') found.record.state = parsed.value.state;
      if (typeof parsed.value.title === 'string') found.record.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') found.record.body = parsed.value.body;
      sendJson(res, 200, found.kind === 'issue' ? issueObject(ctx, req, repo, found.record) : pullAsIssueObject(ctx, req, repo, found.record));
      return;
    }
    return sendError(res, 404, 'not found');
  }

  if (rest.length === 2 && rest[1] === 'comments') {
    if (found === null) return sendError(res, 404, 'issue not found');
    if (method === 'GET') {
      sendJson(res, 200, found.record.comments.map((comment) => commentObject(comment)));
      return;
    }
    if (method === 'POST') {
      const parsed = parseBody(body);
      if (!parsed.ok) return sendError(res, 400, 'malformed JSON body');
      if (typeof parsed.value.body !== 'string' || parsed.value.body === '') return sendError(res, 422, 'body is required');
      const comment = addComment(ctx.store, found.record, parsed.value.body);
      sendJson(res, 201, commentObject(comment));
      return;
    }
    return sendError(res, 404, 'not found');
  }

  return sendError(res, 404, 'not found');
}

// ---------------------------------------------------------------- pull requests

function handlePulls(
  ctx: RequestContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  repo: RepoState,
  rest: readonly string[],
  method: string,
  body: Buffer,
): void {
  if (rest.length === 0) {
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => a.number - b.number);
      sendPage(ctx, req, res, url, pulls.map((pull) => pullObject(ctx, req, repo, pull)));
      return;
    }
    if (method === 'POST') {
      const parsed = parseBody(body);
      if (!parsed.ok) return sendError(res, 400, 'malformed JSON body');
      const title = parsed.value.title;
      const head = parsed.value.head;
      const base = parsed.value.base;
      if (typeof title !== 'string' || title === '') return sendError(res, 422, 'title is required');
      if (typeof head !== 'string' || head === '' || typeof base !== 'string' || base === '') {
        return sendError(res, 422, 'head and base are required');
      }
      const created = createPull(ctx.store, repo, head, base, title, typeof parsed.value.body === 'string' ? parsed.value.body : '');
      if ('error' in created) return sendError(res, 422, created.error);
      sendJson(res, 201, pullObject(ctx, req, repo, created.pull));
      return;
    }
    return sendError(res, 404, 'not found');
  }

  const number = Number(rest[0]);
  if (!Number.isInteger(number) || number < 1) return sendError(res, 404, 'not found');
  const pull = repo.pulls.get(number);

  if (rest.length === 1) {
    if (pull === undefined) return sendError(res, 404, 'pull request not found');
    if (method === 'GET') {
      sendJson(res, 200, pullObject(ctx, req, repo, pull));
      return;
    }
    return sendError(res, 404, 'not found');
  }

  if (rest.length === 2 && rest[1] === 'files') {
    if (pull === undefined) return sendError(res, 404, 'pull request not found');
    if (method !== 'GET') return sendError(res, 404, 'not found');
    const context = mergeContext(repo, pull);
    const headFiles = context === null ? new Map() : repo.flattenTree(context.headTree);
    sendJson(
      res,
      200,
      pullRequestFiles(repo, pull).map((change) => ({
        sha: headFiles.get(change.path)?.oid ?? '',
        filename: change.path,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.additions + change.deletions,
      })),
    );
    return;
  }

  if (rest.length === 2 && rest[1] === 'merge') {
    if (pull === undefined) return sendError(res, 404, 'pull request not found');
    if (method !== 'PUT') return sendError(res, 404, 'not found');
    const parsed = parseBody(body);
    if (!parsed.ok) return sendError(res, 400, 'malformed JSON body');
    const outcome = squashMerge(repo, pull);
    if (!outcome.ok) {
      if (outcome.reason === 'conflict') return sendError(res, 405, 'merge conflict');
      if (outcome.reason === 'already-merged') return sendError(res, 405, 'pull request is already merged');
      return sendError(res, 405, 'a branch of the pull request no longer exists');
    }
    sendJson(res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }

  return sendError(res, 404, 'not found');
}
