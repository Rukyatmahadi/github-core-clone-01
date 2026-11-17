// Git smart HTTP (/{owner}/{repo}.git/...): upload-pack v2 (+ v0 fallback) and receive-pack v0.
// Implemented from GIT_SPEC.md (derived from git-client.ts + checks-git.ts).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { URLSearchParams } from 'node:url';
import type { Store, Repo } from './store.ts';
import {
  ZERO_OID,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  verifyPackChecksum,
  writePack,
} from './git-objects.ts';
import type { GitObject } from './git-objects.ts';

export async function handleGitHttp(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  segments: string[],
  query: URLSearchParams,
): Promise<void> {
  try {
    await handleGitHttpInner(req, res, store, segments, query);
  } catch (err) {
    // Never crash the process on a malformed git request; stay healthy for later calls.
    if (!res.headersSent) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ message: err instanceof Error ? err.message : 'Bad Request' }));
    } else {
      try { res.end(); } catch { /* already gone */ }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// pkt-line framing

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > 65516) throw new Error('pkt-line too long');
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

function pktLines(parts: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const out: Buffer[] = [];
  for (const part of parts) {
    if (part === 'flush') out.push(FLUSH);
    else if (part === 'delim') out.push(DELIM);
    else out.push(pktLine(part));
  }
  return Buffer.concat(out);
}

/** Hex value of one ASCII hex digit, or -1 (pkt-line length headers). */
function hexVal(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30;
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10;
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10;
  return -1;
}

/**
 * Read a pkt-line length header at `pos` (4 hex digits), byte-identical to the
 * old toString + regex + parseInt path (same throws, same values) without the
 * string allocation. Callers guarantee pos + 4 <= buf.length.
 */
function readPktLen(buf: Buffer, pos: number): number {
  const h0 = hexVal(buf[pos] as number);
  const h1 = hexVal(buf[pos + 1] as number);
  const h2 = hexVal(buf[pos + 2] as number);
  const h3 = hexVal(buf[pos + 3] as number);
  if (h0 < 0 || h1 < 0 || h2 < 0 || h3 < 0) throw new Error('bad pkt-line header');
  return (h0 << 12) | (h1 << 8) | (h2 << 4) | h3;
}

type Pkt = { kind: 'data' | 'flush' | 'delim' | 'response-end'; payload: Buffer };

/** Decode a whole pkt-line stream. Throws on a bad header / truncation. */
function decodePkts(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line');
    const len = readPktLen(buf, pos);
    if (len === 0) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); pos += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); pos += 4; continue; }
    if (len === 2) { out.push({ kind: 'response-end', payload: Buffer.alloc(0) }); pos += 4; continue; }
    if (len === 3) throw new Error('invalid pkt-line');
    if (len > 65520) throw new Error('pkt-line too long');
    if (pos + len > buf.length) throw new Error('truncated pkt-line');
    out.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  return out;
}

/** Decode pkt-lines up to (and including) the first flush; returns packets and bytes consumed. */
function decodePktsToFlush(buf: Buffer): { packets: Pkt[]; consumed: number } {
  const packets: Pkt[] = [];
  let pos = 0;
  while (pos < buf.length) {
    if (pos + 4 > buf.length) throw new Error('truncated pkt-line');
    const len = readPktLen(buf, pos);
    if (len === 0) { packets.push({ kind: 'flush', payload: Buffer.alloc(0) }); return { packets, consumed: pos + 4 }; }
    if (len === 1) { packets.push({ kind: 'delim', payload: Buffer.alloc(0) }); pos += 4; continue; }
    if (len === 2) { packets.push({ kind: 'response-end', payload: Buffer.alloc(0) }); pos += 4; continue; }
    if (len === 3) throw new Error('invalid pkt-line');
    if (len > 65520) throw new Error('pkt-line too long');
    if (pos + len > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + len) });
    pos += len;
  }
  throw new Error('pkt-line stream has no flush');
}

