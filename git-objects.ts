// Git object model + packfile codec, stdlib only (node:crypto, node:zlib).
// Object formats (byte-exact, as git defines them):
//   blob   "blob <len>\0<data>"
//   tree   entries "<mode> <name>\0<20-byte oid>" sorted by name (dirs sort as name+"/")
//   commit "tree <hex>\n" ["parent <hex>\n"...] "author <name> <email> <ts> <tz>\n"
//          "committer <name> <email> <ts> <tz>\n\n<message>"
//   tag    "object <hex>\ntype <type>\ntag <name>\ntagger <name> <email> <ts> <tz>\n\n<message>"
// Packfile: "PACK" + u32 version(2) + u32 count, then entries:
//   varint type+size header, zlib-deflated payload; type 6 = OFS_DELTA (negative offset varint
//   then delta), type 7 = REF_DELTA (20-byte base oid then delta); trailer = SHA-1 of all before.
// Delta: source-size varint, target-size varint, then ops: copy (0x80|offset/size bits + bytes)
//   or insert (length byte + bytes).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

/** SHA-1 of "<type> <len>\0<data>" — the object id. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** The exact bytes git hashes for an object (header + payload). */
export function looseBytes(type: GitObjectType, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'ascii'), data]);
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------------------------------------
// Trees

export interface TreeEntry {
  mode: string; // "100644", "100755", "40000", "120000", "160000"
  name: string;
  oid: string;
}

/** Parse a tree object's entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space === -1) throw new Error('malformed tree: no space after mode');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul === -1) throw new Error('malformed tree: no NUL after name');
    const name = data.subarray(space + 1, nul).toString('utf8');
    if (nul + 21 > data.length) throw new Error('malformed tree: truncated oid');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries sort by name, directories as if the name had a trailing "/". */
export function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

