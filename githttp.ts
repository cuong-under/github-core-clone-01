// githttp.ts — git smart HTTP: the v2 upload-pack advertisement, ls-refs and fetch,
// the v0 upload-pack advertisement and fetch, and the v0 receive-pack (push) with
// report-status over the sideband. The wire shapes follow the protocol the suite's
// client speaks; see gitobj.ts for the pkt-line and pack codecs.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  PKT_FLUSH,
  ZERO_OID,
  buildPack,
  decodePktAll,
  decodePktUntilFlush,
  encodePktLines,
  isOid,
  parseTag,
  readPack,
  sidebandWrap,
  type PackObject,
} from './gitobj.ts';
import type { RequestContext } from './app.ts';
import { sendError } from './app.ts';
import type { RepoState } from './store.ts';
import { DEFAULT_BRANCH } from './store.ts';

const UPLOAD_V0_CAPS = `symref=HEAD:refs/heads/${DEFAULT_BRANCH} side-band-64k shallow`;
const RECEIVE_V0_CAPS = `report-status side-band-64k delete-refs symref=HEAD:refs/heads/${DEFAULT_BRANCH}`;

const NO_CACHE = {
  expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
  pragma: 'no-cache',
  'cache-control': 'no-cache, max-age=0, must-revalidate',
};

function sendGit(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    ...NO_CACHE,
  });
  res.end(body);
}

export async function handleGitRequest(
  ctx: RequestContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: Buffer,
  owner: string,
  repoName: string,
  rest: string,
): Promise<void> {
  const repo = ctx.store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendError(res, 404, 'repository not found');
    return;
  }
  if (rest === '/info/refs' && req.method === 'GET') {
    handleInfoRefs(req, res, url, repo);
    return;
  }
  if (rest === '/git-upload-pack' && req.method === 'POST') {
    handleUploadPack(req, res, body, repo);
    return;
  }
  if (rest === '/git-receive-pack' && req.method === 'POST') {
    handleReceivePack(res, body, repo);
    return;
  }
  sendError(res, 404, 'not found');
}

// ---------------------------------------------------------------- advertisements

function v0Advertisement(repo: RepoState, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const lines: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const refs = repo.sortedRefs();
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headOid = repo.branchTip(DEFAULT_BRANCH) ?? ZERO_OID;
    lines.push(`${headOid} HEAD\0${caps}\n`);
    for (const [name, oid] of refs) {
      lines.push(`${oid} ${name}\n`);
      const object = repo.getObject(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = repo.peelTag(oid);
        if (peeled !== oid) lines.push(`${peeled} ${name}^{}\n`);
      }
    }
  }
  // The ref list ends with a flush packet: the reader treats EOF without one
  // as a hangup.
  lines.push('flush');
  return encodePktLines(lines);
}

function v2Advertisement(): Buffer {
  return encodePktLines(['version 2\n', 'fetch=shallow\n', 'ls-refs=unborn\n', 'object-format=sha1\n', 'flush']);
}

function handleInfoRefs(req: IncomingMessage, res: ServerResponse, url: URL, repo: RepoState): void {
  const service = url.searchParams.get('service');
  if (service === 'git-upload-pack') {
    if (req.headers['git-protocol'] === 'version=2') {
      sendGit(res, 200, 'application/x-git-upload-pack-advertisement', v2Advertisement());
    } else {
      sendGit(res, 200, 'application/x-git-upload-pack-advertisement', v0Advertisement(repo, service));
    }
    return;
  }
  if (service === 'git-receive-pack') {
    sendGit(res, 200, 'application/x-git-receive-pack-advertisement', v0Advertisement(repo, service));
    return;
  }
  sendError(res, 400, 'unknown service');
}

// ---------------------------------------------------------------- upload-pack v2

interface V2Request {
  command: string;
  args: string[];
}

