// MCP endpoint (POST /mcp): JSON-RPC 2.0 over Streamable HTTP. Implemented from MCP_SPEC.md.
// Modern path only: server/discover + tools/list + tools/call over the shared store.
// Auth is per-request, before any parsing/dispatch: missing/wrong Bearer token -> 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isoAt, issueGlobalId, pullGlobalId, repoGlobalId, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { VIEWER } from './scenario.ts';

const SERVER_NAME = 'github-core-clone-01';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';
const MAX_BODY_BYTES = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// JSON shapes (mirroring the REST shapes in app.ts, same fields and values)

function userJson(login: string, id: number): Record<string, unknown> {
  return { login, id, type: 'User', avatar_url: '', html_url: `https://github.com/${login}`, url: `/api/v3/users/${login}` };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: repoGlobalId(repo.owner, repo.name),
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(repo.owner, VIEWER.id),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.fullName}`,
    url: `/api/v3/repos/${repo.fullName}`,
    created_at: isoAt(repo.createdSeq),
    updated_at: isoAt(repo.createdSeq),
    pushed_at: isoAt(repo.createdSeq),
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    fork: false,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: issueGlobalId(repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.find((l) => l.name === name);
      return label === undefined
        ? { name, color: 'ededed' }
        : {
            id: label.id,
            node_id: Buffer.from(`Label:${repo.owner}/${repo.name}#${label.name}`, 'utf8').toString('base64url'),
            name: label.name,
            color: label.color,
            description: '',
            default: false,
            url: `/api/v3/repos/${repo.fullName}/labels/${encodeURIComponent(label.name)}`,
          };
    }),
    user: userJson(repo.owner, VIEWER.id),
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: isoAt(issue.createdSeq),
    updated_at: isoAt(issue.closedSeq ?? issue.createdSeq),
    closed_at: issue.closedSeq === null ? null : isoAt(issue.closedSeq),
    html_url: `https://github.com/${repo.fullName}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.fullName}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: pullGlobalId(repo.owner, repo.name, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable: pull.mergeable,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedSeq === null ? null : isoAt(pull.mergedSeq),
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: userJson(repo.owner, VIEWER.id),
    assignee: null,
    assignees: [],
    created_at: isoAt(pull.createdSeq),
    updated_at: isoAt(pull.mergedSeq ?? pull.createdSeq),
    closed_at: pull.state === 'closed' && pull.mergedSeq !== null ? isoAt(pull.mergedSeq) : null,
    html_url: `https://github.com/${repo.fullName}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.fullName}/pulls/${pull.number}`,
  };
}

// ---------------------------------------------------------------------------------------------
// Tool list: a compile-time constant (fixed order, fixed key order, no state-derived values).

