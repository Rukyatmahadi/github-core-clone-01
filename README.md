# github-core-clone-01 — GitHub-compatible git forge

A standalone, GitHub-compatible git forge in one Node 22 process (stdlib only, no
git binary, no outside service). Built for the make.fun bounty
`github-core-clone-01`.

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2 and
  receive-pack v0, with packfile generation/parsing (OFS/REF_DELTA) and
  fast-forward enforcement.
- **REST v3 API** under `/api/v3` — repositories, contents, labels, issues,
  pull requests (including squash merge).
- **GraphQL v4 API** at `/api/graphql` — queries and mutations of the shape
  `gh` and `github-mcp-server` send, with introspection.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`).

## Run

```sh
node --experimental-strip-types main.ts
```

The forge binds an ephemeral port, registers it with the suite
(`$MAKEFUN_ENV_URL/register`), serves from its own in-memory store, and exits
0 once the suite reports done.

## Local verification

Against the kit's local runner: **120/120 conformance checks pass**
(repos 15/15, issues 15/15, pulls 20/20, protocol 5/5, GraphQL 20/20,
MCP 15/15, git 30/30); performance 170/200.

## License

MIT
