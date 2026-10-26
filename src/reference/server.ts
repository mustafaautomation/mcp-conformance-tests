#!/usr/bin/env node
/**
 * A small hand-written MCP server (stdio, protocol 2025-11-25) used as the suite's known-good target.
 *
 * MCP_MUTANT=<name> switches on one deliberate protocol violation, so the tests can prove each
 * conformance check fails when it should. See MUTANTS for the list.
 */
import { createInterface } from 'node:readline';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Obj = { [k: string]: Json };

export const MUTANTS = [
  'stdout-noise',
  'wrong-id',
  'numeric-ids',
  'method-not-found-ok',
  'silent-parse-error',
  'reply-to-notifications',
  'reject-unknown-version',
  'bad-input-schema',
  'duplicate-tool',
  'unknown-tool-ok',
  'looping-cursor',
  'bad-content',
  'ping-with-data',
  'no-server-info',
  'resource-without-uri',
  'undeclared-resources',
] as const;
export type Mutant = (typeof MUTANTS)[number];

const mutant = process.env.MCP_MUTANT as Mutant | undefined;
const SUPPORTED = ['2025-11-25', '2025-06-18'];
const PAGE_SIZE = 2;

const tools: Obj[] = [
  {
    name: 'echo',
    description: 'Returns the message it was given',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
  {
    name: 'add',
    description: 'Adds two numbers',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
  },
  {
    name: 'utc_now',
    description: 'Current time in UTC (ISO 8601)',
    inputSchema: { type: 'object', properties: {} },
  },
];
if (mutant === 'bad-input-schema') tools[1] = { ...tools[1]!, inputSchema: { type: 'string' } };
if (mutant === 'duplicate-tool') tools.push({ ...tools[0]! });

const resources: Obj[] = [{ uri: 'memo://readme', name: 'readme', mimeType: 'text/plain' }];
if (mutant === 'resource-without-uri') resources.push({ name: 'broken' });

const write = (msg: Obj): void => {
  if (mutant === 'stdout-noise') process.stdout.write('handling request...\n');
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};

const respond = (id: Json, result: Obj): void => {
  let outId = id;
  if (mutant === 'wrong-id' && typeof id === 'number') outId = id + 1;
  if (mutant === 'numeric-ids' && typeof id === 'string')
    outId = Number.parseInt(id.replace(/\D/g, ''), 10) || 0;
  write({ jsonrpc: '2.0', id: outId, result });
};

const error = (id: Json, code: number, message: string, data?: Json): void => {
  const err: Obj = { code, message };
  if (data !== undefined) err.data = data;
  write({ jsonrpc: '2.0', id, error: err });
};

function page(items: Obj[], key: string, params: Obj): Obj {
  const start = typeof params.cursor === 'string' ? Number.parseInt(params.cursor, 10) : 0;
  const result: Obj = { [key]: items.slice(start, start + PAGE_SIZE) };
  if (start + PAGE_SIZE < items.length) result.nextCursor = String(start + PAGE_SIZE);
  else if (mutant === 'looping-cursor' && start > 0) result.nextCursor = String(start); // never ends
  return result;
}

function callTool(id: Json, params: Obj): void {
  const args = (
    typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}
  ) as Obj;
  const text = (t: string): Obj => ({
    content: [{ type: mutant === 'bad-content' ? 'html' : 'text', text: t }],
  });
  switch (params.name) {
    case 'echo':
      if (typeof args.message !== 'string') {
        // Invalid arguments are a tool execution error (isError), so a model can correct itself.
        respond(id, {
          content: [{ type: 'text', text: 'message must be a string' }],
          isError: true,
        });
      } else respond(id, text(args.message));
      return;
    case 'add':
      if (typeof args.a !== 'number' || typeof args.b !== 'number') {
        respond(id, {
          content: [{ type: 'text', text: 'a and b must be numbers' }],
          isError: true,
        });
      } else respond(id, text(String(args.a + args.b)));
      return;
    case 'utc_now':
      respond(id, text(new Date().toISOString()));
      return;
    default:
      if (mutant === 'unknown-tool-ok') respond(id, text('ok'));
      else error(id, -32602, `Unknown tool: ${String(params.name)}`);
  }
}

function handle(msg: Obj): void {
  const { id, method } = msg;
  const params = (typeof msg.params === 'object' && msg.params !== null ? msg.params : {}) as Obj;
  const isRequest = id !== undefined;
  if (typeof method !== 'string') {
    if (isRequest) error(id, -32600, 'Invalid Request');
    return;
  }
  if (!isRequest) {
    if (mutant === 'reply-to-notifications') write({ jsonrpc: '2.0', id: null, result: {} });
    return; // notifications are never answered
  }
  switch (method) {
    case 'initialize': {
      const requested = String(params.protocolVersion);
      if (!SUPPORTED.includes(requested) && mutant === 'reject-unknown-version') {
        error(id, -32602, 'Unsupported protocol version', { supported: SUPPORTED, requested });
        return;
      }
      const capabilities: Obj = { tools: {}, resources: {} };
      if (mutant === 'undeclared-resources') delete capabilities.resources;
      const result: Obj = {
        protocolVersion: SUPPORTED.includes(requested) ? requested : SUPPORTED[0]!,
        capabilities,
        serverInfo: { name: 'reference-server', version: '1.0.0' },
        instructions: 'Reference server for mcp-conformance-tests.',
      };
      if (mutant === 'no-server-info') delete result.serverInfo;
      respond(id, result);
      return;
    }
    case 'ping':
      respond(id, mutant === 'ping-with-data' ? { pong: true } : {});
      return;
    case 'tools/list':
      respond(id, page(tools, 'tools', params));
      return;
    case 'tools/call':
      callTool(id, params);
      return;
    case 'resources/list':
      if (mutant === 'undeclared-resources') {
        respond(id, { resources }); // answers a capability it never declared
        return;
      }
      respond(id, page(resources, 'resources', params));
      return;
    case 'resources/read':
      if (params.uri === 'memo://readme') {
        respond(id, {
          contents: [
            {
              uri: 'memo://readme',
              mimeType: 'text/plain',
              text: 'Hello from the reference server.',
            },
          ],
        });
      } else error(id, -32002, 'Resource not found', { uri: params.uri ?? null });
      return;
    default:
      if (mutant === 'method-not-found-ok') respond(id, {});
      else error(id, -32601, `Method not found: ${method}`);
  }
}

createInterface({ input: process.stdin }).on('line', (line) => {
  if (line.trim() === '') return;
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    if (mutant !== 'silent-parse-error') error(null, -32700, 'Parse error');
    return;
  }
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) {
    error(null, -32600, 'Invalid Request');
    return;
  }
  handle(msg as Obj);
});
process.stderr.write(`reference-server started${mutant ? ` (mutant: ${mutant})` : ''}\n`);