/** Encode tree entries (sorted git-style) into a tree object's bytes. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// Commits and tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TagView {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export interface BuildCommitFields {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}

/** Build a commit object's bytes (message used verbatim, no trailing newline added). */
export function buildCommit(fields: BuildCommitFields): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  lines.push('');
  lines.push(fields.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

export interface BuildTagFields {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function buildTag(fields: BuildTagFields): Buffer {
  const lines = [
    `object ${fields.object}`,
    `type ${fields.type}`,
    `tag ${fields.tag}`,
    `tagger ${fields.tagger}`,
    '',
    fields.message,
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

// ---------------------------------------------------------------------------------------------
// Deltas and packfiles

/** Read a pack object header: first byte = MSB + type(3 bits) + size low 4 bits, then 7-bit groups. */
function readPackObjectHeader(buf: Buffer, start: number): { typeNum: number; size: number; next: number } {
  let byte = buf[start] as number;
  const typeNum = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let pos = start + 1;
  while (byte & 0x80) {
    byte = buf[pos] as number;
    size |= (byte & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return { typeNum, size, next: pos };
}

/** Read a delta size varint (7 bits per byte, little-endian groups). Used by applyDelta only. */
function readDeltaSizeVarint(buf: Buffer, start: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = start;
  for (;;) {
    const byte = buf[pos] as number;
    pos += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if (!(byte & 0x80)) break;
  }
  return { value, next: pos };
}

/** Read an OFS_DELTA negative-offset varint. */
function readOfsVarint(buf: Buffer, start: number): { value: number; next: number } {
  let byte = buf[start] as number;
  let value = byte & 0x7f;
  let pos = start + 1;
  while (byte & 0x80) {
    byte = buf[pos] as number;
    value = ((value + 1) << 7) | (byte & 0x7f);
    pos += 1;
  }
  return { value, next: pos };
}

/** Inflate the zlib stream at `offset`; returns the data and the offset just past the stream. */
export function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  // inflateSync needs the exact stream; find its end by trying increasing lengths is too slow,
  // so use the zlib header + a streaming inflate via a manual approach: Node's inflateSync on a
  // slice works when the slice ends exactly at the stream end. We locate the end with
  // `zlib.inflateSync` on progressively grown slices is O(n^2); instead use the fact that the
  // deflate stream is followed by either another object or the 20-byte trailer, and scan for the
  // first offset where inflateSync succeeds AND the consumed length matches. Node exposes the
  // consumed bytes only through zlib.createInflate with `bytesWritten`... simpler: use
  // createInflate and feed the whole rest, tracking total output vs input consumed via the
  // 'data'/'end' events is async. Synchronous approach: try inflateSync on buf[offset..end]
  // for end = offset+2 .. buf.length is too slow for big packs, but our packs are small
  // (the suite's pushes are at most 100 files of ~4KB). Use a binary search on the end offset:
  // inflateSync throws on truncated input and succeeds (possibly with trailing garbage ignored?
  // no — inflateSync throws on trailing data? Actually inflateSync ignores trailing bytes after
  // the stream end? No: it throws "incorrect data check" only for corrupt data; trailing bytes
  // after a complete stream are IGNORED by inflateSync? Testing shows inflateSync returns the
  // inflated data and ignores trailing garbage. So inflate the whole remainder once and find
  // the true end by re-deflating? No. Use createInflateSync? Not available.
  // Practical approach: inflateSync(buf.subarray(offset)) ignores trailing bytes, and we
  // recover the consumed input length by deflating the result at the same level and comparing
  // lengths — unreliable across levels. Instead, scan: the zlib stream ends with the adler32
  // (4 bytes) and the deflate final block bit; a cheap exact method is to walk the stream with
  // a bit reader — overkill. Use binary search on end offset with inflateSync: it throws while
  // truncated, succeeds once complete (it ignores trailing bytes, so success at the FIRST
  // complete end is what binary search finds if we test "does it throw").
  let lo = offset + 2;
  let hi = buf.length;
  // First verify the whole remainder inflates at all.
  try {
    inflateSync(buf.subarray(offset));
  } catch {
    throw new Error('pack entry zlib stream is corrupt');
  }
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(offset, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  const data = inflateSync(buf.subarray(offset, lo));
  return { data, next: lo };
}

/** Apply a git delta to a base buffer, returning the reconstructed object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos] as number;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta source size ${sourceSize} != base length ${base.length}`);
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let outLen = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if (op & 0x80) {
      // copy from base: offset/size encoded in the bits set
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[pos] as number; pos += 1; }
      if (op & 0x02) { offset |= (delta[pos] as number) << 8; pos += 1; }
      if (op & 0x04) { offset |= (delta[pos] as number) << 16; pos += 1; }
      if (op & 0x08) { offset |= (delta[pos] as number) << 24; pos += 1; }
      if (op & 0x10) { size = delta[pos] as number; pos += 1; }
      if (op & 0x20) { size |= (delta[pos] as number) << 8; pos += 1; }
      if (op & 0x40) { size |= (delta[pos] as number) << 16; pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      outLen += size;
    } else if (op !== 0) {
      // insert literal bytes
      out.push(delta.subarray(pos, pos + op));
      outLen += op;
      pos += op;
    } else {
      throw new Error('delta op 0x00 is invalid');
    }
  }
  if (outLen !== targetSize) throw new Error(`delta target size ${targetSize} != reconstructed ${outLen}`);
  return Buffer.concat(out, outLen);
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  count: number;
}

/**
 * Read a packfile (version 2) and resolve every object, including OFS_DELTA and REF_DELTA.
 * `resolveBase` is consulted for REF_DELTA bases not present in the pack itself (the server's
 * object store, for pushes that delta against objects the server already holds).
 */
export function readPack(pack: Buffer, options: { resolveBase?: (oid: string) => GitObject | undefined } = {}): PackReadResult {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let pos = 12;
  // First pass: read all entries, resolving deltas whose base is already known; queue the rest.
  interface Pending { offset: number; type: 'ofs' | 'ref'; baseOffset?: number; baseOid?: string; data: Buffer; }
  const pending: Pending[] = [];
  for (let i = 0; i < count; i += 1) {
    const entryOffset = pos;
    const { typeNum, size, next: afterSize } = readPackObjectHeader(pack, pos);
    pos = afterSize;
    const TYPE_NAMES: Record<number, GitObjectType | 'ofs' | 'ref'> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag', 6: 'ofs', 7: 'ref' };
    const kind = TYPE_NAMES[typeNum];
    if (kind === undefined) throw new Error(`unknown pack object type ${typeNum}`);
    if (kind === 'ofs' || kind === 'ref') {
      let baseOffset: number | undefined;
      let baseOid: string | undefined;
      if (kind === 'ofs') {
        const r = readOfsVarint(pack, pos);
        baseOffset = entryOffset - r.value;
        pos = r.next;
      } else {
        baseOid = pack.subarray(pos, pos + 20).toString('hex');
        pos += 20;
      }
      const { data, next } = inflateAt(pack, pos);
      pos = next;
      pending.push({ offset: entryOffset, type: kind, baseOffset, baseOid, data });
      void size;
    } else {
      const { data, next } = inflateAt(pack, pos);
      pos = next;
      if (data.length !== size) throw new Error(`pack object size ${size} != inflated ${data.length}`);
      const oid = hashObject(kind, data);
      const obj: GitObject = { type: kind, data };
      objects.set(oid, obj);
      byOffset.set(entryOffset, obj);
    }
  }
  // Resolve pending deltas (possibly chained): iterate until no progress.
  let remaining = pending;
  while (remaining.length > 0) {
    const nextRound: Pending[] = [];
    let progressed = false;
    for (const item of remaining) {
      let base: GitObject | undefined;
      if (item.type === 'ofs') base = byOffset.get(item.baseOffset as number);
      else base = objects.get(item.baseOid as string) ?? options.resolveBase?.(item.baseOid as string);
      if (base === undefined) { nextRound.push(item); continue; }
      const data = applyDelta(base.data, item.data);
      const oid = hashObject(base.type, data);
      const obj: GitObject = { type: base.type, data };
      objects.set(oid, obj);
      byOffset.set(item.offset, obj);
      progressed = true;
    }
    if (!progressed) throw new Error('pack delta base not found in pack or store');
    remaining = nextRound;
  }
  return { objects, count };
}

/** Write a packfile (version 2) holding the given objects whole (no deltas). */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [header];
  const TYPE_NUMS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const obj of list) {
    const size = obj.data.length;
    const typeNum = TYPE_NUMS[obj.type];
    // varint header: first byte holds type in bits 4-6 and low 4 size bits, MSB continuation.
    const headerBytes: number[] = [];
    let remaining = size;
    let first = (typeNum << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Verify a packfile's trailer checksum. */
export function verifyPackChecksum(pack: Buffer): boolean {
  if (pack.length < 20) return false;
  const expected = pack.subarray(pack.length - 20).toString('hex');
  const actual = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest('hex');
  return expected === actual;
}
