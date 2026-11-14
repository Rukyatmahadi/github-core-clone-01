// GraphQL v4 endpoint (POST /api/graphql). Implemented from GRAPHQL_SPEC.md.
// Hand-rolled executor over the shared store: no GraphQL library, stdlib only.
// Documents supported: named/anonymous query+mutation operations, variables, aliases,
// inline fragments (... on Type), input objects, enum literals, lists, __type introspection,
// batched array bodies. Unknown field -> HTTP 200 + errors[] naming the field.
// Unknown repo/issue/PR -> null, no errors. Missing/wrong token -> 401.
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Store,
  decodeGlobalId,
  repoGlobalId,
  issueGlobalId,
  pullGlobalId,
  commentGlobalId,
  isoAt,
} from './store.ts';
import type { Repo, Issue, Pull } from './store.ts';
import { VIEWER } from './scenario.ts';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
let requestSeq = 0;

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  requestSeq += 1;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': `req-${requestSeq}`,
  });
  res.end(text);
}

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

// ---------------------------------------------------------------------------------------------
// Tokenizer

interface Token {
  kind: 'name' | 'string' | 'int' | 'float' | 'punct' | 'ellipsis';
  value: string;
  line: number;
  column: number;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  let col = 1;
  const advance = (n = 1): void => {
    for (let k = 0; k < n; k += 1) {
      if (source[i] === '\n') {
        line += 1;
        col = 1;
      } else {
        col += 1;
      }
      i += 1;
    }
  };
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n' || ch === ',') {
      advance();
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') advance();
      continue;
    }
    if (ch === '.' && source[i + 1] === '.' && source[i + 2] === '.') {
      tokens.push({ kind: 'ellipsis', value: '...', line, column: col });
      advance(3);
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch, line, column: col });
      advance();
      continue;
    }
    if (ch === '"') {
      // Block string """...""" or regular "...".
      const startLine = line;
      const startCol = col;
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const raw = end === -1 ? source.slice(i + 3) : source.slice(i + 3, end);
        for (const c of raw) advance();
        if (end !== -1) advance(3);
        tokens.push({ kind: 'string', value: raw, line: startLine, column: startCol });
        continue;
      }
      advance();
      let value = '';
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\') {
          const esc = source[i + 1] as string;
          advance(2);
          if (esc === 'n') value += '\n';
          else if (esc === 't') value += '\t';
          else if (esc === 'r') value += '\r';
          else if (esc === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(i, i + 4), 16));
            advance(4);
          } else value += esc;
        } else {
          value += source[i];
          advance();
        }
      }
      if (source[i] === '"') advance();
      tokens.push({ kind: 'string', value, line: startLine, column: startCol });
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(source[i + 1] as string))) {
      const startLine = line;
      const startCol = col;
      let num = '';
      let isFloat = false;
      while (i < source.length && /[0-9.eE+-]/.test(source[i] as string)) {
        const c = source[i] as string;
        if (c === '.' || c === 'e' || c === 'E') isFloat = true;
        // A '-' or '+' is only part of the number right after e/E.
        if ((c === '-' || c === '+') && !/[eE]/.test(source[i - 1] as string)) break;
        num += c;
        advance();
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: num, line: startLine, column: startCol });
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const startLine = line;
      const startCol = col;
      let name = '';
      while (i < source.length && /[_A-Za-z0-9]/.test(source[i] as string)) {
        name += source[i];
        advance();
      }
      tokens.push({ kind: 'name', value: name, line: startLine, column: startCol });
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} at ${line}:${col}`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Parser: documents -> operations

type ValueNode =
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'variable'; name: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  alias: string | null;
  name: string;
  args: { name: string; value: ValueNode }[];
  selections: SelectionNode[] | null;
  line: number;
  column: number;
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; typeCondition: string; selections: SelectionNode[] };

interface Operation {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefs: { name: string; defaultValue: ValueNode | null }[];
  selections: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const tok = this.tokens[this.pos];
    if (tok === undefined) throw new Error('Unexpected end of document');
    this.pos += 1;
    return tok;
  }

  private expectPunct(value: string): Token {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) {
      throw new Error(`Expected '${value}' but got '${tok.value}' at ${tok.line}:${tok.column}`);
    }
    return tok;
  }

  private expectName(value?: string): Token {
    const tok = this.next();
    if (tok.kind !== 'name' || (value !== undefined && tok.value !== value)) {
      throw new Error(`Expected name${value === undefined ? '' : ` '${value}'`} but got '${tok.value}' at ${tok.line}:${tok.column}`);
    }
    return tok;
  }

  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.peek() !== undefined) {
      ops.push(this.parseOperation());
    }
    if (ops.length === 0) throw new Error('Empty document');
    return ops;
  }

  private parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    const first = this.peek() as Token;
    if (first.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      kind = first.value;
      this.next();
    } else if (first.kind === 'punct' && first.value === '{') {
      // Anonymous query.
    } else if (first.kind === 'name' && first.value === 'subscription') {
      throw new Error('Subscriptions are not supported');
    } else {
      throw new Error(`Unexpected token '${first.value}' at ${first.line}:${first.column}`);
    }
    let name: string | null = null;
    const maybeName = this.peek();
    if (maybeName !== undefined && maybeName.kind === 'name') {
      name = this.next().value;
    }
    const varDefs: Operation['varDefs'] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName().value;
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | null = null;
        if (this.peek()?.kind === 'punct' && this.peek()?.value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        varDefs.push({ name: varName, defaultValue });
      }
      this.expectPunct(')');
    }
    const selections = this.parseSelectionSet();
    return { kind, name, varDefs, selections };
  }

  /** Consume a type reference (e.g. String!, [IssueState!], CreateIssueInput!). */
  private parseType(): void {
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      if (this.peek() === undefined) throw new Error('Unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const tok = this.peek() as Token;
    if (tok.kind === 'ellipsis') {
      this.next();
      const next = this.peek() as Token;
      if (next.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName().value;
        const selections = this.parseSelectionSet();
        return { kind: 'fragment', typeCondition, selections };
      }
      throw new Error(`Named fragments are not supported (at ${tok.line}:${tok.column})`);
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first.value;
    let line = first.line;
    let column = first.column;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      const real = this.expectName();
      alias = name;
      name = real.value;
      line = real.line;
      column = real.column;
    }
    const args: FieldNode['args'] = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName().value;
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selections: SelectionNode[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { kind: 'field', field: { alias, name, args, selections, line, column } };
  }

  private parseValue(): ValueNode {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') {
      return { kind: 'variable', name: this.expectName().value };
    }
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'int') return { kind: 'int', value: Number.parseInt(tok.value, 10) };
    if (tok.kind === 'float') return { kind: 'float', value: Number.parseFloat(tok.value) };
    if (tok.kind === 'punct' && tok.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) {
        items.push(this.parseValue());
      }
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const name = this.expectName().value;
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error(`Unexpected value token '${tok.value}' at ${tok.line}:${tok.column}`);
  }
}

/** Resolve a parsed value against the operation's variables. */
function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'variable':
      return variables[node.name] ?? null;
    case 'list':
      return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Schema model: field sets (validation + __type introspection) and child types.

const TYPE_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'avatarUrl', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private',
    'createdAt', 'updatedAt', 'url',
  ],
  Ref: ['name', 'target'],
  GitObject: ['oid'],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'closedAt',
    'comments', 'labels', 'url',
  ],
  Label: ['id', 'name', 'color', 'description', 'url'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  CommentEdge: ['node', 'cursor'],
  PullRequest: [
    'id', 'number', 'title', 'state', 'body', 'headRefName', 'baseRefName', 'mergeable', 'merged',
    'files', 'author', 'createdAt', 'mergedAt', 'url',
  ],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileEdge: ['node', 'cursor'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes', 'status'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'comment', 'clientMutationId'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues'],
  __Field: ['name', 'description', 'args', 'type'],
  __EnumValue: ['name', 'description'],
};

const TYPE_ENUM_VALUES: Record<string, readonly string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
};

/** parentType.field -> child object type (for nested selections; lists use the item type). */
const FIELD_TYPES: Record<string, string> = {
  'Query.viewer': 'User',
  'Query.repository': 'Repository',
  'Query.__type': '__Type',
  'Repository.owner': 'User',
  'Repository.defaultBranchRef': 'Ref',
  'Repository.issue': 'Issue',
  'Repository.issues': 'IssueConnection',
  'Repository.pullRequests': 'PullRequestConnection',
  'Repository.pullRequest': 'PullRequest',
  'Ref.target': 'GitObject',
  'Issue.author': 'User',
  'Issue.comments': 'IssueCommentConnection',
  'Issue.labels': 'Label',
  'IssueConnection.nodes': 'Issue',
  'IssueConnection.edges': 'IssueEdge',
  'IssueConnection.pageInfo': 'PageInfo',
  'IssueEdge.node': 'Issue',
  'IssueCommentConnection.nodes': 'IssueComment',
  'IssueCommentConnection.edges': 'CommentEdge',
  'IssueCommentConnection.pageInfo': 'PageInfo',
  'CommentEdge.node': 'IssueComment',
  'IssueComment.author': 'User',
  'PullRequest.author': 'User',
  'PullRequest.files': 'PullRequestChangedFileConnection',
  'PullRequestConnection.nodes': 'PullRequest',
  'PullRequestConnection.edges': 'PullRequestEdge',
  'PullRequestConnection.pageInfo': 'PageInfo',
  'PullRequestEdge.node': 'PullRequest',
  'PullRequestChangedFileConnection.nodes': 'PullRequestChangedFile',
  'PullRequestChangedFileConnection.edges': 'PullRequestChangedFileEdge',
  'PullRequestChangedFileConnection.pageInfo': 'PageInfo',
  'PullRequestChangedFileEdge.node': 'PullRequestChangedFile',
  'CreateIssuePayload.issue': 'Issue',
  'CloseIssuePayload.issue': 'Issue',
  'CreatePullRequestPayload.pullRequest': 'PullRequest',
  'MergePullRequestPayload.pullRequest': 'PullRequest',
  'AddCommentPayload.commentEdge': 'CommentEdge',
  'AddCommentPayload.comment': 'IssueComment',
  '__Type.fields': '__Field',
  '__Type.enumValues': '__EnumValue',
};

const NODE_TYPES = new Set(['Repository', 'Issue', 'PullRequest', 'IssueComment']);

/** A node() result carries its runtime type so fragments and fields resolve on the right type. */
interface NodeWrapper {
  __nodeType: string;
  target: unknown;
}

/** Unwrap a node() result (or any value) to the underlying store object. */
function unwrap(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && '__nodeType' in (value as Record<string, unknown>)) {
    return (value as NodeWrapper).target;
  }
  return value;
}

// ---------------------------------------------------------------------------------------------
// Cursors: opaque base64url of "IssueCursor:<number>" (exclusive resume).

function encodeCursor(number: number): string {
  return Buffer.from(`IssueCursor:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^IssueCursor:(\d+)$/.exec(text);
    return match === null ? null : Number.parseInt(match[1] as string, 10);
  } catch {
    return null;
  }
}