const TOOLS: readonly Record<string, unknown>[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'open, closed, or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        body: { type: 'string', description: 'Pull request body' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'integer', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Helpers

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

/** Read the whole request body (up to MAX_BODY_BYTES). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(header);
  return match === null ? null : (match[1] as string);
}

function isAuthenticated(req: IncomingMessage): boolean {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const token = bearerToken(req);
  if (token === null) return false;
  if (expected === '') return true;
  return token === expected;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArg(args: Record<string, unknown>, field: string): string | null {
  const value = args[field];
  return typeof value === 'string' ? value : null;
}

/** Missing required string args (absent, null, or wrong-typed). */
function missingStrings(args: Record<string, unknown>, fields: readonly string[]): string[] {
  return fields.filter((f) => {
    const value = args[f];
    return typeof value !== 'string' || value === '';
  });
}

/** Resolve owner/repo from args; null when either is missing/invalid. */
function resolveRepoArgs(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const owner = stringArg(args, 'owner');
  const repo = stringArg(args, 'repo');
  if (owner === null || owner === '' || repo === null || repo === '') return null;
  return { owner, repo };
}

// ---------------------------------------------------------------------------------------------
// Tool dispatch. Throws a ToolError (answered as JSON-RPC -32602) on any tool failure.

class ToolError extends Error {}

function callTool(store: Store, name: string, args: Record<string, unknown>): unknown {
  switch (name) {
    case 'create_repo': {
      const missing = missingStrings(args, ['name']);
      if (missing.length > 0) throw new ToolError(`create_repo: missing required argument(s): ${missing.join(', ')}`);
      const repoName = stringArg(args, 'name') as string;
      const description = typeof args.description === 'string' ? args.description : '';
      const isPrivate = typeof args.private === 'boolean' ? args.private : false;
      // Always create under the token login, never under a different owner from an argument.
      const repo = store.createRepo(VIEWER.login, repoName, { private: isPrivate, description });
      if (repo === null) throw new ToolError(`create_repo: repository ${VIEWER.login}/${repoName} already exists`);
      return repoJson(repo);
    }
    case 'get_repo': {
      const missing = missingStrings(args, ['owner', 'repo']);
      if (missing.length > 0) throw new ToolError(`get_repo: missing required argument(s): ${missing.join(', ')}`);
      const target = resolveRepoArgs(args) as { owner: string; repo: string };
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) throw new ToolError(`get_repo: repository ${target.owner}/${target.repo} not found`);
      return repoJson(repo);
    }
    case 'create_issue': {
      const missing = missingStrings(args, ['owner', 'repo', 'title']);
      if (missing.length > 0) throw new ToolError(`create_issue: missing required argument(s): ${missing.join(', ')}`);
      const target = resolveRepoArgs(args) as { owner: string; repo: string };
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) throw new ToolError(`create_issue: repository ${target.owner}/${target.repo} not found`);
      const title = stringArg(args, 'title') as string;
      const body = typeof args.body === 'string' ? args.body : '';
      const issue = store.createIssue(repo, title, body, []);
      return issueJson(repo, issue);
    }
    case 'list_issues': {
      const missing = missingStrings(args, ['owner', 'repo']);
      if (missing.length > 0) throw new ToolError(`list_issues: missing required argument(s): ${missing.join(', ')}`);
      const target = resolveRepoArgs(args) as { owner: string; repo: string };
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) throw new ToolError(`list_issues: repository ${target.owner}/${target.repo} not found`);
      const state = typeof args.state === 'string' && args.state !== '' ? args.state : 'all';
      const issues = store.listIssues(repo, { state });
      return issues.map((issue) => issueJson(repo, issue));
    }
    case 'create_pull_request': {
      const missing = missingStrings(args, ['owner', 'repo', 'title', 'head', 'base']);
      if (missing.length > 0) throw new ToolError(`create_pull_request: missing required argument(s): ${missing.join(', ')}`);
      const target = resolveRepoArgs(args) as { owner: string; repo: string };
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) throw new ToolError(`create_pull_request: repository ${target.owner}/${target.repo} not found`);
      const title = stringArg(args, 'title') as string;
      const body = typeof args.body === 'string' ? args.body : '';
      const head = stringArg(args, 'head') as string;
      const base = stringArg(args, 'base') as string;
      const pull = store.createPull(repo, head, base, title, body);
      if (pull === null) throw new ToolError('create_pull_request: head or base branch does not exist');
      return pullJson(repo, pull);
    }
    case 'merge_pull_request': {
      const missing = missingStrings(args, ['owner', 'repo']);
      const rawNumber = args.pull_number;
      const pullNumber =
        typeof rawNumber === 'number' && Number.isSafeInteger(rawNumber)
          ? rawNumber
          : typeof rawNumber === 'string' && /^\d+$/.test(rawNumber)
            ? Number.parseInt(rawNumber, 10)
            : null;
      if (missing.length > 0 || pullNumber === null) {
        const fields = pullNumber === null ? [...missing, 'pull_number'] : missing;
        throw new ToolError(`merge_pull_request: missing required argument(s): ${fields.join(', ')}`);
      }
      const target = resolveRepoArgs(args) as { owner: string; repo: string };
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) throw new ToolError(`merge_pull_request: repository ${target.owner}/${target.repo} not found`);
      const pull = store.getPull(repo, pullNumber);
      if (pull === undefined) throw new ToolError(`merge_pull_request: pull request #${pullNumber} not found`);
      if (pull.state !== 'open' || pull.merged) throw new ToolError(`merge_pull_request: pull request #${pullNumber} is already merged or closed`);
      const result = store.mergePull(repo, pull);
      if (result === 'conflict') throw new ToolError(`merge_pull_request: pull request #${pullNumber} has a merge conflict`);
      return pullJson(repo, pull);
    }
    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------------------------
// Handler

export async function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  if ((req.method ?? 'GET') !== 'POST') {
    res.writeHead(405, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ message: 'Method Not Allowed' }));
    return;
  }

  // Auth first, before parsing the body: missing/wrong token -> 401.
  if (!isAuthenticated(req)) {
    sendJson(res, 401, rpcError(null, -32001, 'Unauthorized'));
    return;
  }

  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error: request body too large'));
    return;
  }

  let request: unknown;
  try {
    request = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error: body is not valid JSON'));
    return;
  }

  if (!isRecord(request)) {
    sendJson(res, 200, rpcError(null, -32600, 'Invalid Request: expected a JSON-RPC object'));
    return;
  }

  const method = request.method;
  if (typeof method !== 'string' || method === '') {
    sendJson(res, 200, rpcError(request.id ?? null, -32600, 'Invalid Request: missing method'));
    return;
  }

  // Notifications carry no id: never send a JSON-RPC response for one.
  if (!('id' in request) || request.id === undefined) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end();
    return;
  }
  const id: unknown = request.id;
  const params = isRecord(request.params) ? request.params : {};

  switch (method) {
    case 'server/discover': {
      const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
      sendJson(
        res,
        200,
        rpcResult(id, {
          supportedVersions: [PROTOCOL_VERSION],
          capabilities: { tools: {} },
          serverInfo,
          _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
        }),
      );
      return;
    }
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' && params.protocolVersion !== '' ? params.protocolVersion : PROTOCOL_VERSION;
      sendJson(
        res,
        200,
        rpcResult(id, {
          protocolVersion: offered,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        }),
      );
      return;
    }
    case 'tools/list': {
      sendJson(res, 200, rpcResult(id, { tools: TOOLS }));
      return;
    }
    case 'tools/call': {
      const name = params.name;
      const args = isRecord(params.arguments) ? params.arguments : {};
      if (typeof name !== 'string' || name === '') {
        sendJson(res, 200, rpcError(id, -32602, 'tools/call: missing required argument: name'));
        return;
      }
      try {
        const value = callTool(store, name, args);
        sendJson(res, 200, rpcResult(id, toolResult(value)));
      } catch (err) {
        if (err instanceof ToolError) {
          sendJson(res, 200, rpcError(id, -32602, err.message));
        } else {
          // Never surface a bare 500 for a client-caused error.
          sendJson(res, 200, rpcError(id, -32602, err instanceof Error ? err.message : 'Tool call failed'));
        }
      }
      return;
    }
    default: {
      sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
      return;
    }
  }
}