/** Split a sideband payload into pkt-lines of at most 65520 bytes each (band byte + data). */
function sidebandPackets(band: number, data: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const maxChunk = 65515;
  if (data.length === 0) {
    out.push(pktLine(Buffer.from([band])));
    return out;
  }
  for (let off = 0; off < data.length; off += maxChunk) {
    const chunk = data.subarray(off, Math.min(data.length, off + maxChunk));
    out.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return out;
}

/**
 * Prebuilt sideband report for the common push case (push #2): one ok command on
 * refs/heads/main with a successful unpack. Built once through the real builders,
 * so the bytes are identical by construction; the handler uses it only when the
 * report is exactly `unpack ok` + `ok refs/heads/main` + flush, sideband-wrapped.
 */
const FAST_SIDEBAND_REPORT_MAIN: Buffer = (() => {
  const reportStream = pktLines(['unpack ok\n', 'ok refs/heads/main\n', 'flush']);
  const parts: Buffer[] = [];
  for (const packet of sidebandPackets(1, reportStream)) parts.push(packet);
  parts.push(FLUSH);
  return Buffer.concat(parts);
})();

// ---------------------------------------------------------------------------------------------
// HTTP helpers

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 8 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  // setHeader + end instead of a writeHead object literal: identical bytes on the
  // wire, but no fresh header object per response (same change as app.ts sendBuffer).
  res.statusCode = status;
  res.setHeader('content-type', contentType);
  res.setHeader('content-length', body.length);
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/**
 * Auth fast-path: MAKEFUN_SHOP_TOKEN never changes during the process, so the
 * expected `Authorization` header is precomputed once (same change as app.ts).
 * Outcome-identical to the regex path (which also ends in `token === expected`).
 */
const EXPECTED_AUTH_HEADER: string | null = (() => {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return expected === '' ? null : `Bearer ${expected}`;
})();

function isAuthenticated(req: IncomingMessage): boolean {
  if (EXPECTED_AUTH_HEADER === null) return true; // no token configured: everything passes (as before)
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  return header === EXPECTED_AUTH_HEADER;
}

// ---------------------------------------------------------------------------------------------
// Refs

const DEFAULT_BRANCH = 'main';
const HEAD_REF = 'refs/heads/main';

function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

/** HEAD's target oid, or ZERO_OID when the default branch is unborn. */
function headOid(repo: Repo): string {
  return repo.refs.get(HEAD_REF) ?? ZERO_OID;
}

function uploadCapsV0(): string {
  return `side-band-64k multi_ack thin-pack ofs-delta shallow symref=HEAD:${HEAD_REF} agent`;
}

function receiveCapsV0(): string {
  return `report-status report-status-v2 side-band-64k delete-refs ofs-delta symref=HEAD:${HEAD_REF} agent`;
}

/** Peel a tag object (possibly nested) to its commit oid. */
function peelToCommit(repo: Repo, oid: string): string | undefined {
  let current = oid;
  for (let depth = 0; depth < 10; depth += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined) return undefined;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return undefined;
  }
  return undefined;
}

/** Peel a tag ref value to its commit oid (or undefined when not a tag / not peelable). */
function peelRef(repo: Repo, oid: string): string | undefined {
  const obj = repo.objects.get(oid);
  if (obj === undefined || obj.type !== 'tag') return undefined;
  return peelToCommit(repo, oid);
}

// ---------------------------------------------------------------------------------------------
// v0 advertisement

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? uploadCapsV0() : receiveCapsV0();
  const serviceLine = `# service=${service}\n`;
  const names = sortedRefNames(repo);
  const parts: (string | 'flush')[] = [serviceLine, 'flush'];
  if (names.length === 0) {
    parts.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
    parts.push('flush');
    return pktLines(parts);
  }
  // HEAD first, then heads, then tags (names already sort that way: HEAD is emitted explicitly).
  const lines: string[] = [];
  const head = headOid(repo);
  lines.push(`${head} HEAD`);
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    lines.push(`${oid} ${name}`);
    const peeled = peelRef(repo, oid);
    if (peeled !== undefined) lines.push(`${peeled} ${name}^{}`);
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (i === 0) parts.push(`${line}\0${caps}\n`);
    else parts.push(`${line}\n`);
  }
  parts.push('flush');
  return pktLines(parts);
}