/** Split a v2 request body into its command and its post-delim argument lines. */
function parseV2Request(body: Buffer): V2Request {
  const packets = decodePktAll(body);
  let command = '';
  let seenDelim = false;
  const args: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8');
    if (command === '') {
      // Real git sends `command=fetch` with no trailing newline; the suite's
      // client sends one. Accept both.
      const match = /^command=([a-z-]+)\n?$/.exec(line);
      if (match === null) throw new Error('v2 request has no command line');
      command = match[1]!;
      continue;
    }
    if (seenDelim) args.push(line);
    // Pre-delim lines (agent=, object-format=) are acknowledged and ignored.
  }
  if (command === '') throw new Error('v2 request is empty');
  return { command, args };
}

function handleLsRefs(repo: RepoState, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of args) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Array<string | 'flush'> = [];
  const mainTip = repo.branchTip(DEFAULT_BRANCH);
  if (keep('HEAD')) {
    if (mainTip !== null) {
      lines.push(`${mainTip} HEAD${symrefs ? ` symref-target:refs/heads/${DEFAULT_BRANCH}` : ''}\n`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${DEFAULT_BRANCH}` : ''}\n`);
    }
  }
  for (const [name, oid] of repo.sortedRefs()) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const object = repo.getObject(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = repo.peelTag(oid);
        if (peeled !== oid) line += ` peeled:${peeled}`;
      }
    }
    lines.push(`${line}\n`);
  }
  lines.push('flush');
  return encodePktLines(lines);
}

// ---------------------------------------------------------------- fetch selection

interface FetchSelection {
  wants: string[];
  haves: string[];
  shallowBoundaries: string[];
  depth: number | null;
}

function parseFetchArgs(args: readonly string[]): FetchSelection {
  const selection: FetchSelection = { wants: [], haves: [], shallowBoundaries: [], depth: null };
  for (const raw of args) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) selection.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) selection.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) selection.shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const depth = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(depth) && depth > 0) selection.depth = depth;
    }
    // thin-pack, no-progress, ofs-delta, filter, deepen-since, deepen-not, done: accepted, ignored.
  }
  return selection;
}

/**
 * Walk objects from `roots`, following commit parents only when `followParents`
 * allows, and following tree entries and tag targets always.
 */
function collectObjects(repo: RepoState, roots: readonly string[], followParents: (commitOid: string) => boolean): Set<string> {
  const out = new Set<string>();
  const stack: string[] = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const object = repo.getObject(oid);
    if (object === undefined) continue;
    out.add(oid);
    if (object.type === 'commit') {
      const commit = repo.parseCommit(oid);
      if (commit === null) continue;
      stack.push(commit.tree);
      if (followParents(oid)) for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of repo.parseTree(oid) ?? []) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return out;
}

interface FetchPlan {
  packObjects: PackObject[];
  shallow: string[];
  unshallow: string[];
}

/**
 * Decide exactly which objects a fetch sends: the depth-limited closure of the wants,
 * minus the closure of the haves (whose traversal stops at the client's shallow
 * boundaries), with shallow/unshallow boundary lines for the shallow-info section.
 */
