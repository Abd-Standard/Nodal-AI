/**
 * backend/ai/llm.ts
 *
 * LLM usage tracker — mirrors the payment spending-limit design so an
 * autonomous loop cannot silently burn credits without bound.
 *
 * Limits enforced
 * ───────────────
 *  • LLM_MAX_TOKENS_PER_REQUEST  – single LLM call cap (hard limit)
 *  • LLM_MAX_TOKENS_PER_STEP     – tokens allowed for one plan step
 *                                  (i.e. one tool-call iteration)
 *  • LLM_MAX_TOOL_CALL_ITERATIONS – max autonomous tool-call iterations
 *                                   before the planner must stop
 *  • LLM_MAX_TOKENS_PER_DAY      – rolling 24-hour window total
 *
 * All limits are read from environment variables (or fall back to safe
 * defaults) and validated at module load time.
 *
 * Usage
 * ─────
 *   import { llmUsage } from './llm';
 *
 *   // Before calling the LLM for a plan step
 *   llmUsage.assertStepBudget(sessionId, estimatedTokens);
 *
 *   // After receiving the response
 *   llmUsage.recordRequest({ sessionId, promptTokens, completionTokens });
 *
 *   // At /metrics
 *   const snapshot = llmUsage.getMetrics();
 */

import { createLogger } from '../utils/logger';

const log = createLogger('llm-usage');

// ─── Environment-driven limits ────────────────────────────────────────────────

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const LLM_LIMITS = {
  /** Hard cap on tokens consumed by a single LLM API call. */
  maxTokensPerRequest: envInt('LLM_MAX_TOKENS_PER_REQUEST', 8_000),
  /** Cap on cumulative tokens consumed within a single plan step (one tool-call iteration). */
  maxTokensPerStep: envInt('LLM_MAX_TOKENS_PER_STEP', 16_000),
  /** Maximum number of autonomous tool-call iterations the planner may perform per session. */
  maxToolCallIterations: envInt('LLM_MAX_TOOL_CALL_ITERATIONS', 25),
  /** Rolling 24-hour token budget shared across all sessions. */
  maxTokensPerDay: envInt('LLM_MAX_TOKENS_PER_DAY', 1_000_000),
} as const;

// ─── Token-budget exceeded error ──────────────────────────────────────────────

export class LlmBudgetError extends Error {
  readonly kind: 'request_cap' | 'step_cap' | 'iteration_cap' | 'daily_cap';

  constructor(kind: LlmBudgetError['kind'], message: string) {
    super(message);
    this.name = 'LlmBudgetError';
    this.kind = kind;
    Object.setPrototypeOf(this, LlmBudgetError.prototype);
  }
}

// ─── Per-session state ────────────────────────────────────────────────────────

interface SessionUsage {
  tokensThisStep: number;
  toolCallIterations: number;
  totalTokens: number;
}

// ─── Daily window record ──────────────────────────────────────────────────────

interface DailyRecord {
  tokens: number;
  timestamp: number; // ms since epoch
}

// ─── Public input type ────────────────────────────────────────────────────────

export interface RequestUsage {
  sessionId: string;
  promptTokens: number;
  completionTokens: number;
}

// ─── Metrics snapshot type ────────────────────────────────────────────────────

export interface LlmMetricsSnapshot {
  /** Tokens consumed in the last 24-hour rolling window. */
  dailyTokensUsed: number;
  /** Configured 24-hour token budget. */
  dailyTokensLimit: number;
  /** Fraction [0–1] of the daily budget consumed. */
  dailyUsageFraction: number;
  /** Total tokens recorded since process start. */
  lifetimeTokens: number;
  /** Total number of LLM requests recorded since process start. */
  lifetimeRequests: number;
  /** Active session count (sessions with at least one recorded request). */
  activeSessions: number;
  /** Configured per-request cap. */
  maxTokensPerRequest: number;
  /** Configured per-step cap. */
  maxTokensPerStep: number;
  /** Configured max tool-call iterations. */
  maxToolCallIterations: number;
  /** Timestamp (ISO-8601) when the current daily window started. */
  windowStart: string;
}

// ─── LLM Usage Tracker ────────────────────────────────────────────────────────

export class LlmUsageTracker {
  private readonly sessions = new Map<string, SessionUsage>();
  private readonly dailyRecords: DailyRecord[] = [];
  private readonly windowMs = 24 * 60 * 60 * 1_000; // 24 h

  private lifetimeTokens = 0;
  private lifetimeRequests = 0;

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Assert that a new request/step is within all applicable budgets.
   *
   * Call this BEFORE sending to the LLM so a hard limit prevents the call
   * entirely, mirroring how assertWithinSpendingLimit blocks payments.
   *
   * @param sessionId       - Caller-supplied session key.
   * @param estimatedTokens - Expected token count for this request (prompt + completion).
   * @throws {LlmBudgetError} when any cap would be exceeded.
   */
  assertStepBudget(sessionId: string, estimatedTokens: number): void {
    this.pruneDaily();

    // 1. Per-request cap
    if (estimatedTokens > LLM_LIMITS.maxTokensPerRequest) {
      throw new LlmBudgetError(
        'request_cap',
        `Estimated request tokens ${estimatedTokens} exceeds per-request cap ` +
          `of ${LLM_LIMITS.maxTokensPerRequest}`
      );
    }

    // 2. Per-step cap (cumulative within the current step)
    const session = this.getOrCreateSession(sessionId);
    const projectedStep = session.tokensThisStep + estimatedTokens;
    if (projectedStep > LLM_LIMITS.maxTokensPerStep) {
      throw new LlmBudgetError(
        'step_cap',
        `Plan step token budget exceeded for session "${sessionId}": ` +
          `${projectedStep} > ${LLM_LIMITS.maxTokensPerStep} (step cap)`
      );
    }

    // 3. Tool-call iteration cap
    if (session.toolCallIterations >= LLM_LIMITS.maxToolCallIterations) {
      throw new LlmBudgetError(
        'iteration_cap',
        `Tool-call iteration limit reached for session "${sessionId}": ` +
          `${session.toolCallIterations} >= ${LLM_LIMITS.maxToolCallIterations} iterations`
      );
    }

    // 4. Daily cap
    const dailyUsed = this.dailyTotal();
    const projectedDaily = dailyUsed + estimatedTokens;
    if (projectedDaily > LLM_LIMITS.maxTokensPerDay) {
      throw new LlmBudgetError(
        'daily_cap',
        `Daily token budget exceeded: ${projectedDaily} > ` +
          `${LLM_LIMITS.maxTokensPerDay}. Used so far: ${dailyUsed}`
      );
    }
  }