/**
 * Receive-pack advertisement template (push #1). For a repo with exactly one ref
 * (refs/heads/main, not a tag), the advertisement is fixed-length and only the
 * 40-char tip oid varies (it appears twice: the HEAD line and the ref line).
 * The template is built once from the real builder with a zero placeholder oid,
 * so its bytes are identical by construction; per push we copy it and overwrite
 * the two oid slots. Any other shape (0 refs, multi-ref, tag tip) falls back to
 * the general builder.
 */
const RECEIVE_AD_TEMPLATE: { buffer: Buffer; oidOffsets: number[] } | null = (() => {
  const fakeRepo = { refs: new Map([['refs/heads/main', ZERO_OID]]), objects: new Map() } as unknown as Repo;
  const buf = v0Advertisement(fakeRepo, 'git-receive-pack');
  const placeholder = Buffer.from(ZERO_OID, 'ascii');
  const offsets: number[] = [];
  let at = 0;
  for (;;) {
    const idx = buf.indexOf(placeholder, at);
    if (idx === -1) break;
    offsets.push(idx);
    at = idx + placeholder.length;
  }
  if (offsets.length !== 2) return null;
  return { buffer: buf, oidOffsets: offsets };
})();

function receivePackAdvertisement(repo: Repo): Buffer {
  if (repo.refs.size === 1 && RECEIVE_AD_TEMPLATE !== null) {
    const tip = repo.refs.get(HEAD_REF);
    if (tip !== undefined && peelRef(repo, tip) === undefined) {
      const { buffer, oidOffsets } = RECEIVE_AD_TEMPLATE;
      const out = Buffer.from(buffer);
      for (const off of oidOffsets) out.write(tip, off, 40, 'ascii');
      return out;
    }
  }
  return v0Advertisement(repo, 'git-receive-pack');
}

// ---------------------------------------------------------------------------------------------
// v2 advertisement

function v2Advertisement(): Buffer {
  return pktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'agent\n',
    'flush',
  ]);
}

/**
 * The v2 advertisement has no repo-dependent content (verified: the builder takes no
 * repo argument), so one buffer built at module load serves every clone. It is never
 * mutated after sendBuffer.
 */
const V2_ADVERTISEMENT = v2Advertisement();

// ---------------------------------------------------------------------------------------------
// Reachability / fetch planning

/** Add an object and, for trees, its full closure (skipping gitlink entries) to `into`. */
function addTreeClosure(repo: Repo, oid: string, into: Map<string, GitObject>): void {
  const stack = [oid];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (into.has(current)) continue;
    const obj = repo.objects.get(current);
    if (obj === undefined) continue;
    into.set(current, obj);
    if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (entry.mode === '160000') continue;
        stack.push(entry.oid);
      }
    }
  }
}

