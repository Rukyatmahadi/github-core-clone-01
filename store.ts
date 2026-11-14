// The forge's in-memory store: repositories, git objects, issues, pull requests, labels.
// Everything is deterministic: no wall clock, no Math.random. Ordering uses monotonic sequence
// numbers, and commit timestamps are a fixed epoch plus the commit sequence, so two runs fed
// the same requests in the same order produce byte-identical git objects.

import { buildCommit, buildTag, buildTree, hashObject, parseCommit, parseTag, parseTree } from './git-objects.ts';
import type { GitObject, GitObjectType, TreeEntry } from './git-objects.ts';
import { VIEWER } from './scenario.ts';

/** Fixed epoch for every timestamp the store emits (2025-01-01T00:00:00Z). */
export const STORE_EPOCH_SEC = 1_735_689_600;

/** Format a sequence as an ISO-8601 UTC timestamp (deterministic). */
export function isoAt(seq: number): string {
  return new Date((STORE_EPOCH_SEC + seq) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Format a sequence as a git timestamp line ("<epoch> +0000"). */
export function gitTs(seq: number): string {
  return `${STORE_EPOCH_SEC + seq} +0000`;
}

/** The identity every REST-created commit carries. */
export function viewerIdent(seq: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${gitTs(seq)}`;
}

export interface Label {
  id: number;
  name: string;
  color: string;
}

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  createdSeq: number;
  closedSeq: number | null;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  mergedSeq: number | null;
  createdSeq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  /** refs/heads/<branch> and refs/tags/<tag> -> oid */
  refs: Map<string, string>;
  /** oid -> object */
  objects: Map<string, GitObject>;
  labels: Label[];
  issues: Issue[];
  pulls: Pull[];
  nextIssueNumber: number;
  nextPullNumber: number;
  nextLabelId: number;
  /** files changed by each open PR's head vs its base (computed at PR creation, refreshed on merge). */
  pullFiles: Map<number, PullFile[]>;
}

/** Global GraphQL ids: opaque base64url of a typed tag the server can decode. */
export function repoGlobalId(owner: string, name: string): string {
  return Buffer.from(`Repository:${owner}/${name}`, 'utf8').toString('base64url');
}
export function issueGlobalId(owner: string, name: string, number: number): string {
  return Buffer.from(`Issue:${owner}/${name}#${number}`, 'utf8').toString('base64url');
}
export function pullGlobalId(owner: string, name: string, number: number): string {
  return Buffer.from(`PullRequest:${owner}/${name}#${number}`, 'utf8').toString('base64url');
}
export function commentGlobalId(owner: string, name: string, issueNumber: number, commentId: number): string {
  return Buffer.from(`IssueComment:${owner}/${name}#${issueNumber}:${commentId}`, 'utf8').toString('base64url');
}

/** Decode a global id into {kind, owner, name, number?, commentId?} or null. */
export function decodeGlobalId(id: string): { kind: string; owner: string; name: string; number: number; commentId: number } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const match = /^(Repository|Issue|PullRequest|IssueComment):([^/]+)\/([^#:]+)(?:#(\d+))?(?::(\d+))?$/.exec(text);
    if (match === null) return null;
    return {
      kind: match[1] as string,
      owner: match[2] as string,
      name: match[3] as string,
      number: match[4] === undefined ? 0 : Number.parseInt(match[4], 10),
      commentId: match[5] === undefined ? 0 : Number.parseInt(match[5], 10),
    };
  } catch {
    return null;
  }
}

export class Store {
  repos = new Map<string, Repo>();
  seq = 0;
  nextRepoId = 5000;
  nextObjectId = 1;
  nextCommentId = 1;

  /** Monotonic sequence for ordering and timestamps. */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, opts: { private?: boolean; description?: string }): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      fullName: `${owner}/${name}`,
      description: opts.description ?? '',
      private: opts.private ?? false,
      defaultBranch: 'main',
      createdSeq: this.nextSeq(),
      refs: new Map(),
      objects: new Map(),
      labels: [],
      issues: [],
      pulls: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextLabelId: 1,
      pullFiles: new Map(),
    };
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  listReposByOwner(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  // -------------------------------------------------------------------------------------------
  // Git objects

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** Resolve a ref name ("main", "refs/heads/main") or an oid to a commit oid, or undefined. */
  resolveRef(repo: Repo, ref: string): string | undefined {
    if (/^[0-9a-f]{40}$/.test(ref)) return repo.objects.has(ref) ? ref : undefined;
    const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    const oid = repo.refs.get(full);
    if (oid !== undefined) return oid;
    // A tag name resolves to its target commit (peeled).
    const tagOid = repo.refs.get(`refs/tags/${ref}`);
    if (tagOid !== undefined) return this.peelToCommit(repo, tagOid);
    return undefined;
  }

  /** Peel a tag object (possibly nested) to its commit oid. */
  peelToCommit(repo: Repo, oid: string): string | undefined {
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

  /** True when `ancestor` is reachable from `descendant` (parents walk). */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
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

  /** Commits reachable from `tip`, newest first (by creation sequence = topological order here). */
  listCommits(repo: Repo, tip: string): { sha: string; message: string; seq: number }[] {
    const out: { sha: string; message: string; seq: number }[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'commit') continue;
      const view = parseCommit(obj.data);
      // The commit's sequence is encoded in its author timestamp (epoch + seq).
      const seq = commitSeq(view.author);
      out.push({ sha: oid, message: view.message, seq });
      for (const parent of view.parents) stack.push(parent);
    }
    out.sort((a, b) => b.seq - a.seq);
    return out;
  }

  /** All objects reachable from the given tips (commits, their trees/blobs, tags). */
  collectReachable(repo: Repo, tips: readonly string[]): Map<string, GitObject> {
    const out = new Map<string, GitObject>();
    const stack = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (out.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (obj === undefined) continue;
      out.set(oid, obj);
      if (obj.type === 'commit') {
        const view = parseCommit(obj.data);
        stack.push(view.tree);
        for (const parent of view.parents) stack.push(parent);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) stack.push(entry.oid);
      } else if (obj.type === 'tag') {
        stack.push(parseTag(obj.data).object);
      }
    }
    return out;
  }

  /** The merge-base of two commits (first common ancestor in newest-first order), or undefined. */
  mergeBase(repo: Repo, a: string, b: string): string | undefined {
    const aCommits = new Set(this.listCommits(repo, a).map((c) => c.sha));
    for (const c of this.listCommits(repo, b)) if (aCommits.has(c.sha)) return c.sha;
    return undefined;
  }

  // -------------------------------------------------------------------------------------------
  // Trees and files

  /** Flatten a tree object into path -> {mode, oid, type}. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string; type: GitObjectType }> {
    const out = new Map<string, { mode: string; oid: string; type: GitObjectType }>();
    const walk = (oid: string, dir: string): void => {
      const obj = repo.objects.get(oid);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const entry of parseTree(obj.data)) {
        const path = dir === '' ? entry.name : `${dir}/${entry.name}`;
        if (entry.mode === '40000') {
          out.set(path, { mode: entry.mode, oid: entry.oid, type: 'tree' });
          walk(entry.oid, path);
        } else {
          out.set(path, { mode: entry.mode, oid: entry.oid, type: 'blob' });
        }
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Build a tree object from a flat path -> {mode, data} map; stores all objects. Returns root oid. */
  buildTreeFromFiles(repo: Repo, files: Map<string, { mode: string; data: Buffer }>): string {
    // Group by directory, bottom-up.
    const dirs = new Map<string, Map<string, { mode: string; oid: string }>>();
    const ensureDir = (dir: string): Map<string, { mode: string; oid: string }> => {
      let map = dirs.get(dir);
      if (map === undefined) {
        map = new Map();
        dirs.set(dir, map);
      }
      return map;
    };
    for (const [path, file] of files) {
      const slash = path.lastIndexOf('/');
      const dir = slash === -1 ? '' : path.slice(0, slash);
      const name = slash === -1 ? path : path.slice(slash + 1);
      const blobOid = this.putObject(repo, 'blob', file.data);
      ensureDir(dir).set(name, { mode: file.mode, oid: blobOid });
    }
    // Collect every directory that appears (including intermediate ones).
    const allDirs = new Set<string>(['']);
    for (const path of files.keys()) {
      const parts = path.split('/');
      let acc = '';
      for (let i = 0; i < parts.length - 1; i += 1) {
        acc = acc === '' ? (parts[i] as string) : `${acc}/${parts[i]}`;
        allDirs.add(acc);
      }
    }
    // Build deepest first ('' is depth 0, 'a' depth 1, 'a/b' depth 2).
    const depthOf = (dir: string): number => (dir === '' ? 0 : dir.split('/').length);
    const sorted = [...allDirs].sort((a, b) => depthOf(b) - depthOf(a));
    const dirOids = new Map<string, string>();
    for (const dir of sorted) {
      const entries: TreeEntry[] = [];
      for (const [name, ref] of ensureDir(dir)) entries.push({ mode: ref.mode, name, oid: ref.oid });
      // Subdirectories of this dir.
      for (const sub of allDirs) {
        if (sub === dir) continue;
        const parent = sub.includes('/') ? sub.slice(0, sub.lastIndexOf('/')) : '';
        if (parent !== dir) continue;
        const name = sub.slice(sub.lastIndexOf('/') + 1);
        const oid = dirOids.get(sub);
        if (oid !== undefined) entries.push({ mode: '40000', name, oid });
      }
      const oid = this.putObject(repo, 'tree', buildTree(entries));
      dirOids.set(dir, oid);
    }
    return dirOids.get('') as string;
  }

  /** Read a tree at a commit into a flat path -> {mode, data} map. */
  readFilesAtCommit(repo: Repo, commitOid: string): Map<string, { mode: string; data: Buffer }> {
    const out = new Map<string, { mode: string; data: Buffer }>();
    const commit = repo.objects.get(commitOid);
    if (commit === undefined || commit.type !== 'commit') return out;
    const treeOid = parseCommit(commit.data).tree;
    for (const [path, entry] of this.flattenTree(repo, treeOid)) {
      if (entry.type !== 'blob') continue;
      const blob = repo.objects.get(entry.oid);
      if (blob !== undefined) out.set(path, { mode: entry.mode, data: blob.data });
    }
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Contents (REST) — file commits on a branch

  /** Create a commit on `branch` applying `change` to the branch tip's tree. Returns the new commit oid. */
  commitFileChange(
    repo: Repo,
    branch: string,
    change: { path: string; data: Buffer | null; message: string },
  ): { commitSha: string; contentSha: string | null } {
    const seq = this.nextSeq();
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    const files = tip === undefined ? new Map<string, { mode: string; data: Buffer }>() : this.readFilesAtCommit(repo, tip);
    let contentSha: string | null = null;
    if (change.data === null) {
      files.delete(change.path);
    } else {
      contentSha = hashObject('blob', change.data);
      files.set(change.path, { mode: '100644', data: change.data });
    }
    const treeOid = this.buildTreeFromFiles(repo, files);
    const ident = viewerIdent(seq);
    const commitData = buildCommit({
      tree: treeOid,
      parents: tip === undefined ? [] : [tip],
      author: ident,
      committer: ident,
      message: change.message,
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(ref, commitSha);
    return { commitSha, contentSha };
  }

  // -------------------------------------------------------------------------------------------
  // Labels, issues, comments

  createLabel(repo: Repo, name: string, color: string): Label {
    const existing = repo.labels.find((l) => l.name === name);
    if (existing !== undefined) return existing;
    const label: Label = { id: repo.nextLabelId, name, color };
    repo.nextLabelId += 1;
    repo.labels.push(label);
    return label;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const issue: Issue = {
      id: this.nextObjectId,
      number: repo.nextIssueNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdSeq: this.nextSeq(),
      closedSeq: null,
    };
    this.nextObjectId += 1;
    repo.nextIssueNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  getIssue(repo: Repo, number: number): Issue | undefined {
    return repo.issues.find((i) => i.number === number);
  }

  listIssues(repo: Repo, opts: { state?: string; sort?: string; direction?: string }): Issue[] {
    let list = [...repo.issues];
    const state = opts.state ?? 'open';
    if (state !== 'all') list = list.filter((i) => i.state === state);
    const dir = opts.direction ?? 'desc';
    list.sort((a, b) => (dir === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
    return list;
  }

  createComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = { id: this.nextCommentId, body, createdSeq: this.nextSeq() };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  // -------------------------------------------------------------------------------------------
  // Pull requests

  /** Line-diff counts between two texts (LCS-based). */
  static lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
    const a = oldText === '' ? [] : oldText.split('\n');
    const b = newText === '' ? [] : newText.split('\n');
    // Drop a single trailing empty string from a trailing newline on both sides.
    if (a.length > 0 && a[a.length - 1] === '') a.pop();
    if (b.length > 0 && b[b.length - 1] === '') b.pop();
    const m = a.length;
    const n = b.length;
    // LCS via DP (files are small in the suite).
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i -= 1) {
      for (let j = n - 1; j >= 0; j -= 1) {
        dp[i]![j] = a[i] === b[j] ? (dp[i + 1]![j + 1] as number) + 1 : Math.max(dp[i + 1]![j] as number, dp[i]![j + 1] as number);
      }
    }
    const lcs = dp[0]![0] as number;
    return { additions: n - lcs, deletions: m - lcs };
  }

  /** Diff two file maps into PR file entries (sorted by path). */
  static diffFiles(
    base: Map<string, { mode: string; data: Buffer }>,
    head: Map<string, { mode: string; data: Buffer }>,
  ): PullFile[] {
    const paths = new Set([...base.keys(), ...head.keys()]);
    const out: PullFile[] = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b !== undefined && h === undefined) {
        const { deletions } = Store.lineDiff(b.data.toString('utf8'), '');
        out.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (b === undefined && h !== undefined) {
        const { additions } = Store.lineDiff('', h.data.toString('utf8'));
        out.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (b !== undefined && h !== undefined && !b.data.equals(h.data)) {
        const { additions, deletions } = Store.lineDiff(b.data.toString('utf8'), h.data.toString('utf8'));
        out.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return out;
  }

  createPull(repo: Repo, headRef: string, baseRef: string, title: string, body: string): Pull | null {
    const headSha = this.resolveRef(repo, headRef);
    const baseSha = this.resolveRef(repo, baseRef);
    if (headSha === undefined || baseSha === undefined) return null;
    const pull: Pull = {
      id: this.nextObjectId,
      number: repo.nextPullNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergeable: true,
      headRef,
      baseRef,
      headSha,
      baseSha,
      mergeCommitSha: null,
      mergedSeq: null,
      createdSeq: this.nextSeq(),
    };
    this.nextObjectId += 1;
    repo.nextPullNumber += 1;
    repo.pulls.push(pull);
    const baseFiles = this.readFilesAtCommit(repo, baseSha);
    const headFiles = this.readFilesAtCommit(repo, headSha);
    repo.pullFiles.set(pull.number, Store.diffFiles(baseFiles, headFiles));
    return pull;
  }

  getPull(repo: Repo, number: number): Pull | undefined {
    return repo.pulls.find((p) => p.number === number);
  }

  listPulls(repo: Repo, state: string): Pull[] {
    const list = [...repo.pulls];
    if (state === 'all') return list.sort((a, b) => b.createdSeq - a.createdSeq);
    return list.filter((p) => p.state === state).sort((a, b) => b.createdSeq - a.createdSeq);
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the merge commit sha, or null when
   * the pull is unknown, or 'conflict' when the head's changes conflict with the base tip.
   * Conflict rule (three-way): a path changed head-vs-merge-base that the base tip also changed
   * (to different bytes) blocks the merge.
   */
  mergePull(repo: Repo, pull: Pull): { sha: string } | 'conflict' {
    if (pull.state !== 'open') return 'conflict';
    const baseTip = this.resolveRef(repo, pull.baseRef);
    const headTip = this.resolveRef(repo, pull.headRef);
    if (baseTip === undefined || headTip === undefined) return 'conflict';
    const base = this.mergeBase(repo, headTip, baseTip);
    if (base === undefined) return 'conflict';
    const baseFiles = this.readFilesAtCommit(repo, base);
    const headFiles = this.readFilesAtCommit(repo, headTip);
    const tipFiles = this.readFilesAtCommit(repo, baseTip);
    const headDiff = Store.diffFiles(baseFiles, headFiles);
    for (const file of headDiff) {
      const atBase = baseFiles.get(file.filename);
      const atTip = tipFiles.get(file.filename);
      const changedAtTip =
        (atBase === undefined && atTip !== undefined) ||
        (atBase !== undefined && atTip === undefined) ||
        (atBase !== undefined && atTip !== undefined && !atBase.data.equals(atTip.data));
      if (!changedAtTip) continue;
      const atHead = headFiles.get(file.filename);
      const headMatchesTip =
        (atHead === undefined && atTip === undefined) ||
        (atHead !== undefined && atTip !== undefined && atHead.data.equals(atTip.data));
      if (!headMatchesTip) return 'conflict';
    }
    // Apply the head's tree onto the base tip: the squash result carries the head's files.
    const mergedFiles = new Map(tipFiles);
    for (const [path, file] of headFiles) mergedFiles.set(path, file);
    for (const file of headDiff) {
      if (file.status === 'removed') mergedFiles.delete(file.filename);
    }
    const seq = this.nextSeq();
    const treeOid = this.buildTreeFromFiles(repo, mergedFiles);
    const ident = viewerIdent(seq);
    const commitData = buildCommit({
      tree: treeOid,
      parents: [baseTip],
      author: ident,
      committer: ident,
      message: pull.title,
    });
    const mergeSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = mergeSha;
    pull.mergedSeq = seq;
    // Refresh the PR's file list against the new base (unchanged paths).
    return { sha: mergeSha };
  }

  /** Create an annotated tag object. Returns the tag oid. */
  createTag(repo: Repo, name: string, targetOid: string, targetType: GitObjectType, message: string): string {
    const seq = this.nextSeq();
    const data = buildTag({
      object: targetOid,
      type: targetType,
      tag: name,
      tagger: viewerIdent(seq),
      message,
    });
    return this.putObject(repo, 'tag', data);
  }
}

/** Extract the creation sequence from a commit's author line ("... <email> <epoch> +0000"). */
export function commitSeq(authorLine: string): number {
  const match = / (\d+) \+0000$/.exec(authorLine);
  if (match === null) return 0;
  return Number.parseInt(match[1] as string, 10) - STORE_EPOCH_SEC;
}