interface PageInfoValue {
  hasNextPage: boolean;
  hasPreviousPage: boolean;
  startCursor: string | null;
  endCursor: string | null;
}

interface ConnectionValue<T> {
  nodes: T[];
  edges: { node: T; cursor: string }[];
  pageInfo: PageInfoValue;
  totalCount: number;
}

/** Build a Relay connection page from an ordered list, keyed by issue/PR number. */
function paginate<T extends { number: number }>(
  ordered: readonly T[],
  args: Record<string, unknown>,
): ConnectionValue<T> {
  let start = 0;
  const after = args.after;
  if (typeof after === 'string' && after !== '') {
    const num = decodeCursor(after);
    if (num !== null) {
      const idx = ordered.findIndex((item) => item.number === num);
      if (idx >= 0) start = idx + 1;
    }
  }
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : ordered.length - start;
  const page = ordered.slice(start, start + first);
  return {
    nodes: [...page],
    edges: page.map((item) => ({ node: item, cursor: encodeCursor(item.number) })),
    pageInfo: {
      hasNextPage: start + page.length < ordered.length,
      hasPreviousPage: start > 0,
      startCursor: page.length > 0 ? encodeCursor((page[0] as T).number) : null,
      endCursor: page.length > 0 ? encodeCursor((page[page.length - 1] as T).number) : null,
    },
    totalCount: ordered.length,
  };
}