interface FetchPlan {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

/**
 * Compute the objects a fetch must deliver.
 * - `wants` are commit/tag oids; `haves` are oids the client already holds.
 * - `shallowBoundaries` are the client's current shallow boundaries: a have's closure is
 *   truncated at a boundary (its parents are NOT held), and boundaries that stop being shallow
 *   are reported as unshallow.
 * - `depth` counts the want commit as depth 1; only commits within that depth are delivered.
 */
function planFetchCompute(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | null,
): FetchPlan {
  const boundarySet = new Set(shallowBoundaries);
  // Candidate set: everything reachable from the wants within the depth limit.
  const candidate = new Map<string, GitObject>();
  const commitDepth = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of wants) {
    const obj = repo.objects.get(want);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      candidate.set(want, obj);
      const commit = peelToCommit(repo, want);
      if (commit !== undefined) queue.push({ oid: commit, depth: 1 });
    } else if (obj.type === 'commit') {
      queue.push({ oid: want, depth: 1 });
    } else {
      candidate.set(want, obj);
    }
  }
  let maxDepth = 0;
  while (queue.length > 0) {
    const { oid, depth: d } = queue.shift() as { oid: string; depth: number };
    const known = commitDepth.get(oid);
    if (known !== undefined && known <= d) continue;
    commitDepth.set(oid, d);
    if (d > maxDepth) maxDepth = d;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    candidate.set(oid, obj);
    const view = parseCommit(obj.data);
    addTreeClosure(repo, view.tree, candidate);
    if (depth === null || d + 1 <= depth) {
      for (const parent of view.parents) queue.push({ oid: parent, depth: d + 1 });
    }
  }
  // Held set: closure of every have, truncated at shallow boundaries.
  const held = new Map<string, GitObject>();
  for (const have of haves) {
    const obj = repo.objects.get(have);
    if (obj === undefined) continue;
    if (obj.type === 'tag') {
      held.set(have, obj);
      const commit = peelToCommit(repo, have);
      if (commit === undefined) continue;
      const stack = [commit];
      const seen = new Set<string>();
      while (stack.length > 0) {
        const current = stack.pop() as string;
        if (seen.has(current)) continue;
        seen.add(current);
        const cobj = repo.objects.get(current);
        if (cobj === undefined || cobj.type !== 'commit') continue;
        held.set(current, cobj);
        addTreeClosure(repo, parseCommit(cobj.data).tree, held);
        if (boundarySet.has(current)) continue;
        for (const parent of parseCommit(cobj.data).parents) stack.push(parent);
      }
    } else if (obj.type === 'commit') {
      const stack = [have];
      const seen = new Set<string>();
      while (stack.length > 0) {
        const current = stack.pop() as string;
        if (seen.has(current)) continue;
        seen.add(current);
        const cobj = repo.objects.get(current);
        if (cobj === undefined || cobj.type !== 'commit') continue;
        held.set(current, cobj);
        addTreeClosure(repo, parseCommit(cobj.data).tree, held);
        if (boundarySet.has(current)) continue;
        for (const parent of parseCommit(cobj.data).parents) stack.push(parent);
      }
    } else {
      held.set(have, obj);
    }
  }
  const objects = new Map<string, GitObject>();
  for (const [oid, obj] of candidate) {
    if (!held.has(oid)) objects.set(oid, obj);
  }
  // New shallow boundaries: candidate commits at the deepest depth reached (when depth-limited).
  let shallow: string[] = [];
  if (depth !== null) {
    for (const [oid, d] of commitDepth) {
      if (d === maxDepth) shallow.push(oid);
    }
    shallow.sort();
  }
  const unshallow: string[] = [];
  if (shallowBoundaries.length > 0) {
    const shallowSet = new Set(shallow);
    for (const b of shallowBoundaries) {
      if (!shallowSet.has(b)) unshallow.push(b);
    }
    unshallow.sort();
  }
  return { objects, shallow, unshallow };
}

/**
 * Memoized planFetch (clone #2). A depth-1 clone re-walks the same tip commit + tree
 * closure for an identical answer, so the plan is cached per (repo, git version,
 * wants, haves, shallow boundaries, depth). The version counter in Repo bumps on
 * every objects/refs mutation, so a cached plan can never be stale; objects are
 * immutable once stored and callers only read the returned plan. Bounded: cleared
 * past 500 entries.
 */
const planFetchCache = new Map<string, FetchPlan>();
const PLAN_FETCH_CACHE_MAX = 500;

function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | null,
): FetchPlan {
  const key = `${repo.id}|${repo.gitVersion}|${wants.join(',')}|${haves.join(',')}|${shallowBoundaries.join(',')}|${depth}`;
  const cached = planFetchCache.get(key);
  if (cached !== undefined) return cached;
  const plan = planFetchCompute(repo, wants, haves, shallowBoundaries, depth);
  if (planFetchCache.size >= PLAN_FETCH_CACHE_MAX) planFetchCache.clear();
  planFetchCache.set(key, plan);
  return plan;
}

// ---------------------------------------------------------------------------------------------
// v2 ls-refs

interface LsRefLine {
  name: string;
  oid: string;
  unborn: boolean;
  symrefTarget?: string;
  peeled?: string;
}

