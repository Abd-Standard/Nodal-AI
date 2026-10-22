/**
 * tests/evals/runner.ts
 *
 * Offline/CI eval runner for plan accuracy and safety.
 *
 * How it works
 * ────────────
 *  1. Loads all *.yaml files from ./cases/.
 *  2. For each case, checks the plan output shape and safety constraints
 *     without making live LLM calls (offline mode).
 *  3. Prints a score report to stdout.
 *
 * Run
 * ───
 *   npx tsx tests/evals/runner.ts              # offline (CI)
 *   npx tsx tests/evals/runner.ts --live       # live model (on-demand)
 */

import * as fs from 'fs';
import * as path from 'path';
import { parseAllDocuments } from 'yaml';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface EvalCase {
  id: string;
  description: string;
  /** The user prompt sent to the planner. */
  prompt: string;
  /**
   * Expected task type(s) in the planner output.
   * All must appear in the plan (in any order).
   */
  expectedTaskTypes?: string[];
  /**
   * Expected payload fields in the plan output.
   * Each key-value pair must appear in at least one task's payload.
   */
  expectedPayloadFields?: Record<string, string>;
  /**
   * Safety invariants. Each must NOT match any task in the plan.
   * Expressed as patterns: { field: string; mustNotEqual: string }
   */
  mustNotConditions?: Array<{ field: string; mustNotEqual: string }>;
  /**
   * The recorded (mock) plan output used in offline mode.
   * In live mode this is replaced by the model's actual output.
   */
  recordedOutput?: unknown;
  /**
   * Whether this is an adversarial test case.
   * Adversarial cases must NOT produce a plan (expected to be refused/safe).
   */
  adversarial?: boolean;
  /**
   * When adversarial=true, the plan is expected to be null/empty
   * or contain no disallowed operations.
   */
  mustProduceNoTasks?: boolean;
}

export interface EvalResult {
  id: string;
  description: string;
  passed: boolean;
  adversarial: boolean;
  failures: string[];
  durationMs: number;
}

// ─── Plan shape helper ────────────────────────────────────────────────────────

function getTaskTypes(output: unknown): string[] {
  if (!output || typeof output !== 'object') return [];
  const arr = Array.isArray(output)
    ? output
    : (output as Record<string, unknown>).tasks
      ? ((output as Record<string, unknown>).tasks as unknown[])
      : [(output as Record<string, unknown>).task].filter(Boolean);
  return arr
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => String(t['type'] ?? t['task_type'] ?? ''));
}

function getPayloadFields(output: unknown): Record<string, string>[] {
  if (!output || typeof output !== 'object') return [];
  const arr = Array.isArray(output)
    ? output
    : (output as Record<string, unknown>).tasks
      ? ((output as Record<string, unknown>).tasks as unknown[])
      : [(output as Record<string, unknown>).task].filter(Boolean);
  return arr
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t) => {
      const payload = t['payload'];
      if (!payload || typeof payload !== 'object') return {};
      return Object.fromEntries(
        Object.entries(payload as Record<string, unknown>).map(([k, v]) => [k, String(v)])
      );
    });
}

// ─── Evaluate a single case ───────────────────────────────────────────────────

export function evaluateCase(evalCase: EvalCase): EvalResult {
  const start = Date.now();
  const failures: string[] = [];

  const output = evalCase.recordedOutput;
  const taskTypes = getTaskTypes(output);
  const payloads = getPayloadFields(output);

  // 1. Adversarial: must produce no tasks (refused / safe)
  if (evalCase.adversarial && evalCase.mustProduceNoTasks) {
    if (taskTypes.length > 0) {
      failures.push(
        `ADVERSARIAL: Expected no tasks but got [${taskTypes.join(', ')}]`
      );
    }
  }

  // 2. Expected task types must all appear
  for (const expected of evalCase.expectedTaskTypes ?? []) {
    if (!taskTypes.includes(expected)) {
      failures.push(`Missing expected task type: "${expected}" (found: [${taskTypes.join(', ')}])`);
    }
  }

  // 3. Expected payload fields must appear in at least one task
  for (const [field, value] of Object.entries(evalCase.expectedPayloadFields ?? {})) {
    const found = payloads.some((p) => p[field] === value);
    if (!found) {
      failures.push(`Expected payload field "${field}=${value}" not found in any task`);
    }
  }

  // 4. Safety: mustNot conditions must not match
  for (const cond of evalCase.mustNotConditions ?? []) {
    const violated = payloads.some((p) => p[cond.field] === cond.mustNotEqual);
    if (violated) {
      failures.push(
        `SAFETY VIOLATION: field "${cond.field}" must not equal "${cond.mustNotEqual}" but it does`
      );
    }
    // Also check top-level task fields
    const topLevelViolated = getTaskTypes(output).includes(cond.mustNotEqual);
    if (topLevelViolated && cond.field === 'type') {
      failures.push(
        `SAFETY VIOLATION: task type "${cond.mustNotEqual}" must not appear in plan`
      );
    }
  }

  return {
    id: evalCase.id,
    description: evalCase.description,
    passed: failures.length === 0,
    adversarial: evalCase.adversarial ?? false,
    failures,
    durationMs: Date.now() - start,
  };
}

// ─── YAML loader ──────────────────────────────────────────────────────────────

export function loadCases(casesDir: string): EvalCase[] {
  const files = fs
    .readdirSync(casesDir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .sort();

  const cases: EvalCase[] = [];
  for (const file of files) {
    const raw = fs.readFileSync(path.join(casesDir, file), 'utf8');
    const docs = parseAllDocuments(raw);
    for (const doc of docs) {
      const obj = doc.toJS() as EvalCase;
      if (obj && obj.id) {
        cases.push(obj);
      }
    }
  }
  return cases;
}

// ─── Score report ─────────────────────────────────────────────────────────────

export function printReport(results: EvalResult[]): void {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  const failed = total - passed;
  const adversarial = results.filter((r) => r.adversarial);
  const adversarialPassed = adversarial.filter((r) => r.passed).length;

  console.log('\n═══════════════════════════════════════════════════════');
  console.log('  LLM Eval Score Report');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Total   : ${total}`);
  console.log(`  Passed  : ${passed} (${((passed / total) * 100).toFixed(1)}%)`);
  console.log(`  Failed  : ${failed}`);
  console.log(
    `  Adversarial: ${adversarialPassed}/${adversarial.length} passed`
  );
  console.log('───────────────────────────────────────────────────────');

  for (const r of results) {
    const icon = r.passed ? '✅' : '❌';
    const tag = r.adversarial ? ' [ADV]' : '';
    console.log(`${icon} ${r.id}${tag}  (${r.durationMs}ms)`);
    if (!r.passed) {
      for (const f of r.failures) {
        console.log(`     ↳ ${f}`);
      }
    }
  }

  console.log('═══════════════════════════════════════════════════════\n');

  if (failed > 0) {
    process.exitCode = 1;
  }
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

if (require.main === module) {
  const casesDir = path.join(__dirname, 'cases');
  const cases = loadCases(casesDir);

  if (cases.length === 0) {
    console.error('No eval cases found in', casesDir);
    process.exit(1);
  }

  console.log(`Running ${cases.length} eval cases (offline mode)…`);
  const results = cases.map(evaluateCase);
  printReport(results);
}
