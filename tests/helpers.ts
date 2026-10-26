import { fileURLToPath } from 'node:url';
import type { Target } from '../src/conformance/checks.ts';
import type { Report } from '../src/conformance/runner.ts';

export const SERVER = fileURLToPath(new URL('../src/reference/server.ts', import.meta.url));

/** Run the reference server straight from TypeScript (Node 24 strips types natively). */
export function reference(mutant?: string, withCall = true): Target {
  return {
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, MCP_MUTANT: mutant ?? '' },
    call: withCall ? { name: 'echo', arguments: { message: 'hello' } } : undefined,
    timeoutMs: 3000,
  };
}

export const failing = (report: Report): string[] =>
  report.results
    .filter((r) => r.status === 'fail')
    .map((r) => r.id)
    .sort();