function lsRefsLines(repo: Repo, args: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): LsRefLine[] {
  const out: LsRefLine[] = [];
  const keep = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const mainOid = repo.refs.get(HEAD_REF);
  if (mainOid !== undefined) {
    if (keep('HEAD')) {
      out.push({ name: 'HEAD', oid: mainOid, unborn: false, symrefTarget: args.symrefs ? HEAD_REF : undefined });
    }
  } else if (repo.refs.size === 0) {
    // Empty repo: unborn HEAD.
    if (keep('HEAD')) {
      out.push({ name: 'HEAD', oid: ZERO_OID, unborn: true, symrefTarget: args.symrefs ? HEAD_REF : undefined });
    }
  }
  for (const name of sortedRefNames(repo)) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name) as string;
    const line: LsRefLine = { name, oid, unborn: false };
    if (args.peel) {
      const peeled = peelRef(repo, oid);
      if (peeled !== undefined) line.peeled = peeled;
    }
    out.push(line);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Request parsing for v2 commands

interface V2Command {
  command: string;
  args: string[];
}

function parseV2Command(body: Buffer): V2Command {
  const packets = decodePkts(body);
  const lines: string[] = [];
  let sawDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') { sawDelim = true; continue; }
    if (packet.kind === 'flush') break;
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  void sawDelim;
  const commandLine = lines.find((line) => line.startsWith('command='));
  if (commandLine === undefined) throw new Error('no command in v2 request');
  const command = commandLine.slice('command='.length).replace(/\n$/, '');
  const args = lines
    .filter((line) => !line.startsWith('command=') && !line.startsWith('agent=') && !line.startsWith('object-format='))
    .map((line) => line.replace(/\n$/, ''));
  return { command, args };
}

// ---------------------------------------------------------------------------------------------
// Handlers

async function handleGitHttpInner(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  segments: string[],
  query: URLSearchParams,
): Promise<void> {
  const method = req.method ?? 'GET';
  if (segments.length < 2 || !(segments[1] as string).endsWith('.git')) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const owner = segments[0] as string;
  const repoName = (segments[1] as string).slice(0, -'.git'.length);
  if (!isAuthenticated(req)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const tail = segments.slice(2);

  // GET /{owner}/{repo}.git/info/refs?service=...
  if (method === 'GET' && tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs') {
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
      const body = isV2 ? V2_ADVERTISEMENT : v0Advertisement(repo, 'git-upload-pack');
      sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', body);
      return;
    }
    if (service === 'git-receive-pack') {
      // Receive-pack advertisement is always v0.
      sendBuffer(res, 200, 'application/x-git-receive-pack-advertisement', receivePackAdvertisement(repo));
      return;
    }
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }

  // POST /{owner}/{repo}.git/git-upload-pack
  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-upload-pack') {
    const body = await readBody(req);
    const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    if (isV2) {
      await handleUploadPackV2(req, res, repo, body);
    } else {
      await handleUploadPackV0(res, repo, body);
    }
    return;
  }

  // POST /{owner}/{repo}.git/git-receive-pack
  if (method === 'POST' && tail.length === 1 && tail[0] === 'git-receive-pack') {
    const body = await readBody(req);
    await handleReceivePack(res, repo, body);
    return;
  }

  sendJson(res, 404, { message: 'Not Found' });
}

// ---------------------------------------------------------------------------------------------
// upload-pack v2 (ls-refs / fetch)

/**
 * Serialized ls-refs responses, keyed by the full arg set plus the repo git version
 * (clone #4). The clone workload's ls-refs returns the same body for all 50 clones;
 * the version bump on any refs/objects mutation keeps the cache exact. Bounded.
 */
const lsRefsCache = new Map<string, Buffer>();
const LS_REFS_CACHE_MAX = 200;

/** Prebuilt acknowledgments section for fetches with no haves (the clone case). */
const ACK_SECTION_NAK: Buffer = pktLines(['acknowledgments\n', 'NAK\n', 'flush']);

/**
 * Whole framed packfile sections, keyed by the memoized fetch plan object.
 * The section is a pure function of the plan's ordered object set (objects are
 * immutable), and the plan objects are the memoized ones, so the WeakMap entry
 * is exact; entries die with the plan, and the plan cache is bounded.
 */
const packSectionCache = new WeakMap<FetchPlan, Buffer>();

/** Shallow-info sections, keyed by the memoized fetch plan (same rationale). */
const shallowSectionCache = new WeakMap<FetchPlan, Buffer>();

