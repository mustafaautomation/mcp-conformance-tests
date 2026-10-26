import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { SERVER } from './helpers.ts';

const CLI = fileURLToPath(new URL('../src/conformance/cli.ts', import.meta.url));
const run = promisify(execFile);

async function cli(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number; stdout: string }> {
  try {
    const { stdout } = await run(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout };
  } catch (e) {
    const err = e as { code: number; stdout: string };
    return { code: err.code, stdout: err.stdout };
  }
}

describe('cli', () => {
  it('exits 0 and writes JSON for a conforming server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-'));
    const out = join(dir, 'report.json');
    const res = await cli([
      '--call',
      'echo',
      '--args',
      '{"message":"hi"}',
      '--json',
      out,
      '--',
      process.execPath,
      SERVER,
    ]);
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('MCP conformance: PASS');
    const report = JSON.parse(readFileSync(out, 'utf8')) as {
      passed: boolean;
      results: { id: string; status: string }[];
    };
    expect(report.passed).toBe(true);
    expect(report.results.find((r) => r.id === 'tools.call-content')?.status).toBe('pass');
  });

  it('exits 1 when a MUST check fails', async () => {
    const res = await cli(['--', process.execPath, SERVER], { MCP_MUTANT: 'unknown-tool-ok' });
    expect(res.code).toBe(1);
    expect(res.stdout).toContain('| tools.unknown-tool | MUST | FAIL |');
  });

  it('exits 0 but shows a warning when only a SHOULD check fails', async () => {
    const res = await cli(['--', process.execPath, SERVER], { MCP_MUTANT: 'silent-parse-error' });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('| jsonrpc.parse-error | SHOULD | warn |');
  });

  it.each([
    [[]],
    [['--call', 'echo']],
    [['--args', 'not-json', '--', 'x']],
    [['--bogus', '--', 'x']],
  ])('exits 2 on usage errors: %j', async (args) => {
    expect((await cli(args)).code).toBe(2);
  });
});
