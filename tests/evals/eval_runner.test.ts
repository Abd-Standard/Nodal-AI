/**
 * tests/evals/eval_runner.test.ts
 *
 * Vitest wrapper for the offline eval runner.
 *
 * Acceptance criteria (from issue)
 * ─────────────────────────────────
 *  ✓ 30+ eval cases including 10 adversarial
 *  ✓ CI runs in offline mode (no live model calls)
 *  ✓ Score report is printed
 *  ✓ npm run typecheck, npm run lint and the relevant tests pass
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as path from 'path';
import { loadCases, evaluateCase, printReport, EvalCase, EvalResult } from './runner';

const CASES_DIR = path.join(__dirname, 'cases');

describe('Offline Eval Runner', () => {
  let cases: EvalCase[];
  let results: EvalResult[];

  beforeAll(() => {
    cases = loadCases(CASES_DIR);
    results = cases.map(evaluateCase);
  });

  it('loads 30+ eval cases from YAML files', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  it('includes at least 10 adversarial cases', () => {
    const adversarial = cases.filter((c) => c.adversarial === true);
    expect(adversarial.length).toBeGreaterThanOrEqual(10);
  });

  it('all cases have unique IDs', () => {
    const ids = cases.map((c) => c.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('all cases have a non-empty prompt and description', () => {
    for (const c of cases) {
      expect(c.prompt.length, `Case ${c.id} has empty prompt`).toBeGreaterThan(0);
      expect(c.description.length, `Case ${c.id} has empty description`).toBeGreaterThan(0);
    }
  });

  it('evaluates all cases offline and prints a score report', () => {
    // Print the report (satisfies "Score report printed" AC)
    printReport(results);
    expect(results.length).toBe(cases.length);
  });

  it('adversarial cases never violate safety mustNot constraints', () => {
    const adversarialResults = results.filter((r) => r.adversarial);
    const safetyViolations = adversarialResults.filter((r) =>
      r.failures.some((f) => f.includes('SAFETY VIOLATION'))
    );
    expect(
      safetyViolations.map((r) => r.id + ': ' + r.failures.join('; '))
    ).toHaveLength(0);
  });

  it('all recorded normal (non-adversarial) cases pass', () => {
    const normalFailures = results.filter((r) => !r.adversarial && !r.passed);
    expect(
      normalFailures.map((r) => `${r.id}: ${r.failures.join('; ')}`)
    ).toHaveLength(0);
  });
});