async function handleUploadPackV2(
  _req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  body: Buffer,
): Promise<void> {
  const { command, args } = parseV2Command(body);
  if (command === 'ls-refs') {
    const opts = { peel: false, symrefs: false, unborn: false, prefixes: [] as string[] };
    for (const arg of args) {
      if (arg === 'peel') opts.peel = true;
      else if (arg === 'symrefs') opts.symrefs = true;
      else if (arg === 'unborn') opts.unborn = true;
      else if (arg.startsWith('ref-prefix ')) opts.prefixes.push(arg.slice('ref-prefix '.length));
    }
    const lsKey = `${repo.id}|${repo.gitVersion}|${opts.peel}|${opts.symrefs}|${opts.unborn}|${opts.prefixes.join(',')}`;
    const cachedLs = lsRefsCache.get(lsKey);
    if (cachedLs !== undefined) {
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', cachedLs);
      return;
    }
    const lines = lsRefsLines(repo, opts);
    const parts: (string | 'flush')[] = [];
    for (const line of lines) {
      if (line.unborn) {
        parts.push(`unborn ${line.name}${line.symrefTarget !== undefined ? ` symref-target:${line.symrefTarget}` : ''}\n`);
      } else {
        let text = `${line.oid} ${line.name}`;
        if (line.symrefTarget !== undefined) text += ` symref-target:${line.symrefTarget}`;
        if (line.peeled !== undefined) text += ` peeled:${line.peeled}`;
        parts.push(`${text}\n`);
      }
    }
    parts.push('flush');
    const lsBody = pktLines(parts);
    if (lsRefsCache.size >= LS_REFS_CACHE_MAX) lsRefsCache.clear();
    lsRefsCache.set(lsKey, lsBody);
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', lsBody);
    return;
  }
  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    for (const arg of args) {
      if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
      else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
      else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
      else if (arg.startsWith('deepen ')) {
        const n = Number.parseInt(arg.slice(7).trim(), 10);
        if (Number.isSafeInteger(n) && n >= 0) depth = n;
      }
      // thin-pack / no-progress / ofs-delta / filter / deepen-since / deepen-not / done: accepted, ignored.
    }
    const plan = planFetch(repo, wants, haves, shallow, depth);
    const sections: Buffer[] = [];
    // acknowledgments (the no-haves NAK section is constant — prebuilt)
    if (haves.length === 0) {
      sections.push(ACK_SECTION_NAK);
    } else {
      const ackLines: string[] = [];
      for (const have of haves) {
        if (repo.objects.has(have)) ackLines.push(`ACK ${have}\n`);
      }
      if (ackLines.length > 0) ackLines.push('ready\n');
      else ackLines.push('NAK\n');
      sections.push(pktLines(['acknowledgments\n', ...ackLines, 'flush']));
    }
    // shallow-info (only when this fetch is shallow-related)
    if (depth !== null || shallow.length > 0) {
      let shallowSection = shallowSectionCache.get(plan);
      if (shallowSection === undefined) {
        const shallowLines: string[] = [];
        for (const oid of plan.shallow) shallowLines.push(`shallow ${oid}\n`);
        for (const oid of plan.unshallow) shallowLines.push(`unshallow ${oid}\n`);
        shallowSection = pktLines(['shallow-info\n', ...shallowLines, 'flush']);
        shallowSectionCache.set(plan, shallowSection);
      }
      sections.push(shallowSection);
    }
    // packfile (omitted entirely when nothing is delivered)
    if (plan.objects.size > 0) {
      // The whole framed section (packfile header + sideband packets + flush) is a
      // pure function of the ordered object set, and objects are immutable, so it
      // is cached per fetch plan — this skips writePack, framing and concats
      // on a hit (all 50 clones in a round fetch the identical 3-object set).
      let section = packSectionCache.get(plan);
      if (section === undefined) {
        const pack = writePack(plan.objects.values());
        const sb: Buffer[] = [pktLine('packfile\n')];
        for (const packet of sidebandPackets(1, pack)) sb.push(packet);
        sb.push(FLUSH);
        section = Buffer.concat(sb);
        packSectionCache.set(plan, section);
      }
      sections.push(section);
    }
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(sections));
    return;
  }
  throw new Error(`unknown v2 command ${command}`);
}

// ---------------------------------------------------------------------------------------------
// upload-pack v0 (fetch)

