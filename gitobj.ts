// gitobj.ts — the git object model: hashing, commit/tree/tag codecs, pack files
// (read with full delta resolution, write with full objects only), and the pkt-line
// framing of the smart HTTP protocols. Standard library only; no git binary.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** The git object id: SHA-1 over `<type> <size>\0` + bytes. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

// ---------------------------------------------------------------- commits

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit's bytes. Unknown headers are ignored; the message is kept byte-exact. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit's bytes from its fields. The message is written exactly as given. */
export function buildCommit(info: CommitInfo): Buffer {
  let head = `tree ${info.tree}\n`;
  for (const parent of info.parents) head += `parent ${parent}\n`;
  head += `author ${info.author}\ncommitter ${info.committer}\n`;
  return Buffer.concat([Buffer.from(`${head}\n`, 'utf8'), Buffer.from(info.message, 'utf8')]);
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function isDirEntry(entry: TreeEntry): boolean {
  return entry.mode === '40000';
}

/** Parse a tree's bytes into entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) throw new Error('malformed tree: no space after mode');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree: entry truncated');
    const mode = data.subarray(pos, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries ordered by name, directories compared with a trailing slash. */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const aKey = isDirEntry(a) ? `${a.name}/` : a.name;
  const bKey = isDirEntry(b) ? `${b.name}/` : b.name;
  const aBuf = Buffer.from(aKey, 'utf8');
  const bBuf = Buffer.from(bKey, 'utf8');
  return Buffer.compare(aBuf, bBuf);
}

/** Build a tree's bytes from entries, sorted git-style. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- tags

export interface TagInfo {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type: ObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) {
      const t = line.slice(5).trim();
      if (t === 'commit' || t === 'tree' || t === 'blob' || t === 'tag') type = t;
    } else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- pkt-lines

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** The largest packet the protocol allows, header included. */
export const PKT_LINE_MAX = 65520;

export type PacketKind = 'data' | 'flush' | 'delim' | 'end';

export interface DecodedPacket {
  kind: PacketKind;
  payload: Buffer;
}

/** Frame one payload as a pkt-line (payload must fit: length + 4 <= 65520). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > PKT_LINE_MAX) throw new Error(`pkt-line payload of ${body.length} bytes exceeds the limit`);
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

/** Encode lines: strings/Buffers become data packets, 'flush'/'delim'/'end' control packets. */
export function encodePktLines(lines: readonly Array<string | Buffer | 'flush' | 'delim' | 'end'>): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else if (line === 'end') parts.push(PKT_RESPONSE_END);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

function parsePktLength(buf: Buffer, offset: number): number {
  if (offset + 4 > buf.length) throw new Error('pkt-line truncated: short length prefix');
  const hex = buf.subarray(offset, offset + 4).toString('ascii');
  if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`pkt-line has a bad length prefix ${JSON.stringify(hex)}`);
  const length = parseInt(hex, 16);
  if (length !== 0 && length !== 1 && length !== 2 && (length < 4 || length > PKT_LINE_MAX)) {
    throw new Error(`pkt-line length ${length} is out of range`);
  }
  return length;
}

/**
 * Decode pkt-lines from `buf` starting at `start`, stopping after the first flush packet
 * (or at the end of the buffer). Returns the packets before the flush and the offset just
 * past it (or past the last packet): the caller reads raw trailing bytes (a pack) from there.
 */
export function decodePktUntilFlush(buf: Buffer, start = 0): { packets: DecodedPacket[]; restOffset: number } {
  const packets: DecodedPacket[] = [];
  let offset = start;
  while (offset < buf.length) {
    const length = parsePktLength(buf, offset);
    if (length === 0) return { packets, restOffset: offset + 4 };
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    const end = offset + length;
    if (end > buf.length) throw new Error('pkt-line truncated: payload runs past the buffer');
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, end) });
    offset = end;
  }
  return { packets, restOffset: offset };
}

/** Decode every pkt-line in `buf`. Throws on any malformed packet. */
export function decodePktAll(buf: Buffer): DecodedPacket[] {
  const packets: DecodedPacket[] = [];
  let offset = 0;
  while (offset < buf.length) {
    const length = parsePktLength(buf, offset);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      offset += 4;
    } else {
      const end = offset + length;
      if (end > buf.length) throw new Error('pkt-line truncated: payload runs past the buffer');
      packets.push({ kind: 'data', payload: buf.subarray(offset + 4, end) });
      offset = end;
    }
  }
  return packets;
}

// ---------------------------------------------------------------- packs: writing

export interface PackObject {
  oid: string;
  type: ObjectType;
  data: Buffer;
}

function encodePackEntryHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODES[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining >>>= 4;
  if (remaining > 0) first |= 0x80;
  bytes.push(first);
  while (remaining > 0) {
    let next = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

/**
 * Build a pack version 2 carrying full objects only (no deltas), entries sorted by oid,
 * trailer SHA-1 over everything before it. `deflateCache` (per repository) memoizes the
 * compressed bytes of each object so repeated clones do not re-deflate.
 */
export function buildPack(objects: readonly PackObject[], deflateCache?: Map<string, Buffer>): Buffer {
  const sorted = [...objects].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const object of sorted) {
    parts.push(encodePackEntryHeader(object.type, object.data.length));
    let deflated = deflateCache?.get(object.oid);
    if (deflated === undefined) {
      deflated = deflateSync(object.data);
      deflateCache?.set(object.oid, deflated);
    }
    parts.push(deflated);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- packs: reading

export interface StoredObject {
  type: ObjectType;
  data: Buffer;
}

export interface ReadPackResult {
  objects: Map<string, StoredObject>;
  deltaCount: number;
}

/**
 * Inflate one zlib stream starting at `offset`, whose uncompressed size is `expectedSize`,
 * and learn exactly how many bytes it consumed: inflateSync ignores trailing bytes, so the
 * consumed length is found by binary search for the shortest prefix that inflates to the
 * expected size (a truncated prefix throws or yields short output; the predicate is
 * monotone in the prefix length).
 */
function inflateExact(buf: Buffer, offset: number, expectedSize: number): { data: Buffer; consumed: number } {
  const remaining = buf.length - offset;
  if (remaining <= 0) throw new Error('pack entry has no zlib stream');
  let lo = 1;
  let hi = remaining;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    let ok = false;
    try {
      const out = inflateSync(buf.subarray(offset, offset + mid));
      ok = out.length === expectedSize;
    } catch {
      ok = false;
    }
    if (ok) {
      best = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (best < 0) throw new Error('pack entry zlib stream does not inflate to its declared size');
  return { data: inflateSync(buf.subarray(offset, offset + best)), consumed: best };
}

/** Apply a git delta to its base object, yielding the reconstructed object bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error('delta truncated in a varint');
      const byte = delta[pos++]!;
      result |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return result;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta source size does not match its base');
  const chunks: Buffer[] = [];
  let outLength = 0;
  while (pos < delta.length) {
    const opcode = delta[pos++]!;
    if ((opcode & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if ((opcode & 0x01) !== 0) offset = delta[pos++]!;
      if ((opcode & 0x02) !== 0) offset |= delta[pos++]! << 8;
      if ((opcode & 0x04) !== 0) offset |= delta[pos++]! << 16;
      if ((opcode & 0x08) !== 0) offset |= delta[pos++]! << 24;
      if ((opcode & 0x10) !== 0) size = delta[pos++]!;
      if ((opcode & 0x20) !== 0) size |= delta[pos++]! << 8;
      if ((opcode & 0x40) !== 0) size |= delta[pos++]! << 16;
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy runs past its base');
      chunks.push(base.subarray(offset, offset + size));
      outLength += size;
    } else if (opcode !== 0) {
      if (pos + opcode > delta.length) throw new Error('delta insert runs past the delta');
      chunks.push(delta.subarray(pos, pos + opcode));
      pos += opcode;
      outLength += opcode;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(chunks, outLength);
  if (result.length !== targetSize) throw new Error('delta result size does not match its header');
  return result;
}

/**
 * Parse a pack version 2, resolving OFS_DELTA and REF_DELTA entries (thin-pack bases come
 * from `resolveBase`). The trailer checksum is verified before any object is returned.
 * Object ids are always recomputed from type + bytes, never trusted from the pack.
 */
export function readPack(
  buf: Buffer,
  resolveBase?: (oid: string) => StoredObject | undefined,
): ReadPackResult {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack lacks its PACK signature');
  const version = buf.readUInt32BE(4);
  if (version !== 2) throw new Error(`pack version ${version} is not 2`);
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const actual = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!trailer.equals(actual)) throw new Error('pack trailer checksum mismatch');

  const objects = new Map<string, StoredObject>();
  const byOffset = new Map<number, StoredObject>();
  let deltaCount = 0;
  let pos = 12;
  const limit = buf.length - 20;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = pos;
    if (pos >= limit) throw new Error('pack truncated: entry header runs past the trailer');
    const first = buf[pos++]!;
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let byte = first;
    while ((byte & 0x80) !== 0) {
      if (pos >= limit) throw new Error('pack truncated: entry size varint runs past the trailer');
      byte = buf[pos++]!;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let base: StoredObject | undefined;
    let deltaBaseOid: string | null = null;
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset to the base entry, base-128 with the +1 twist.
      if (pos >= limit) throw new Error('pack truncated: ofs-delta offset missing');
      byte = buf[pos++]!;
      let offset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (pos >= limit) throw new Error('pack truncated: ofs-delta offset runs on');
        byte = buf[pos++]!;
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      const baseOffset = entryOffset - offset;
      base = byOffset.get(baseOffset);
      if (base === undefined) throw new Error('ofs-delta base is not an earlier pack entry');
      deltaCount += 1;
    } else if (typeCode === 7) {
      // REF_DELTA: the base object's id; it may already live in the store (a thin pack).
      if (pos + 20 > limit) throw new Error('pack truncated: ref-delta base id missing');
      deltaBaseOid = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      base = objects.get(deltaBaseOid) ?? resolveBase?.(deltaBaseOid);
      if (base === undefined) throw new Error('ref-delta base is neither in the pack nor in the store');
      deltaCount += 1;
    }
    const inflated = inflateExact(buf, pos, size);
    pos += inflated.consumed;
    let stored: StoredObject;
    if (base !== undefined) {
      stored = { type: base.type, data: applyDelta(base.data, inflated.data) };
    } else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) throw new Error(`pack entry has unknown type code ${typeCode}`);
      stored = { type, data: inflated.data };
    }
    const oid = hashObject(stored.type, stored.data);
    objects.set(oid, stored);
    byOffset.set(entryOffset, stored);
    void deltaBaseOid;
  }
  if (pos !== limit) throw new Error('pack has trailing bytes before its trailer');
  return { objects, deltaCount };
}

// ---------------------------------------------------------------- sideband

/** Wrap raw bytes (a pack, a report) in sideband band-1 packets, each within the size cap. */
export function sidebandWrap(band: 1 | 2, data: Buffer): Buffer {
  const maxPayload = PKT_LINE_MAX - 5; // 4 header bytes + 1 band byte
  const parts: Buffer[] = [];
  if (data.length === 0) {
    parts.push(pktLine(Buffer.from([band])));
    return Buffer.concat(parts);
  }
  let offset = 0;
  while (offset < data.length) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + maxPayload));
    parts.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
    offset += chunk.length;
  }
  return Buffer.concat(parts);
}