  /**
   * Record actual token consumption after a successful LLM response.
   *
   * Also increments the tool-call iteration counter for the session so the
   * planner can be stopped when maxToolCallIterations is reached.
   *
   * @throws {LlmBudgetError} if actual tokens exceed per-request or daily cap.
   */
  recordRequest(usage: RequestUsage): void {
    const { sessionId, promptTokens, completionTokens } = usage;
    const total = promptTokens + completionTokens;

    this.pruneDaily();

    // Hard check on actual (not estimated) request tokens
    if (total > LLM_LIMITS.maxTokensPerRequest) {
      throw new LlmBudgetError(
        'request_cap',
        `Actual request tokens ${total} exceed per-request cap of ` +
          `${LLM_LIMITS.maxTokensPerRequest}`
      );
    }

    // Daily hard check on actual totals
    const dailyUsed = this.dailyTotal();
    if (dailyUsed + total > LLM_LIMITS.maxTokensPerDay) {
      throw new LlmBudgetError(
        'daily_cap',
        `Recording ${total} tokens would exceed daily budget ` +
          `${LLM_LIMITS.maxTokensPerDay}. Used: ${dailyUsed}`
      );
    }

    // Commit to daily window
    this.dailyRecords.push({ tokens: total, timestamp: Date.now() });

    // Update session counters
    const session = this.getOrCreateSession(sessionId);
    session.tokensThisStep += total;
    session.toolCallIterations += 1;
    session.totalTokens += total;

    // Lifetime counters
    this.lifetimeTokens += total;
    this.lifetimeRequests += 1;

    const dailyNew = this.dailyTotal();
    const pct = ((dailyNew / LLM_LIMITS.maxTokensPerDay) * 100).toFixed(1);
    log.info(
      {
        sessionId,
        promptTokens,
        completionTokens,
        dailyUsed: dailyNew,
        dailyPct: pct,
        iterations: session.toolCallIterations,
      },
      'LLM request recorded'
    );

    if (dailyNew / LLM_LIMITS.maxTokensPerDay > 0.8) {
      log.warn(
        { dailyUsed: dailyNew, limit: LLM_LIMITS.maxTokensPerDay, pct },
        'Approaching daily token budget (>80%)'
      );
    }
  }

  /**
   * Signal that a new plan step is starting for a session.
   *
   * Resets the per-step token counter while preserving the iteration count
   * and lifetime totals, so the step cap is applied fresh per step.
   */
  beginStep(sessionId: string): void {
    const session = this.getOrCreateSession(sessionId);
    session.tokensThisStep = 0;
  }

  /**
   * Return the current usage metrics snapshot for export (e.g. /metrics).
   */
  getMetrics(): LlmMetricsSnapshot {
    this.pruneDaily();
    const dailyUsed = this.dailyTotal();
    const windowStart = new Date(Date.now() - this.windowMs).toISOString();

    return {
      dailyTokensUsed: dailyUsed,
      dailyTokensLimit: LLM_LIMITS.maxTokensPerDay,
      dailyUsageFraction: dailyUsed / LLM_LIMITS.maxTokensPerDay,
      lifetimeTokens: this.lifetimeTokens,
      lifetimeRequests: this.lifetimeRequests,
      activeSessions: this.sessions.size,
      maxTokensPerRequest: LLM_LIMITS.maxTokensPerRequest,
      maxTokensPerStep: LLM_LIMITS.maxTokensPerStep,
      maxToolCallIterations: LLM_LIMITS.maxToolCallIterations,
      windowStart,
    };
  }

  /**
   * Return usage stats for a single session.
   * Returns null when the session has never been seen.
   */
  getSessionUsage(sessionId: string): SessionUsage | null {
    return this.sessions.get(sessionId) ?? null;
  }

  /**
   * Reset a session's step counter and iteration count.
   * Useful in tests and when a session is explicitly restarted.
   */
  resetSession(sessionId: string): void {
    this.sessions.delete(sessionId);
    log.info({ sessionId }, 'LLM session reset');
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private getOrCreateSession(sessionId: string): SessionUsage {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = { tokensThisStep: 0, toolCallIterations: 0, totalTokens: 0 };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  private dailyTotal(): number {
    return this.dailyRecords.reduce((sum, r) => sum + r.tokens, 0);
  }

  private pruneDaily(): void {
    const cutoff = Date.now() - this.windowMs;
    while (this.dailyRecords.length > 0 && (this.dailyRecords[0]?.timestamp ?? 0) < cutoff) {
      this.dailyRecords.shift();
    }
  }
}

// ─── Process-wide singleton ───────────────────────────────────────────────────

export const llmUsage = new LlmUsageTracker();