/** Order + filter a repo's issues per the issues(first, after, states, orderBy) arguments. */
function issuesConnection(repo: Repo, args: Record<string, unknown>): ConnectionValue<Record<string, unknown>> {
  let list = [...repo.issues];
  const states = args.states;
  if (Array.isArray(states)) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    list = list.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const dir = orderBy.direction === 'ASC' ? 1 : -1;
  // CREATED_AT DESC == number DESC here (numbers are assigned sequentially at creation).
  list.sort((a, b) => dir * (a.createdSeq - b.createdSeq) || dir * (a.number - b.number));
  const page = paginate(list, args);
  const wrap = (issue: Issue): Record<string, unknown> => ({ __nodeType: 'Issue', target: issue, repo });
  return {
    nodes: page.nodes.map(wrap),
    edges: page.edges.map((edge) => ({ node: wrap(edge.node), cursor: edge.cursor })),
    pageInfo: page.pageInfo,
    totalCount: page.totalCount,
  };
}

function pullsConnection(repo: Repo, args: Record<string, unknown>): ConnectionValue<Record<string, unknown>> {
  const list = [...repo.pulls].sort((a, b) => b.createdSeq - a.createdSeq || b.number - a.number);
  const page = paginate(list, args);
  const wrap = (pull: Pull): Record<string, unknown> => ({ __nodeType: 'PullRequest', target: pull, repo });
  return {
    nodes: page.nodes.map(wrap),
    edges: page.edges.map((edge) => ({ node: wrap(edge.node), cursor: edge.cursor })),
    pageInfo: page.pageInfo,
    totalCount: page.totalCount,
  };
}

