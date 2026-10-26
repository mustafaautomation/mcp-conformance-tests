#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { JsonObject } from './transport.ts';
import { runConformance, toMarkdown } from './runner.ts';

const USAGE = `Usage: mcp-conform [--call <tool>] [--args <json>] [--json <file>] [--timeout <ms>] -- <command> [args...]

Runs the conformance checks against an MCP server started as <command> over stdio.
Exit codes: 0 no MUST check failed, 1 a MUST check failed, 2 usage error.`;

async function main(argv: string[]): Promise<number> {
  const split = argv.indexOf('--');
  if (split === -1 || split === argv.length - 1) {
    console.error(USAGE);
    return 2;
  }
  let values;
  try {
    ({ values } = parseArgs({
      args: argv.slice(0, split),
      options: {
        call: { type: 'string' },
        args: { type: 'string', default: '{}' },
        json: { type: 'string' },
        timeout: { type: 'string', default: '5000' },
      },
    }));
  } catch (e) {
    console.error(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  let callArgs: JsonObject;
  try {
    callArgs = JSON.parse(values.args) as JsonObject;
  } catch {
    console.error('--args must be a JSON object');
    return 2;
  }
  const [command, ...args] = argv.slice(split + 1) as [string, ...string[]];
  const report = await runConformance({
    command,
    args,
    call: values.call ? { name: values.call, arguments: callArgs } : undefined,
    timeoutMs: Number(values.timeout),
  });
  const md = toMarkdown(report);
  process.stdout.write(md);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
  if (values.json) writeFileSync(values.json, JSON.stringify(report, null, 2));
  return report.passed ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e);
    process.exit(2);
  },
);
