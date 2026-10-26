import type { JsonObject, JsonValue } from './transport.ts';
import { StdioConnection } from './transport.ts';

/** The handshake-based revision this suite targets; see README for why not 2026-07-28. */
export const TARGET_VERSION = '2025-11-25';
export const KNOWN_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

export type Level = 'MUST' | 'SHOULD' | 'INFO';
export type Status = 'pass' | 'fail' | 'skip';

export interface Outcome {
  status: Status;
  detail?: string;
}

export interface ToolCall {
  name: string;
  arguments: JsonObject;
}

export interface Target {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  /** A tool call that should succeed, used by the tools/call checks. */
  call?: ToolCall;
  timeoutMs?: number;
}

export interface Context {
  target: Target;
  conn: StdioConnection;
  init?: JsonObject;
  nextId: () => number;
  /** Open an extra connection (e.g. for a second initialize); closed by the runner. */
  spawn: () => StdioConnection;
  timeoutMs: number;
}

export interface Check {
  id: string;
  level: Level;
  title: string;
  spec: string;
  run: (ctx: Context) => Promise<Outcome>;
}

const pass = (detail?: string): Outcome => ({ status: 'pass', detail });
const fail = (detail: string): Outcome => ({ status: 'fail', detail });
const skip = (detail: string): Outcome => ({ status: 'skip', detail });

const isObject = (v: JsonValue | undefined): v is JsonObject =>
  v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v);

const short = (v: unknown): string => {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 200 ? `${s.slice(0, 200)}...` : s;
};

export function initializeParams(version: string): JsonObject {
  return {
    protocolVersion: version,
    capabilities: {},
    clientInfo: { name: 'mcp-conformance-tests', version: '1.0.0' },
  };
}

function capability(ctx: Context, name: string): JsonObject | undefined {
  const result = ctx.init?.result;
  if (!isObject(result) || !isObject(result.capabilities)) return undefined;
  const cap = result.capabilities[name];
  return isObject(cap) ? cap : undefined;
}

async function listAll(
  ctx: Context,
  method: string,
  key: string,
): Promise<{ items: JsonObject[]; error?: string }> {
  const items: JsonObject[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let page = 0; page < 50; page++) {
    const params: JsonObject = cursor === undefined ? {} : { cursor };
    const res = await ctx.conn.request(method, params, ctx.nextId(), ctx.timeoutMs);
    if (!res) return { items, error: `no response to ${method}` };
    if (!isObject(res.result))
      return { items, error: `${method} returned ${short(res.error ?? res)}` };
    const list = res.result[key];
    if (!Array.isArray(list)) return { items, error: `${method} result has no ${key} array` };
    for (const item of list) {
      if (!isObject(item)) return { items, error: `${key} contains a non-object: ${short(item)}` };
      items.push(item);
    }
    const next = res.result.nextCursor;
    if (next === undefined || next === null) return { items };
    if (typeof next !== 'string')
      return { items, error: `nextCursor is not a string: ${short(next)}` };
    if (seenCursors.has(next))
      return { items, error: `cursor ${short(next)} repeated; pagination loops` };
    seenCursors.add(next);
    cursor = next;
  }
  return { items, error: 'more than 50 pages; pagination does not terminate' };
}

