import {
  CHECKS,
  initializeParams,
  TARGET_VERSION,
  type Check,
  type Level,
  type Outcome,
  type Target,
} from './checks.ts';
import { StdioConnection } from './transport.ts';

export interface Result {
  id: string;
  level: Level;
  title: string;
  spec: string;
  status: Outcome['status'];
  detail?: string;
}

export interface Report {
  target: string;
  protocolVersion: string;
  results: Result[];
  passed: boolean;
}

/** Run every check against the target. MUST failures fail the report; SHOULD and INFO never do. */
export async function runConformance(target: Target, checks: Check[] = CHECKS): Promise<Report> {
  const timeoutMs = target.timeoutMs ?? 5000;
  const connections: StdioConnection[] = [];
  const spawn = (): StdioConnection => {
    const c = new StdioConnection(target.command, target.args, target.env ?? process.env);
    connections.push(c);
    return c;
  };
  let id = 1000;
  const conn = spawn();
  const results: Result[] = [];
  try {
    const init = await conn.request('initialize', initializeParams(TARGET_VERSION), 0, timeoutMs);
    conn.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const ctx = { target, conn, init, nextId: () => id++, spawn, timeoutMs };
    for (const check of checks) {
      let outcome: Outcome;
      try {
        outcome = await check.run(ctx);
      } catch (e) {
        outcome = { status: 'fail', detail: `check threw: ${(e as Error).message}` };
      }
      results.push({
        id: check.id,
        level: check.level,
        title: check.title,
        spec: check.spec,
        ...outcome,
      });
    }
  } finally {
    await Promise.all(connections.map((c) => c.close()));
  }

  const stdout = results.find((r) => r.id === 'stdio.stdout-clean');
  if (stdout) {
    const junk = connections
      .flatMap((c) => c.lines)
      .find((l) => l.message === undefined || l.message.jsonrpc !== '2.0');
    stdout.status = junk ? 'fail' : 'pass';
    stdout.detail = junk ? `non-JSON-RPC line on stdout: ${junk.raw.slice(0, 120)}` : undefined;
  }

  return {
    target: [target.command, ...target.args].join(' '),
    protocolVersion: TARGET_VERSION,
    results,
    passed: results.every((r) => r.level !== 'MUST' || r.status !== 'fail'),
  };
}

export function toMarkdown(report: Report): string {
  const icon = { pass: 'pass', fail: 'FAIL', skip: 'skip' } as const;
  const lines = [
    `## MCP conformance: ${report.passed ? 'PASS' : 'FAIL'}`,
    '',
    `Target: \`${report.target}\`, requested protocol ${report.protocolVersion}`,
    '',
    '| Check | Level | Result | Detail |',
    '|---|---|---|---|',
    ...report.results.map(
      (r) =>
        `| ${r.id} | ${r.level} | ${r.status === 'fail' && r.level !== 'MUST' ? 'warn' : icon[r.status]} | ${(r.detail ?? '').replaceAll('|', '\\|')} |`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}