function commentsConnection(repo: Repo, issue: Issue, args: Record<string, unknown>): ConnectionValue<Record<string, unknown>> {
  const nodes = issue.comments.map((comment) => ({
    __nodeType: 'IssueComment',
    repo,
    issue,
    comment,
  }));
  const list = [...nodes].sort((a, b) => (a.comment as { createdSeq: number }).createdSeq - (b.comment as { createdSeq: number }).createdSeq);
  // Comments are identified by their store id, not a number; paginate by position instead.
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : list.length;
  const page = list.slice(0, first);
  return {
    nodes: page as unknown as Record<string, unknown>[],
    edges: page.map((item) => ({ node: item as unknown as Record<string, unknown>, cursor: '' })),
    pageInfo: { hasNextPage: page.length < list.length, hasPreviousPage: false, startCursor: null, endCursor: null },
    totalCount: list.length,
  };
}

function filesConnection(repo: Repo, pull: Pull, args: Record<string, unknown>): ConnectionValue<Record<string, unknown>> {
  const files = repo.pullFiles.get(pull.number) ?? [];
  const nodes = files.map((f) => ({
    path: f.filename,
    additions: f.additions,
    deletions: f.deletions,
    changes: f.changes,
    status: f.status.toUpperCase(),
  }));
  const first = typeof args.first === 'number' && args.first >= 0 ? args.first : nodes.length;
  const page = nodes.slice(0, first);
  return {
    nodes: page as unknown as Record<string, unknown>[],
    edges: page.map((item) => ({ node: item as unknown as Record<string, unknown>, cursor: '' })),
    pageInfo: { hasNextPage: page.length < nodes.length, hasPreviousPage: false, startCursor: null, endCursor: null },
    totalCount: nodes.length,
  };
}

/**
 * Mergeability of an open PR, computed from the git store like store.mergePull's conflict rule:
 * a path the head changed vs the merge-base that the base tip also changed differently conflicts.
 */
function computeMergeable(store: Store, repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const baseTip = store.resolveRef(repo, pull.baseRef);
  const headTip = store.resolveRef(repo, pull.headRef);
  if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
  const base = store.mergeBase(repo, headTip, baseTip);
  if (base === undefined) return 'UNKNOWN';
  const baseFiles = store.readFilesAtCommit(repo, base);
  const headFiles = store.readFilesAtCommit(repo, headTip);
  const tipFiles = store.readFilesAtCommit(repo, baseTip);
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
    if (!headMatchesTip) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

// ---------------------------------------------------------------------------------------------
// Executor

interface GraphQLError {
  message: string;
  path?: (string | number)[];
  locations?: { line: number; column: number }[];
}

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
}

class FieldError extends Error {}

function childTypeOf(parentType: string, fieldName: string, value: unknown): string | null {
  if (typeof value === 'object' && value !== null) {
    const rec = value as Record<string, unknown>;
    if (typeof rec.__nodeType === 'string') return rec.__nodeType as string;
    if (typeof rec.__gqlType === 'string') return rec.__gqlType as string;
  }
  return FIELD_TYPES[`${parentType}.${fieldName}`] ?? null;
}