export const CHECKS: Check[] = [
  {
    id: 'lifecycle.initialize',
    level: 'MUST',
    title: 'initialize returns protocolVersion, capabilities and serverInfo',
    spec: 'basic/lifecycle#initialization',
    run: async (ctx) => {
      const res = ctx.init;
      if (!res) return fail('no response to initialize');
      const r = res.result;
      if (!isObject(r)) return fail(`initialize did not return a result: ${short(res)}`);
      if (typeof r.protocolVersion !== 'string')
        return fail('result.protocolVersion is not a string');
      if (!isObject(r.capabilities)) return fail('result.capabilities is not an object');
      const info = r.serverInfo;
      if (!isObject(info) || typeof info.name !== 'string' || typeof info.version !== 'string') {
        return fail(`serverInfo needs string name and version: ${short(info)}`);
      }
      return pass(`${info.name} ${info.version}, protocol ${r.protocolVersion}`);
    },
  },
  {
    id: 'lifecycle.version-known',
    level: 'MUST',
    title: 'The negotiated protocol version is a published revision',
    spec: 'basic/lifecycle#version-negotiation',
    run: async (ctx) => {
      const r = ctx.init?.result;
      if (!isObject(r)) return skip('initialize failed');
      const v = r.protocolVersion;
      if (typeof v === 'string' && KNOWN_VERSIONS.includes(v)) {
        return pass(
          v === TARGET_VERSION
            ? v
            : `${v} (older than requested ${TARGET_VERSION}, which is allowed)`,
        );
      }
      return fail(`server answered with ${short(v)}`);
    },
  },
  {
    id: 'lifecycle.version-unsupported',
    level: 'MUST',
    title:
      'An unsupported requested version is answered with a version the server supports, not an error',
    spec: 'basic/lifecycle#version-negotiation',
    run: async (ctx) => {
      const conn = ctx.spawn();
      const res = await conn.request(
        'initialize',
        initializeParams('1999-01-01'),
        1,
        ctx.timeoutMs,
      );
      if (!res) return fail('no response');
      if (!isObject(res.result)) return fail(`expected a result, got ${short(res)}`);
      const v = res.result.protocolVersion;
      return typeof v === 'string' && KNOWN_VERSIONS.includes(v)
        ? pass(`offered ${v}`)
        : fail(`offered ${short(v)}`);
    },
  },
  {
    id: 'jsonrpc.envelope',
    level: 'MUST',
    title: 'Responses carry jsonrpc "2.0", the request id, and exactly one of result or error',
    spec: 'basic#responses',
    run: async (ctx) => {
      const id = ctx.nextId();
      const res = await ctx.conn.request('ping', {}, id, ctx.timeoutMs);
      if (!res) {
        const stray = ctx.conn
          .responsesSince(0)
          .find((m) => m.id !== id && typeof m.id === 'number' && m.id >= id);
        return fail(
          stray
            ? `response came back with id ${short(stray.id)} instead of ${id}`
            : 'no response to ping',
        );
      }
      if (res.jsonrpc !== '2.0') return fail(`jsonrpc is ${short(res.jsonrpc)}`);
      if ('result' in res === 'error' in res)
        return fail(`needs exactly one of result/error: ${short(res)}`);
      return pass();
    },
  },
  {
    id: 'jsonrpc.string-ids',
    level: 'MUST',
    title: 'String request ids are echoed back as the same string',
    spec: 'basic#requests',
    run: async (ctx) => {
      const id = `req-${ctx.nextId()}`;
      const from = ctx.conn.lines.length;
      const res = await ctx.conn.request('ping', {}, id, ctx.timeoutMs);
      if (res) return pass();
      const other = ctx.conn.responsesSince(from)[0];
      return fail(other ? `sent id ${short(id)}, got ${short(other.id)}` : 'no response');
    },
  },
  {
    id: 'basic.ping',
    level: 'MUST',
    title: 'ping returns an empty result',
    spec: 'basic/utilities/ping',
    run: async (ctx) => {
      const res = await ctx.conn.request('ping', undefined, ctx.nextId(), ctx.timeoutMs);
      if (!res) return fail('no response');
      return isObject(res.result) &&
        Object.keys(res.result).filter((k) => k !== '_meta').length === 0
        ? pass()
        : fail(`expected {}, got ${short(res.result ?? res.error)}`);
    },
  },
  {
    id: 'jsonrpc.method-not-found',
    level: 'MUST',
    title: 'Unknown methods return error -32601',
    spec: 'JSON-RPC 2.0 section 5.1',
    run: async (ctx) => {
      const res = await ctx.conn.request(
        'conformance/does-not-exist',
        {},
        ctx.nextId(),
        ctx.timeoutMs,
      );
      if (!res) return fail('no response');
      const code = isObject(res.error) ? res.error.code : undefined;
      return code === -32601
        ? pass()
        : fail(`expected error -32601, got ${short(res.error ?? res.result)}`);
    },
  },
  {
    id: 'jsonrpc.parse-error',
    // JSON-RPC 2.0 defines -32700 for this, but the MCP spec does not call it out and the official
    // TypeScript SDK's stdio transport drops unparseable lines silently. Reported, not gating.
    level: 'SHOULD',
    title: 'Invalid JSON gets error -32700 with a null id, and the server keeps working',
    spec: 'JSON-RPC 2.0 section 5.1',
    run: async (ctx) => {
      const from = ctx.conn.lines.length;
      ctx.conn.sendRaw('{"jsonrpc": "2.0", "id": 99, "method": "ping"');
      const line = await ctx.conn.waitFor(
        (l) => isObject(l.message?.error) && (l.message.error as JsonObject).code === -32700,
        Math.min(ctx.timeoutMs, 2000),
        from,
      );
      const alive = await ctx.conn.request('ping', {}, ctx.nextId(), ctx.timeoutMs);
      if (!alive) return fail('server stopped answering after invalid JSON');
      if (!line?.message) return fail('no -32700 error was sent');
      return line.message.id === null
        ? pass()
        : fail(`parse error carried id ${short(line.message.id)}, expected null`);
    },
  },
  {
    id: 'jsonrpc.notifications-unanswered',
    level: 'MUST',
    title: 'Notifications (no id) get no response',
    spec: 'basic#notifications',
    run: async (ctx) => {
      const from = ctx.conn.lines.length;
      ctx.conn.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      ctx.conn.send({ jsonrpc: '2.0', method: 'notifications/conformance-unknown' });
      const marker = ctx.nextId();
      await ctx.conn.request('ping', {}, marker, ctx.timeoutMs);
      const extra = ctx.conn.responsesSince(from).filter((m) => m.id !== marker);
      return extra.length === 0
        ? pass()
        : fail(`server answered a notification: ${short(extra[0])}`);
    },
  },
  {
    id: 'tools.list',
    level: 'MUST',
    title: 'tools/list items have a name and an object inputSchema; pagination terminates',
    spec: 'server/tools#listing-tools',
    run: async (ctx) => {
      if (!capability(ctx, 'tools')) return skip('server does not declare the tools capability');
      const { items, error } = await listAll(ctx, 'tools/list', 'tools');
      if (error) return fail(error);
      for (const t of items) {
        if (typeof t.name !== 'string' || t.name === '')
          return fail(`tool without a name: ${short(t)}`);
        if (!isObject(t.inputSchema) || t.inputSchema.type !== 'object') {
          return fail(
            `tool ${t.name}: inputSchema must be a JSON Schema with type "object", got ${short(t.inputSchema)}`,
          );
        }
      }
      return pass(`${items.length} tools`);
    },
  },
  {
    id: 'tools.names-unique',
    level: 'MUST',
    title: 'Tool names are unique across all pages',
    spec: 'server/tools#tool',
    run: async (ctx) => {
      if (!capability(ctx, 'tools')) return skip('server does not declare the tools capability');
      const { items, error } = await listAll(ctx, 'tools/list', 'tools');
      if (error) return skip(`tools/list failed: ${error}`);
      const names = items.map((t) => String(t.name));
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      return dupes.length === 0
        ? pass()
        : fail(`duplicate tool names: ${[...new Set(dupes)].join(', ')}`);
    },
  },
  {
    id: 'tools.unknown-tool',
    level: 'MUST',
    title: 'Calling an unknown tool is a JSON-RPC error, not a successful result',
    spec: 'server/tools#error-handling',
    run: async (ctx) => {
      if (!capability(ctx, 'tools')) return skip('server does not declare the tools capability');
      const res = await ctx.conn.request(
        'tools/call',
        { name: 'conformance_no_such_tool', arguments: {} },
        ctx.nextId(),
        ctx.timeoutMs,
      );
      if (!res) return fail('no response');
      if (!isObject(res.error)) return fail(`expected an error, got result ${short(res.result)}`);
      return res.error.code === -32602
        ? pass()
        : pass(`error code ${short(res.error.code)}; the spec's example uses -32602`);
    },
  },
  {
    id: 'tools.call-content',
    level: 'MUST',
    title: 'A successful tools/call returns a content array of known content types',
    spec: 'server/tools#tool-result',
    run: async (ctx) => {
      if (!capability(ctx, 'tools')) return skip('server does not declare the tools capability');
      if (!ctx.target.call) return skip('no --call configured');
      const res = await ctx.conn.request(
        'tools/call',
        { ...ctx.target.call } as unknown as JsonObject,
        ctx.nextId(),
        ctx.timeoutMs,
      );
      if (!res) return fail('no response');
      if (!isObject(res.result)) return fail(`expected a result, got ${short(res.error)}`);
      const content = res.result.content;
      if (!Array.isArray(content)) return fail('result.content is not an array');
      const known = ['text', 'image', 'audio', 'resource_link', 'resource'];
      for (const c of content) {
        if (!isObject(c) || typeof c.type !== 'string' || !known.includes(c.type)) {
          return fail(`unknown content item ${short(c)}`);
        }
        if (c.type === 'text' && typeof c.text !== 'string')
          return fail('text content without a text string');
      }
      if (res.result.isError === true)
        return fail(`the configured call reported isError: ${short(content)}`);
      return pass(`${content.length} content item(s)`);
    },
  },
  {
    id: 'resources.list',
    level: 'MUST',
    title: 'resources/list items have uri and name; pagination terminates',
    spec: 'server/resources#listing-resources',
    run: async (ctx) => {
      if (!capability(ctx, 'resources'))
        return skip('server does not declare the resources capability');
      const { items, error } = await listAll(ctx, 'resources/list', 'resources');
      if (error) return fail(error);
      const bad = items.find((r) => typeof r.uri !== 'string' || typeof r.name !== 'string');
      return bad
        ? fail(`resource needs string uri and name: ${short(bad)}`)
        : pass(`${items.length} resources`);
    },
  },
  {
    id: 'prompts.list',
    level: 'MUST',
    title: 'prompts/list items have a name; pagination terminates',
    spec: 'server/prompts#listing-prompts',
    run: async (ctx) => {
      if (!capability(ctx, 'prompts'))
        return skip('server does not declare the prompts capability');
      const { items, error } = await listAll(ctx, 'prompts/list', 'prompts');
      if (error) return fail(error);
      const bad = items.find((p) => typeof p.name !== 'string');
      return bad ? fail(`prompt without a name: ${short(bad)}`) : pass(`${items.length} prompts`);
    },
  },
  {
    id: 'capabilities.undeclared',
    level: 'SHOULD',
    title: 'Methods for capabilities the server did not declare are rejected',
    spec: 'basic/lifecycle#capability-negotiation',
    run: async (ctx) => {
      const missing = ['tools', 'resources', 'prompts'].filter((c) => !capability(ctx, c));
      if (missing.length === 0) return skip('server declares tools, resources and prompts');
      const name = missing[0]!;
      const res = await ctx.conn.request(`${name}/list`, {}, ctx.nextId(), ctx.timeoutMs);
      if (!res) return fail('no response');
      return isObject(res.error)
        ? pass(`${name}/list rejected`)
        : fail(`${name}/list succeeded without the capability`);
    },
  },
  {
    id: 'stdio.stdout-clean',
    level: 'MUST',
    title: 'Everything on stdout is a JSON-RPC message (logs belong on stderr)',
    spec: 'basic/transports#stdio',
    run: async () => skip('evaluated by the runner after all checks'),
  },
  {
    id: 'info.stateless-discover',
    level: 'INFO',
    title: 'Server also answers server/discover from the 2026-07-28 stateless revision',
    spec: '2026-07-28 server/discover',
    run: async (ctx) => {
      const res = await ctx.conn.request(
        'server/discover',
        {
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
        ctx.nextId(),
        ctx.timeoutMs,
      );
      if (isObject(res?.result) && Array.isArray(res.result.supportedVersions)) {
        return pass(`supports ${short(res.result.supportedVersions)}`);
      }
      return skip('not supported (expected for servers on 2025-11-25 SDKs)');
    },
  },
];