function planFetch(repo: RepoState, selection: FetchSelection): FetchPlan {
  const shallowSet = new Set(selection.shallowBoundaries);
  // The commits the depth limit admits, by breadth-first distance from the wants.
  const included = new Set<string>();
  const queue: Array<[string, number]> = [];
  for (const want of selection.wants) {
    const object = repo.getObject(want);
    if (object === undefined) continue;
    if (object.type === 'commit') queue.push([want, 0]);
    else if (object.type === 'tag') {
      const target = repo.peelTag(want);
      if (repo.getObject(target)?.type === 'commit') queue.push([target, 0]);
    }
  }
  const seenDistance = new Map<string, number>();
  while (queue.length > 0) {
    const [oid, distance] = queue.shift()!;
    if (seenDistance.has(oid)) continue;
    if (selection.depth !== null && distance >= selection.depth) continue;
    seenDistance.set(oid, distance);
    included.add(oid);
    const commit = repo.parseCommit(oid);
    if (commit === null) continue;
    for (const parent of commit.parents) queue.push([parent, distance + 1]);
  }
  // Boundary lines.
  const shallow: string[] = [];
  for (const oid of included) {
    const commit = repo.parseCommit(oid);
    if (commit !== null && commit.parents.some((parent) => !included.has(parent))) shallow.push(oid);
  }
  shallow.sort();
  const unshallow: string[] = [];
  for (const oid of shallowSet) {
    if (!included.has(oid)) continue;
    const commit = repo.parseCommit(oid);
    if (commit !== null && commit.parents.every((parent) => included.has(parent))) unshallow.push(oid);
  }
  unshallow.sort();
  // The objects to send: the wants' closure minus the haves' closure. The closure
  // walk follows a commit's parents only into admitted commits, so the depth limit
  // bounds exactly what the pack carries.
  const admitted = new Set<string>();
  {
    const stack: string[] = [...selection.wants];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.getObject(oid);
      if (object === undefined) continue;
      admitted.add(oid);
      if (object.type === 'commit') {
        const commit = repo.parseCommit(oid);
        if (commit === null) continue;
        stack.push(commit.tree);
        if (included.has(oid)) for (const parent of commit.parents) if (included.has(parent)) stack.push(parent);
      } else if (object.type === 'tree') {
        for (const entry of repo.parseTree(oid) ?? []) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
  }
  const excluded = collectObjects(repo, selection.haves, (oid) => !shallowSet.has(oid));
  const packObjects: PackObject[] = [];
  for (const oid of admitted) {
    if (excluded.has(oid)) continue;
    const object = repo.getObject(oid);
    if (object !== undefined) packObjects.push({ oid, type: object.type, data: object.data });
  }
  return { packObjects, shallow, unshallow };
}

function fetchResponseV2(repo: RepoState, selection: FetchSelection): Buffer {
  const plan = planFetch(repo, selection);
  const pack = buildPack(plan.packObjects, repo.deflated);
  const parts: Buffer[] = [];
  // The acknowledgments section exists only when the client negotiated (sent
  // have lines): a client with nothing to negotiate expects the packfile
  // section next and rejects an acknowledgments section outright.
  if (selection.haves.length > 0) {
    parts.push(encodePktLines(['acknowledgments\n', 'NAK\n', 'flush']));
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const lines: Array<string | 'flush'> = ['shallow-info\n'];
    for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('flush');
    parts.push(encodePktLines(lines));
  }
  parts.push(encodePktLines(['packfile\n']));
  parts.push(sidebandWrap(1, pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- upload-pack v0

function fetchResponseV0(repo: RepoState, selection: FetchSelection): Buffer {
  const plan = planFetch(repo, selection);
  const pack = buildPack(plan.packObjects, repo.deflated);
  const lines: Array<string | 'flush'> = ['NAK\n'];
  for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
  for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
  return Buffer.concat([encodePktLines(lines), sidebandWrap(1, pack), PKT_FLUSH]);
}

function parseV0FetchRequest(body: Buffer): FetchSelection {
  const packets = decodePktAll(body);
  const selection: FetchSelection = { wants: [], haves: [], shallowBoundaries: [], depth: null };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul); // capabilities ride the first want line
    if (line.startsWith('want ')) selection.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) selection.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) selection.shallowBoundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const depth = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(depth) && depth > 0) selection.depth = depth;
    }
    // 'done' and anything else: ignored.
  }
  return selection;
}

