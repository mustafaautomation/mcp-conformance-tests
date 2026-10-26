import { describe, expect, it } from 'vitest';
import { CHECKS } from '../src/conformance/checks.ts';
import { runConformance } from '../src/conformance/runner.ts';
import { MUTANTS } from '../src/reference/server.ts';
import { failing, reference } from './helpers.ts';

interface Expectation {
  /** Checks that must fail. */
  fails: string[];
  /** If true, no other check may fail (the check is precise, not just noisy). */
  exact: boolean;
  /** Whether the overall report still passes (only SHOULD-level failures). */
  passes: boolean;
}

const EXPECTED: Record<(typeof MUTANTS)[number], Expectation> = {
  'stdout-noise': { fails: ['stdio.stdout-clean'], exact: true, passes: false },
  // An off-by-one id breaks request/response matching everywhere, starting with initialize.
  'wrong-id': { fails: ['jsonrpc.envelope', 'lifecycle.initialize'], exact: false, passes: false },
  'numeric-ids': { fails: ['jsonrpc.string-ids'], exact: true, passes: false },
  'method-not-found-ok': {
    fails: ['capabilities.undeclared', 'jsonrpc.method-not-found'],
    exact: true,
    passes: false,
  },
  'silent-parse-error': { fails: ['jsonrpc.parse-error'], exact: true, passes: true },
  'reply-to-notifications': {
    fails: ['jsonrpc.notifications-unanswered'],
    exact: true,
    passes: false,
  },
  'reject-unknown-version': {
    fails: ['lifecycle.version-unsupported'],
    exact: true,
    passes: false,
  },
  'bad-input-schema': { fails: ['tools.list'], exact: true, passes: false },
  'duplicate-tool': { fails: ['tools.names-unique'], exact: true, passes: false },
  'unknown-tool-ok': { fails: ['tools.unknown-tool'], exact: true, passes: false },
  'looping-cursor': { fails: ['tools.list'], exact: true, passes: false },
  'bad-content': { fails: ['tools.call-content'], exact: true, passes: false },
  'ping-with-data': { fails: ['basic.ping'], exact: true, passes: false },
  'no-server-info': { fails: ['lifecycle.initialize'], exact: true, passes: false },
  'resource-without-uri': { fails: ['resources.list'], exact: true, passes: false },
  'undeclared-resources': { fails: ['capabilities.undeclared'], exact: true, passes: true },
};

describe('each mutant server is caught by the intended check', () => {
  it.each(MUTANTS.map((m) => [m]))('%s', async (mutant) => {
    const expected = EXPECTED[mutant];
    const report = await runConformance(reference(mutant));
    const failed = failing(report);
    if (expected.exact) expect(failed).toEqual([...expected.fails].sort());
    else expect(failed).toEqual(expect.arrayContaining(expected.fails));
    expect(report.passed).toBe(expected.passes);
  });

  it('every MUST and SHOULD check is proven by at least one mutant', () => {
    const proven = new Set(Object.values(EXPECTED).flatMap((e) => e.fails));
    const gating = CHECKS.filter((c) => c.level !== 'INFO').map((c) => c.id);
    // prompts.list has no mutant: the reference server has no prompts. It is exercised against
    // server-everything in CI instead.
    expect(gating.filter((id) => !proven.has(id))).toEqual([
      'lifecycle.version-known',
      'prompts.list',
    ]);
  });
});