function executeSelections(
  parentType: string,
  parent: unknown,
  selections: SelectionNode[],
  ctx: ExecContext,
  path: (string | number)[],
  errors: GraphQLError[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      const applies =
        selection.typeCondition === parentType ||
        (selection.typeCondition === 'Node' && NODE_TYPES.has(parentType));
      if (!applies) continue;
      Object.assign(out, executeSelections(parentType, parent, selection.selections, ctx, path, errors));
      continue;
    }
    const field = selection.field;
    const responseKey = field.alias ?? field.name;
    const known = TYPE_FIELDS[parentType];
    if (known === undefined || !known.includes(field.name)) {
      errors.push({
        message: `Field '${field.name}' doesn't exist on type '${parentType}'`,
        path: [...path, responseKey],
        locations: [{ line: field.line, column: field.column }],
      });
      continue;
    }
    try {
      out[responseKey] = executeField(parentType, parent, field, ctx, [...path, responseKey], errors);
    } catch (err) {
      if (err instanceof FieldError) {
        errors.push({ message: err.message, path: [...path, responseKey] });
        out[responseKey] = null;
      } else {
        throw err;
      }
    }
  }
  return out;
}

function executeField(
  parentType: string,
  parent: unknown,
  field: FieldNode,
  ctx: ExecContext,
  path: (string | number)[],
  errors: GraphQLError[],
): unknown {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = resolveValue(arg.value, ctx.variables);
  const value = resolveField(parentType, parent, field.name, args, ctx);
  if (value === null || value === undefined) return null;
  if (field.selections === null || field.selections.length === 0) return value;
  if (Array.isArray(value)) {
    const itemType = FIELD_TYPES[`${parentType}.${field.name}`];
    if (itemType === undefined) return value;
    return value.map((item, index) =>
      item === null ? null : executeSelections(itemType, item, field.selections as SelectionNode[], ctx, [...path, index], errors),
    );
  }
  const childType = childTypeOf(parentType, field.name, value);
  if (childType === null) return value;
  return executeSelections(childType, value, field.selections, ctx, path, errors);
}

/** The viewer as a User object. */
function userValue(login: string, id: number): Record<string, unknown> {
  return { __gqlType: 'User', login, id, name: login === VIEWER.login ? VIEWER.name : login };
}

function repoRefValue(repo: Repo): Record<string, unknown> | null {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (tip === undefined) return null;
  return { __gqlType: 'Ref', name: repo.defaultBranch, oid: tip };
}

