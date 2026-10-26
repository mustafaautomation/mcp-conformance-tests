import { describe, expect, it } from 'vitest';
import { CHECKS } from '../src/conformance/checks.ts';
import { runConformance, toMarkdown } from '../src/conformance/runner.ts';
import { failing, reference } from './helpers.ts';

describe('reference server', () => {
  it('passes every check it is eligible for', async () => {
    const report = await runConformance(reference());
    expect(failing(report)).toEqual([]);
    expect(report.passed).toBe(true);
    const skipped = report.results.filter((r) => r.status === 'skip').map((r) => r.id);
    // No prompts capability (so prompts/list is skipped) and no 2026-07-28 support.
    expect(skipped.sort()).toEqual(['info.stateless-discover', 'prompts.list']);
  });

  it('runs every registered check exactly once, in order', async () => {
    const report = await runConformance(reference());
    expect(report.results.map((r) => r.id)).toEqual(CHECKS.map((c) => c.id));
  });

  it('skips the tools/call check when no call is configured', async () => {
    const report = await runConformance(reference(undefined, false));
    expect(report.results.find((r) => r.id === 'tools.call-content')?.status).toBe('skip');
  });

  it('renders a markdown summary', async () => {
    const md = toMarkdown(await runConformance(reference()));
    expect(md).toContain('## MCP conformance: PASS');
    expect(md).toContain('| lifecycle.initialize | MUST | pass |');
  });
});

describe('unreachable targets', () => {
  it('fails cleanly when the command does not exist', async () => {
    const report = await runConformance({
      command: '/nonexistent/mcp-server',
      args: [],
      timeoutMs: 500,
    });
    expect(report.passed).toBe(false);
    expect(failing(report)).toContain('lifecycle.initialize');
  });

  it('fails cleanly when the server exits immediately', async () => {
    const report = await runConformance({
      command: process.execPath,
      args: ['-e', 'process.exit(0)'],
      timeoutMs: 500,
    });
    expect(report.passed).toBe(false);
  });
});
