# mcp-conformance-tests

[![CI](https://github.com/mustafaautomation/mcp-conformance-tests/actions/workflows/ci.yml/badge.svg)](https://github.com/mustafaautomation/mcp-conformance-tests/actions/workflows/ci.yml)

Black-box conformance checks for [Model Context Protocol](https://modelcontextprotocol.io) (MCP)
servers over stdio, written in TypeScript. The suite talks raw newline-delimited JSON-RPC to the
server process, without an SDK, so it judges exactly what the server sends.

To prove the checks themselves work, the repo includes a hand-written reference server with 16
**mutants**. Each mutant switches on one deliberate protocol violation, and the tests assert that
the intended check (and only that check) catches it.

Personal portfolio project, not production or client work. For official conformance testing, see
the MCP project's own [`@modelcontextprotocol/conformance`](https://www.npmjs.com/package/@modelcontextprotocol/conformance)
package. This repo is a smaller, independent take, focused on proving each check against a mutant.

## Which protocol revision

The suite targets **2025-11-25**, the handshake-based revision (`initialize`, then
`notifications/initialized`). As of October 2026, the official TypeScript SDK (1.32.2) still
implements that revision, so most deployed servers speak it. The newer **2026-07-28** revision
removes the handshake (stateless requests, `server/discover`). The suite only probes for it, as an
informational check; it does not test it.

## The checks

| Check | Level | What it verifies |
|---|---|---|
| lifecycle.initialize | MUST | `initialize` returns `protocolVersion`, `capabilities`, and `serverInfo` with name and version |
| lifecycle.version-known | MUST | The negotiated version is a published revision |
| lifecycle.version-unsupported | MUST | Asking for an unknown version (`1999-01-01`) gets a supported version back, not an error |
| jsonrpc.envelope | MUST | `jsonrpc: "2.0"`, the request's id, exactly one of `result`/`error` |
| jsonrpc.string-ids | MUST | String ids come back as the same string |
| basic.ping | MUST | `ping` returns `{}` |
| jsonrpc.method-not-found | MUST | Unknown methods return `-32601` |
| jsonrpc.notifications-unanswered | MUST | Notifications get no response |
| tools.list | MUST | Every tool has a name and an `inputSchema` with `type: "object"`; `nextCursor` pagination terminates without looping |
| tools.names-unique | MUST | No duplicate tool names across pages |
| tools.unknown-tool | MUST | Calling an unknown tool is a JSON-RPC error, not a success |
| tools.call-content | MUST | A configured call (`--call`) returns a `content` array of known types and is not `isError` |
| resources.list / prompts.list | MUST | Items have the required fields; pagination terminates (skipped if the capability is not declared) |
| stdio.stdout-clean | MUST | Every stdout line is a JSON-RPC message; logs must go to stderr |
| jsonrpc.parse-error | SHOULD | Invalid JSON gets `-32700` with `id: null`, and the server keeps working |
| capabilities.undeclared | SHOULD | Methods for an undeclared capability are rejected |
| info.stateless-discover | INFO | Whether the server also answers 2026-07-28 `server/discover` |

Only MUST failures fail a run.

**Why parse errors are only SHOULD.** JSON-RPC 2.0 defines `-32700`, but the MCP spec does not
single it out. The official SDK's stdio transport also drops unparseable lines without answering.
Failing every SDK-based server on that would be noise, so the check reports it as a warning.

## Results against the official example server

CI also runs the suite against `@modelcontextprotocol/server-everything` 2.0.1, the MCP project's
feature-complete example server, pinned in `package.json`. All MUST checks pass, and it declares
16 tools, 7 resources and 4 prompts. The one finding is the SHOULD-level parse-error check: the
server does not answer invalid JSON with `-32700`, though it keeps working afterwards.

## Usage

```
npm ci && npm run build
node dist/src/conformance/cli.js [--call <tool> --args '<json>'] [--json report.json] [--timeout ms] -- <server command...>

# examples
node dist/src/conformance/cli.js -- node dist/src/reference/server.js
node dist/src/conformance/cli.js --call echo --args '{"message":"hi"}' -- npx -y @modelcontextprotocol/server-everything stdio
MCP_MUTANT=unknown-tool-ok node dist/src/conformance/cli.js -- node dist/src/reference/server.js   # exits 1
```

The CLI prints a markdown table, appends it to the GitHub job summary when there is one, and
optionally writes JSON. Exit codes: 0 no MUST failure, 1 a MUST check failed, 2 usage error.

## Tests

`npm test` runs 30 Vitest tests in about 30 seconds:

- The reference server passes every check it is eligible for. Every registered check runs exactly
  once, in order.
- Each of the 16 mutants fails exactly its intended checks. The one exception is `wrong-id`, which
  breaks request matching everywhere, so the test asserts a minimum set instead. A meta-test lists
  which gating checks have no mutant: `lifecycle.version-known`, and `prompts.list`, which is
  covered by the server-everything run instead.
- Missing or crashing server commands fail cleanly rather than hanging.
- CLI exit codes, JSON output, and the MUST-versus-SHOULD distinction.

CI runs lint (ESLint 10), Prettier, `tsc` (TypeScript 6, strict), the tests and the build, then the
conformance run against both servers.

## Limits

- stdio transport only. Streamable HTTP, auth, sampling, elicitation, tasks and other client
  features are not covered.
- Structural checks. The suite does not validate every result against the full JSON Schema of the
  spec, and it does not test tool behaviour beyond one configured call.

## License

MIT