function resolveField(
  parentType: string,
  parent: unknown,
  fieldName: string,
  args: Record<string, unknown>,
  ctx: ExecContext,
): unknown {
  const store = ctx.store;
  const raw = unwrap(parent);

  if (parentType === 'Query') {
    if (fieldName === 'viewer') return userValue(VIEWER.login, VIEWER.id);
    if (fieldName === 'repository') {
      const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo ?? null;
    }
    if (fieldName === 'node') {
      const decoded = decodeGlobalId(String(args.id ?? ''));
      if (decoded === null) return null;
      const repo = store.getRepo(decoded.owner, decoded.name);
      if (repo === undefined) return null;
      if (decoded.kind === 'Repository') return { __nodeType: 'Repository', target: repo };
      if (decoded.kind === 'Issue') {
        const issue = store.getIssue(repo, decoded.number);
        return issue === undefined ? null : { __nodeType: 'Issue', target: issue, repo };
      }
      if (decoded.kind === 'PullRequest') {
        const pull = store.getPull(repo, decoded.number);
        return pull === undefined ? null : { __nodeType: 'PullRequest', target: pull, repo };
      }
      if (decoded.kind === 'IssueComment') {
        const issue = store.getIssue(repo, decoded.number);
        const comment = issue?.comments.find((c) => c.id === decoded.commentId);
        return comment === undefined || issue === undefined
          ? null
          : { __nodeType: 'IssueComment', target: comment, repo, issue };
      }
      return null;
    }
    if (fieldName === '__type') {
      const name = String(args.name ?? '');
      if (TYPE_FIELDS[name] !== undefined) {
        return { __gqlType: '__Type', name, kind: 'OBJECT', fields: [...(TYPE_FIELDS[name] as readonly string[])], enumValues: null };
      }
      if (TYPE_ENUM_VALUES[name] !== undefined) {
        return { __gqlType: '__Type', name, kind: 'ENUM', fields: null, enumValues: [...(TYPE_ENUM_VALUES[name] as readonly string[])] };
      }
      return null;
    }
    if (fieldName === '__schema') return null;
    return null;
  }

  if (parentType === 'Mutation') {
    if (fieldName === 'createIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'Repository') throw new FieldError('repositoryId does not name a repository');
      const repo = store.getRepo(decoded.owner, decoded.name);
      if (repo === undefined) throw new FieldError('repository not found');
      const issue = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return { __gqlType: 'CreateIssuePayload', issue: { __nodeType: 'Issue', target: issue, repo }, repo };
    }
    if (fieldName === 'closeIssue') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (decoded === null || decoded.kind !== 'Issue') throw new FieldError('issueId does not name an issue');
      const repo = store.getRepo(decoded.owner, decoded.name);
      const issue = repo === undefined ? undefined : store.getIssue(repo, decoded.number);
      if (repo === undefined || issue === undefined) throw new FieldError('issue not found');
      issue.state = 'closed';
      issue.closedSeq = store.nextSeq();
      return { __gqlType: 'CloseIssuePayload', issue: { __nodeType: 'Issue', target: issue, repo }, repo };
    }
    if (fieldName === 'createPullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      if (decoded === null || decoded.kind !== 'Repository') throw new FieldError('repositoryId does not name a repository');
      const repo = store.getRepo(decoded.owner, decoded.name);
      if (repo === undefined) throw new FieldError('repository not found');
      const pull = store.createPull(
        repo,
        String(input.headRefName ?? ''),
        String(input.baseRefName ?? ''),
        String(input.title ?? ''),
        String(input.body ?? ''),
      );
      if (pull === null) throw new FieldError('head or base branch does not exist');
      return { __gqlType: 'CreatePullRequestPayload', pullRequest: { __nodeType: 'PullRequest', target: pull, repo }, repo };
    }
    if (fieldName === 'mergePullRequest') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (decoded === null || decoded.kind !== 'PullRequest') throw new FieldError('pullRequestId does not name a pull request');
      const repo = store.getRepo(decoded.owner, decoded.name);
      const pull = repo === undefined ? undefined : store.getPull(repo, decoded.number);
      if (repo === undefined || pull === undefined) throw new FieldError('pull request not found');
      // mergeMethod is accepted (SQUASH is the asserted one); the store squash-merges.
      const result = store.mergePull(repo, pull);
      if (result === 'conflict') throw new FieldError('Pull request cannot be merged (conflict or already merged)');
      return { __gqlType: 'MergePullRequestPayload', pullRequest: { __nodeType: 'PullRequest', target: pull, repo }, repo };
    }
    if (fieldName === 'addComment') {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (decoded === null || decoded.kind !== 'Issue') throw new FieldError('subjectId does not name an issue');
      const repo = store.getRepo(decoded.owner, decoded.name);
      const issue = repo === undefined ? undefined : store.getIssue(repo, decoded.number);
      if (repo === undefined || issue === undefined) throw new FieldError('issue not found');
      const comment = store.createComment(repo, issue, String(input.body ?? ''));
      const node = { __nodeType: 'IssueComment', target: comment, repo, issue };
      return { __gqlType: 'AddCommentPayload', commentEdge: { __gqlType: 'CommentEdge', node, cursor: '' }, comment: node };
    }
    return null;
  }

  if (parentType === 'Repository') {
    const repo = raw as Repo;
    switch (fieldName) {
      case 'id': return repoGlobalId(repo.owner, repo.name);
      case 'databaseId': return repo.id;
      case 'name': return repo.name;
      case 'nameWithOwner': return repo.fullName;
      case 'owner': return userValue(repo.owner, VIEWER.id);
      case 'defaultBranchRef': return repoRefValue(repo);
      case 'viewerPermission': return 'ADMIN';
      case 'hasIssuesEnabled': return true;
      case 'description': return repo.description;
      case 'private': return repo.private;
      case 'createdAt': return isoAt(repo.createdSeq);
      case 'updatedAt': return isoAt(repo.createdSeq);
      case 'url': return `/api/v3/repos/${repo.fullName}`;
      case 'issue': {
        const issue = store.getIssue(repo, Number(args.number ?? 0));
        return issue === undefined ? null : { __nodeType: 'Issue', target: issue, repo };
      }
      case 'issues': return issuesConnection(repo, args);
      case 'pullRequests': return pullsConnection(repo, args);
      case 'pullRequest': {
        const pull = store.getPull(repo, Number(args.number ?? 0));
        return pull === undefined ? null : { __nodeType: 'PullRequest', target: pull, repo };
      }
      default: return null;
    }
  }

  if (parentType === 'Ref') {
    const ref = raw as { name: string; oid: string };
    if (fieldName === 'name') return ref.name;
    if (fieldName === 'target') return { __gqlType: 'GitObject', oid: ref.oid };
    return null;
  }

  if (parentType === 'GitObject') {
    if (fieldName === 'oid') return (raw as { oid: string }).oid;
    return null;
  }

  if (parentType === 'User') {
    const user = raw as { login: string; id: number; name: string };
    if (fieldName === 'login') return user.login;
    if (fieldName === 'id') return user.id;
    if (fieldName === 'name') return user.name;
    if (fieldName === 'avatarUrl') return '';
    if (fieldName === 'url') return `https://github.com/${user.login}`;
    return null;
  }

  if (parentType === 'Issue') {
    const issue = raw as Issue;
    const ownerRepo = (parent as Record<string, unknown>).repo as Repo | undefined;
    switch (fieldName) {
      case 'id': {
        const r = ownerRepo;
        return r === undefined ? '' : issueGlobalId(r.owner, r.name, issue.number);
      }
      case 'number': return issue.number;
      case 'title': return issue.title;
      case 'state': return issueState(issue);
      case 'body': return issue.body;
      case 'author': return userValue(ownerRepo?.owner ?? VIEWER.login, VIEWER.id);
      case 'createdAt': return isoAt(issue.createdSeq);
      case 'updatedAt': return isoAt(issue.closedSeq ?? issue.createdSeq);
      case 'closedAt': return issue.closedSeq === null ? null : isoAt(issue.closedSeq);
      case 'comments': return ownerRepo === undefined ? { nodes: [], edges: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: 0 } : commentsConnection(ownerRepo, issue, args);
      case 'labels': return issue.labels.map((name) => ({ __gqlType: 'Label', name, color: 'ededed' }));
      case 'url': return ownerRepo === undefined ? '' : `https://github.com/${ownerRepo.fullName}/issues/${issue.number}`;
      default: return null;
    }
  }

  if (parentType === 'IssueComment') {
    const holder = parent as Record<string, unknown>;
    const comment = (holder.target ?? raw) as { id: number; body: string; createdSeq: number };
    const repo = holder.repo as Repo | undefined;
    const issue = holder.issue as Issue | undefined;
    switch (fieldName) {
      case 'id':
        return repo !== undefined && issue !== undefined
          ? commentGlobalId(repo.owner, repo.name, issue.number, comment.id)
          : '';
      case 'body': return comment.body;
      case 'author': return userValue(repo?.owner ?? VIEWER.login, VIEWER.id);
      case 'createdAt': return isoAt(comment.createdSeq);
      case 'updatedAt': return isoAt(comment.createdSeq);
      case 'url': return repo !== undefined && issue !== undefined ? `https://github.com/${repo.fullName}/issues/${issue.number}#issuecomment-${comment.id}` : '';
      default: return null;
    }
  }

  if (parentType === 'PullRequest') {
    const pull = raw as Pull;
    const ownerRepo = (parent as Record<string, unknown>).repo as Repo | undefined;
    switch (fieldName) {
      case 'id': return ownerRepo === undefined ? '' : pullGlobalId(ownerRepo.owner, ownerRepo.name, pull.number);
      case 'number': return pull.number;
      case 'title': return pull.title;
      case 'state': return pullState(pull);
      case 'body': return pull.body;
      case 'headRefName': return pull.headRef;
      case 'baseRefName': return pull.baseRef;
      case 'mergeable': return ownerRepo === undefined ? 'UNKNOWN' : computeMergeable(store, ownerRepo, pull);
      case 'merged': return pull.merged;
      case 'files': return ownerRepo === undefined ? { nodes: [], edges: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: 0 } : filesConnection(ownerRepo, pull, args);
      case 'author': return userValue(ownerRepo?.owner ?? VIEWER.login, VIEWER.id);
      case 'createdAt': return isoAt(pull.createdSeq);
      case 'mergedAt': return pull.mergedSeq === null ? null : isoAt(pull.mergedSeq);
      case 'url': return ownerRepo === undefined ? '' : `https://github.com/${ownerRepo.fullName}/pull/${pull.number}`;
      default: return null;
    }
  }

  if (parentType === 'IssueConnection' || parentType === 'PullRequestConnection' ||
      parentType === 'IssueCommentConnection' || parentType === 'PullRequestChangedFileConnection') {
    const conn = raw as ConnectionValue<unknown>;
    if (fieldName === 'nodes') return conn.nodes;
    if (fieldName === 'edges') return conn.edges;
    if (fieldName === 'pageInfo') return conn.pageInfo;
    if (fieldName === 'totalCount') return conn.totalCount;
    return null;
  }

  if (parentType === 'IssueEdge' || parentType === 'PullRequestEdge' ||
      parentType === 'CommentEdge' || parentType === 'PullRequestChangedFileEdge') {
    const edge = raw as { node: unknown; cursor: string };
    if (fieldName === 'node') return edge.node;
    if (fieldName === 'cursor') return edge.cursor;
    return null;
  }

  if (parentType === 'PageInfo') {
    return (raw as PageInfoValue)[fieldName as keyof PageInfoValue] ?? null;
  }

  if (parentType === 'Label') {
    const label = raw as { name: string; color: string };
    if (fieldName === 'name') return label.name;
    if (fieldName === 'color') return label.color;
    if (fieldName === 'description') return '';
    if (fieldName === 'id') return 0;
    if (fieldName === 'url') return '';
    return null;
  }

  if (parentType === 'PullRequestChangedFile') {
    const file = raw as Record<string, unknown>;
    return file[fieldName] ?? null;
  }

  if (parentType === '__Type') {
    const info = raw as { name: string; kind: string; fields: string[] | null; enumValues: string[] | null };
    if (fieldName === 'name') return info.name;
    if (fieldName === 'kind') return info.kind;
    if (fieldName === 'description') return null;
    if (fieldName === 'fields') return (info.fields ?? []).map((name) => ({ __gqlType: '__Field', name }));
    if (fieldName === 'enumValues') return (info.enumValues ?? []).map((name) => ({ __gqlType: '__EnumValue', name }));
    return null;
  }

  if (parentType === '__Field' || parentType === '__EnumValue') {
    if (fieldName === 'name') return (raw as { name: string }).name;
    if (fieldName === 'description') return null;
    if (fieldName === 'args') return [];
    if (fieldName === 'type') return null;
    return null;
  }

  if (parentType.endsWith('Payload')) {
    const payload = raw as Record<string, unknown>;
    if (fieldName === 'clientMutationId') return null;
    return payload[fieldName] ?? null;
  }

  return null;
}