function handleUploadPack(req: IncomingMessage, res: ServerResponse, body: Buffer, repo: RepoState): void {
  try {
    if (req.headers['git-protocol'] === 'version=2') {
      const request = parseV2Request(body);
      if (request.command === 'ls-refs') {
        sendGit(res, 200, 'application/x-git-upload-pack-result', handleLsRefs(repo, request.args));
        return;
      }
      if (request.command === 'fetch') {
        const selection = parseFetchArgs(request.args);
        sendGit(res, 200, 'application/x-git-upload-pack-result', fetchResponseV2(repo, selection));
        return;
      }
      sendError(res, 400, `unknown v2 command ${request.command}`);
      return;
    }
    const selection = parseV0FetchRequest(body);
    sendGit(res, 200, 'application/x-git-upload-pack-result', fetchResponseV0(repo, selection));
  } catch (error) {
    // A malformed upload-pack request must not take the server down; the suite's
    // error-survival check posts garbage and then expects the repository to work.
    console.error(`upload-pack error: ${error instanceof Error ? error.message : String(error)}`);
    sendError(res, 400, 'malformed git request');
  }
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function applyPushCommand(repo: RepoState, command: PushCommand, unpackOk: boolean): string {
  const ref = command.ref;
  if (!unpackOk) return `ng ${ref} unpacker error\n`;
  const current = repo.refs.get(ref);
  if (command.newOid === ZERO_OID) {
    // A delete.
    if (current === undefined) return `ng ${ref} remote ref does not exist\n`;
    if (command.oldOid !== ZERO_OID && command.oldOid !== current) return `ng ${ref} old oid mismatch\n`;
    repo.refs.delete(ref);
    return `ok ${ref}\n`;
  }
  if (repo.getObject(command.newOid) === undefined) return `ng ${ref} object not found\n`;
  if (command.oldOid === ZERO_OID) {
    // A create.
    if (current !== undefined) return `ng ${ref} remote ref already exists\n`;
    repo.refs.set(ref, command.newOid);
    return `ok ${ref}\n`;
  }
  if (current === undefined) return `ng ${ref} remote ref does not exist\n`;
  if (command.oldOid !== current) return `ng ${ref} old oid mismatch\n`;
  if (command.oldOid === command.newOid) return `ok ${ref}\n`;
  if (ref.startsWith('refs/heads/') && !repo.isAncestor(command.oldOid, command.newOid)) {
    return `ng ${ref} non-fast-forward\n`;
  }
  repo.refs.set(ref, command.newOid);
  return `ok ${ref}\n`;
}

function pushReport(lines: string[]): Buffer {
  // The report-status stream inside band 1 ends with its own flush packet (the
  // reader waits for it), and the outer sideband stream ends with a bare flush.
  const inner = Buffer.concat([encodePktLines(lines), PKT_FLUSH]);
  return Buffer.concat([sidebandWrap(1, inner), PKT_FLUSH]);
}

function handleReceivePack(res: ServerResponse, body: Buffer, repo: RepoState): void {
  try {
    const { packets, restOffset } = decodePktUntilFlush(body);
    const packBytes = body.subarray(restOffset);
    const commands: PushCommand[] = [];
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      if (nul >= 0) line = line.slice(0, nul); // capabilities ride the first command
      const parts = line.split(' ');
      if (parts.length !== 3 || !isOid(parts[0]!) || !isOid(parts[1]!) || !parts[2]!.startsWith('refs/')) {
        throw new Error(`malformed push command ${JSON.stringify(line.slice(0, 60))}`);
      }
      commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
    }
    const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
    let unpackOk = true;
    if (packBytes.length > 0) {
      try {
        const read = readPack(packBytes, (oid) => repo.getObject(oid));
        repo.putObjects(read.objects);
      } catch {
        unpackOk = false;
      }
    } else if (updatesRef) {
      unpackOk = false; // an update with no pack at all is an unpacker error, as in git
    }
    const lines = [`unpack ${unpackOk ? 'ok' : 'unpacker error'}\n`];
    for (const command of commands) lines.push(applyPushCommand(repo, command, unpackOk));
    sendGit(res, 200, 'application/x-git-receive-pack-result', pushReport(lines));
  } catch (error) {
    // Garbage in the command list (the error-survival check's `zzzznot-a-pkt-line`)
    // answers an unpack error and leaves the server and the repository untouched.
    console.error(`receive-pack error: ${error instanceof Error ? error.message : String(error)}`);
    sendGit(res, 200, 'application/x-git-receive-pack-result', pushReport(['unpack unpacker error\n']));
  }
}