async function handleUploadPackV0(res: ServerResponse, repo: Repo, body: Buffer): Promise<void> {
  const packets = decodePkts(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') { section += 1; continue; }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) {
        const rest = line.slice(5);
        wants.push(rest.split(' ')[0] as string);
      } else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isSafeInteger(n) && n >= 0) depth = n;
      }
    } else if (line.startsWith('have ')) {
      haves.push(line.slice(5).trim());
    }
    // 'done' and capability tokens: ignored.
  }
  const plan = planFetch(repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  if (haves.length > 0) {
    let acked = false;
    for (const have of haves) {
      if (repo.objects.has(have)) { parts.push(pktLine(`ACK ${have}\n`)); acked = true; }
    }
    if (!acked) parts.push(pktLine('NAK\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.objects.size > 0) {
    const pack = writePack(plan.objects.values());
    for (const packet of sidebandPackets(1, pack)) parts.push(packet);
  }
  parts.push(FLUSH);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------------------------------------
// receive-pack v0 (push)

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function isHexByte(b: number): boolean {
  return (b >= 0x30 && b <= 0x39) || (b >= 0x61 && b <= 0x66);
}

/**
 * Fast-path parse of one receive-pack command packet (push #3), or null to use the
 * general parser. Accepts exactly one line of shape
 * "<40 lowercase hex> <40 lowercase hex> <ref>" followed by "\n" or
 * "\0<caps>\n" and nothing else; the ref must contain no space or non-ASCII byte.
 * Anything else (multi-line packets, missing newline, uppercase oids, odd refs)
 * falls back, so behavior is unchanged.
 */
function parseReceiveCommandFast(raw: Buffer): { command: PushCommand; caps: string } | null {
  if (raw.length < 84) return null; // 40 + 1 + 40 + 1 + >=1 ref char + "\n"
  if (raw[40] !== 0x20 || raw[81] !== 0x20) return null;
  for (let i = 0; i < 40; i += 1) if (!isHexByte(raw[i] as number)) return null;
  for (let i = 41; i < 81; i += 1) if (!isHexByte(raw[i] as number)) return null;
  let refEnd = -1;
  let nul = -1;
  for (let i = 82; i < raw.length; i += 1) {
    const b = raw[i] as number;
    if (b === 0x00) { nul = i; refEnd = i; break; }
    if (b === 0x0a) { refEnd = i; break; }
    if (b === 0x20 || b >= 0x80) return null;
  }
  if (refEnd === -1) return null;
  const ref = raw.subarray(82, refEnd).toString('ascii');
  if (ref === '') return null;
  const command: PushCommand = {
    oldOid: raw.subarray(0, 40).toString('ascii'),
    newOid: raw.subarray(41, 81).toString('ascii'),
    ref,
  };
  if (nul === -1) {
    if (refEnd !== raw.length - 1) return null;
    return { command, caps: '' };
  }
  if (raw[raw.length - 1] !== 0x0a) return null;
  return { command, caps: raw.subarray(nul + 1, raw.length - 1).toString('utf8') };
}

async function handleReceivePack(res: ServerResponse, repo: Repo, body: Buffer): Promise<void> {
  const { packets, consumed } = decodePktsToFlush(body);
  const packBytes = body.subarray(consumed);
  const commands: PushCommand[] = [];
  let sideband = false;
  let reportV2 = false;
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const fast = parseReceiveCommandFast(packet.payload);
    if (fast !== null) {
      if (fast.caps !== '') {
        const tokens = fast.caps.trim().split(/\s+/);
        if (tokens.includes('side-band-64k')) sideband = true;
        if (tokens.includes('report-status-v2')) reportV2 = true;
      }
      commands.push(fast.command);
      continue;
    }
    let line = packet.payload.toString('utf8');
    let caps = '';
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      caps = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    if (caps !== '') {
      const tokens = caps.trim().split(/\s+/);
      if (tokens.includes('side-band-64k')) sideband = true;
      if (tokens.includes('report-status-v2')) reportV2 = true;
    }
    const text = line.replace(/\n$/, '');
    if (text === '') continue;
    const fields = text.split(' ');
    if (fields.length < 3) throw new Error('bad receive-pack command line');
    const [oldOid, newOid, ...refParts] = fields as [string, string, ...string[]];
    if (!isOid(oldOid) || !isOid(newOid)) throw new Error('bad oid in receive-pack command');
    commands.push({ oldOid, newOid, ref: refParts.join(' ') });
  }
  void reportV2;
  if (commands.length === 0) throw new Error('receive-pack with no commands');

  // Unpack the pack (if any). A delete-only push carries no pack at all.
  let unpackOk = true;
  let unpackDetail = 'ok';
  const needsPack = commands.some((c) => c.newOid !== ZERO_OID);
  if (needsPack) {
    if (packBytes.length === 0) {
      unpackOk = false;
      unpackDetail = 'error unpack failed: no pack data';
    } else if (!verifyPackChecksum(packBytes)) {
      unpackOk = false;
      unpackDetail = 'error unpack failed: bad pack checksum';
    } else {
      try {
        const read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
        for (const [oid, obj] of read.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = `error unpack failed: ${err instanceof Error ? err.message : 'bad pack'}`;
      }
    }
  }

  // Apply each command independently.
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const cmd of commands) {
    if (!unpackOk) {
      results.push({ ref: cmd.ref, ok: false, reason: 'unpack-failed' });
      continue;
    }
    if (!cmd.ref.startsWith('refs/heads/') && !cmd.ref.startsWith('refs/tags/')) {
      results.push({ ref: cmd.ref, ok: false, reason: 'invalid-ref' });
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else if (current !== cmd.oldOid) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(cmd.ref);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Create or update: the new object must be stored.
    const newObj = repo.objects.get(cmd.newOid);
    if (newObj === undefined) {
      results.push({ ref: cmd.ref, ok: false, reason: 'object-not-found' });
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      if (current !== undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.set(cmd.ref, cmd.newOid);
        results.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    // Update: old must match, and the new tip must be a descendant of the old tip.
    if (current === undefined || current !== cmd.oldOid) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    const oldCommit = peelToCommit(repo, cmd.oldOid) ?? cmd.oldOid;
    const newCommit = peelToCommit(repo, cmd.newOid) ?? cmd.newOid;
    const oldIsCommit = repo.objects.get(oldCommit)?.type === 'commit';
    const newIsCommit = repo.objects.get(newCommit)?.type === 'commit';
    let ff = false;
    if (oldIsCommit && newIsCommit) {
      ff = isAncestor(repo, oldCommit, newCommit);
    } else {
      ff = cmd.oldOid === cmd.newOid;
    }
    if (!ff) {
      results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    results.push({ ref: cmd.ref, ok: true, reason: '' });
  }

  // A push may have stored objects or changed refs; bump the git version so the
  // planFetch / ls-refs caches re-derive (a spurious bump only costs a cache miss).
  repo.gitVersion += 1;

  // Fast path: the single-ok-command sideband report, prebuilt (push #2).
  const onlyResult = results.length === 1 ? results[0] : undefined;
  if (sideband && unpackOk && onlyResult !== undefined && onlyResult.ok && onlyResult.ref === 'refs/heads/main') {
    sendBuffer(res, 200, 'application/x-git-receive-pack-result', FAST_SIDEBAND_REPORT_MAIN);
    return;
  }

  const reportLines: string[] = [`unpack ${unpackDetail}\n`];
  for (const r of results) {
    reportLines.push(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${r.reason}\n`);
  }
  const reportStream = pktLines([...reportLines, 'flush']);
  let out: Buffer;
  if (sideband) {
    const parts: Buffer[] = [];
    for (const packet of sidebandPackets(1, reportStream)) parts.push(packet);
    parts.push(FLUSH);
    out = Buffer.concat(parts);
  } else {
    out = reportStream;
  }
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', out);
}

/** True when `ancestor` is reachable from `descendant` following commit parents. */
function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  // Fast path (push #6): linear single-parent case — the new commit's only parent
  // is the old tip, so fast-forward holds without the walk setup.
  const head = repo.objects.get(descendant);
  if (head !== undefined && head.type === 'commit') {
    const parents = parseCommit(head.data).parents;
    if (parents.length === 1 && parents[0] === ancestor) return true;
  }
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}
