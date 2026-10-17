/**
 * tests/llm_usage.test.ts
 *
 * Unit tests for backend/ai/llm.ts
 *
 * Acceptance criteria
 * ───────────────────
 *  ✓ Planner stops with a clear error at each cap (request, step, iteration, daily)
 *  ✓ Usage metrics are exported via getMetrics()
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { LlmUsageTracker, LlmBudgetError, LLM_LIMITS } from '../backend/ai/llm';

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTracker() {
  return new LlmUsageTracker();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('LlmUsageTracker', () => {
  let tracker: LlmUsageTracker;

  beforeEach(() => {
    tracker = makeTracker();
  });

  // ── assertStepBudget ────────────────────────────────────────────────────────

  describe('assertStepBudget', () => {
    it('allows a request within all limits', () => {
      expect(() => tracker.assertStepBudget('s1', 100)).not.toThrow();
    });

    it('throws request_cap when estimatedTokens exceeds maxTokensPerRequest', () => {
      const over = LLM_LIMITS.maxTokensPerRequest + 1;
      let caught: LlmBudgetError | null = null;
      try {
        tracker.assertStepBudget('s1', over);
      } catch (e) {
        caught = e as LlmBudgetError;
      }
      expect(caught).not.toBeNull();
      expect(caught).toBeInstanceOf(LlmBudgetError);
      expect(caught!.kind).toBe('request_cap');
      expect(caught!.message).toContain('per-request cap');
    });

    it('throws step_cap when cumulative step tokens exceed maxTokensPerStep', () => {
      // Fill up the step budget
      const half = Math.floor(LLM_LIMITS.maxTokensPerStep / 2);
      tracker.recordRequest({ sessionId: 's1', promptTokens: half, completionTokens: 0 });

      // Now request something that would push past the step cap
      const over = LLM_LIMITS.maxTokensPerStep - half + 1;
      let caught: LlmBudgetError | null = null;
      try {
        tracker.assertStepBudget('s1', over);
      } catch (e) {
        caught = e as LlmBudgetError;
      }
      expect(caught).not.toBeNull();
      expect(caught!.kind).toBe('step_cap');
      expect(caught!.message).toContain('step cap');
    });

    it('throws iteration_cap when tool-call iteration count is exhausted', () => {
      // Exhaust iterations one by one (keep tokens small)
      for (let i = 0; i < LLM_LIMITS.maxToolCallIterations; i++) {
        tracker.recordRequest({ sessionId: 's1', promptTokens: 1, completionTokens: 1 });
      }

      let caught: LlmBudgetError | null = null;
      try {
        tracker.assertStepBudget('s1', 1);
      } catch (e) {
        caught = e as LlmBudgetError;
      }
      expect(caught).not.toBeNull();
      expect(caught!.kind).toBe('iteration_cap');
      expect(caught!.message).toContain('iteration');
    });

    it('throws daily_cap when daily window total would be exceeded', () => {
      // Record most of the daily budget in small chunks
      const chunkSize = Math.min(100, LLM_LIMITS.maxTokensPerRequest);
      const chunksNeeded = Math.floor(LLM_LIMITS.maxTokensPerDay / (chunkSize * 2));
      for (let i = 0; i < chunksNeeded; i++) {
        // Use different session IDs to avoid iteration_cap
        tracker.recordRequest({
          sessionId: `s${i}`,
          promptTokens: chunkSize,
          completionTokens: chunkSize,
        });
      }

      // Now ask for something that would exceed the daily budget
      let caught: LlmBudgetError | null = null;
      try {
        tracker.assertStepBudget('sfinal', LLM_LIMITS.maxTokensPerDay);
      } catch (e) {
        caught = e as LlmBudgetError;
      }
      expect(caught).not.toBeNull();
      expect(caught!.kind).toBe('daily_cap');
      expect(caught!.message).toContain('Daily token budget');
    });
  });

  // ── recordRequest ───────────────────────────────────────────────────────────

  describe('recordRequest', () => {
    it('records prompt + completion tokens', () => {
      tracker.recordRequest({ sessionId: 's1', promptTokens: 200, completionTokens: 300 });
      const usage = tracker.getSessionUsage('s1');
      expect(usage).not.toBeNull();
      expect(usage!.totalTokens).toBe(500);
      expect(usage!.toolCallIterations).toBe(1);
    });

    it('increments the iteration counter', () => {
      tracker.recordRequest({ sessionId: 's1', promptTokens: 10, completionTokens: 10 });
      tracker.recordRequest({ sessionId: 's1', promptTokens: 10, completionTokens: 10 });
      const usage = tracker.getSessionUsage('s1');
      expect(usage!.toolCallIterations).toBe(2);
    });

    it('throws request_cap when actual tokens exceed maxTokensPerRequest', () => {
      expect(() =>
        tracker.recordRequest({
          sessionId: 's1',
          promptTokens: LLM_LIMITS.maxTokensPerRequest,
          completionTokens: 1,
        })
      ).toThrow(LlmBudgetError);
    });
  });

  // ── beginStep ───────────────────────────────────────────────────────────────

  describe('beginStep', () => {
    it('resets the per-step token counter without losing iteration count', () => {
      tracker.recordRequest({ sessionId: 's1', promptTokens: 100, completionTokens: 100 });
      tracker.beginStep('s1');
      const usage = tracker.getSessionUsage('s1');
      expect(usage!.tokensThisStep).toBe(0);
      expect(usage!.toolCallIterations).toBe(1); // preserved
    });
  });

  // ── getMetrics ──────────────────────────────────────────────────────────────

  describe('getMetrics', () => {
    it('returns a snapshot with correct shape', () => {
      const metrics = tracker.getMetrics();
      expect(metrics).toHaveProperty('dailyTokensUsed');
      expect(metrics).toHaveProperty('dailyTokensLimit');
      expect(metrics).toHaveProperty('dailyUsageFraction');
      expect(metrics).toHaveProperty('lifetimeTokens');
      expect(metrics).toHaveProperty('lifetimeRequests');
      expect(metrics).toHaveProperty('activeSessions');
      expect(metrics).toHaveProperty('maxTokensPerRequest');
      expect(metrics).toHaveProperty('maxTokensPerStep');
      expect(metrics).toHaveProperty('maxToolCallIterations');
      expect(metrics).toHaveProperty('windowStart');
    });

    it('reflects recorded tokens in daily usage', () => {
      tracker.recordRequest({ sessionId: 's1', promptTokens: 50, completionTokens: 50 });
      const metrics = tracker.getMetrics();
      expect(metrics.dailyTokensUsed).toBe(100);
      expect(metrics.lifetimeTokens).toBe(100);
      expect(metrics.lifetimeRequests).toBe(1);
      expect(metrics.activeSessions).toBe(1);
    });

    it('dailyUsageFraction is between 0 and 1', () => {
      tracker.recordRequest({ sessionId: 's1', promptTokens: 10, completionTokens: 10 });
      const metrics = tracker.getMetrics();
      expect(metrics.dailyUsageFraction).toBeGreaterThan(0);
      expect(metrics.dailyUsageFraction).toBeLessThanOrEqual(1);
    });
  });

  // ── resetSession ────────────────────────────────────────────────────────────

  describe('resetSession', () => {
    it('clears session data', () => {
      tracker.recordRequest({ sessionId: 's1', promptTokens: 10, completionTokens: 10 });
      tracker.resetSession('s1');
      expect(tracker.getSessionUsage('s1')).toBeNull();
    });
  });
});