// ---------------------------------------------------------------------------------------------
// Operation execution + HTTP handler

function executeOne(body: unknown, store: Store): Record<string, unknown> {
  const obj = (body ?? {}) as Record<string, unknown>;
  const query = obj.query;
  if (typeof query !== 'string' || query.trim() === '') {
    return { data: null, errors: [{ message: 'query is required' }] };
  }
  const variables = (obj.variables ?? {}) as Record<string, unknown>;
  let operations: Operation[];
  try {
    operations = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Failed to parse query' }] };
  }
  let operation: Operation | undefined;
  const operationName = obj.operationName;
  if (typeof operationName === 'string' && operationName !== '') {
    operation = operations.find((op) => op.name === operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}"` }] };
    }
  } else if (operations.length === 1) {
    operation = operations[0];
  } else {
    return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations' }] };
  }
  const vars: Record<string, unknown> = { ...variables };
  for (const def of (operation as Operation).varDefs) {
    if (vars[def.name] === undefined && def.defaultValue !== null) {
      vars[def.name] = resolveValue(def.defaultValue, vars);
    }
  }
  const errors: GraphQLError[] = [];
  const ctx: ExecContext = { store, variables: vars };
  let data: Record<string, unknown>;
  try {
    data = executeSelections(
      (operation as Operation).kind === 'mutation' ? 'Mutation' : 'Query',
      {},
      (operation as Operation).selections,
      ctx,
      [],
      errors,
    );
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Internal error' }] };
  }
  if (errors.length > 0) return { data: null, errors };
  return { data };
}

/** POST /api/graphql. Auth first (missing/wrong token -> 401), then JSON body, then execute. */
export async function handleGraphQL(req: IncomingMessage, res: ServerResponse, store: Store): Promise<void> {
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  const header = req.headers.authorization;
  const token = typeof header === 'string' ? (/^Bearer (.+)$/.exec(header)?.[1] ?? null) : null;
  if (token === null || (expected !== '' && token !== expected)) {
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 400, { message: 'Request body too large' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    sendJson(res, 400, { message: 'Malformed JSON body' });
    return;
  }
  if (Array.isArray(parsed)) {
    sendJson(res, 200, parsed.map((entry) => executeOne(entry, store)));
    return;
  }
  if (typeof parsed === 'object' && parsed !== null) {
    sendJson(res, 200, executeOne(parsed, store));
    return;
  }
  sendJson(res, 400, { message: 'Malformed JSON body' });
}
