/**
 * backend/network.ts
 *
 * Rate-limit aware network handler for Horizon/Soroban RPC calls.
 * Detects HTTP 429 responses, extracts Retry-After, and pauses outbound traffic.
 */

import { logger } from "./logger";
import { createLogger } from "./utils/logger";

const log = createLogger("network");

// ─── Backoff state ────────────────────────────────────────────────

export interface BackoffState {
  active: boolean;
  until: number;         // timestamp (ms) when the lock expires
  retryAfterSeconds: number;
  queue: Array<() => void>; // callbacks waiting for the lock to clear
}

const globalBackoff: BackoffState = {
  active: false,
  until: 0,
  retryAfterSeconds: 0,
  queue: [],
};

// ─── Public API ────────────────────────────────────────────────────

/**
 * Check whether the network is currently throttled.
 * Callers should check this before making outbound calls.
 */
export function isThrottled(): boolean {
  if (!globalBackoff.active) return false;
  if (Date.now() >= globalBackoff.until) {
    clearBackoff();
    return false;
  }
  return true;
}

/**
 * Notify the network layer that a 429 response was received.
 * Extracts the Retry-After header value and activates the backoff lock.
 *
 * @param retryAfterHeader - Value of the Retry-After header (seconds), or a fallback.
 */
export function handleRateLimitResponse(retryAfterHeader?: string | null): void {
  let waitSeconds = 30; // default fallback
  if (retryAfterHeader) {
    const parsed = parseInt(retryAfterHeader, 10);
    if (!isNaN(parsed) && parsed > 0) {
      waitSeconds = parsed;
    }
  }

  globalBackoff.active = true;
  globalBackoff.retryAfterSeconds = waitSeconds;
  globalBackoff.until = Date.now() + waitSeconds * 1000;

  log.warn([Network] Rate limit reached. Throttling outbound traffic for  seconds.);

  // Schedule auto-clear when the backoff expires
  const remaining = globalBackoff.until - Date.now();
  setTimeout(() => {
    clearBackoff();
  }, remaining);
}

/**
 * If throttled, enqueue the callback to be called when the lock clears.
 * If not throttled, executes immediately.
 */
export async function withBackoffGuard<T>(fn: () => Promise<T>): Promise<T> {
  if (!isThrottled()) {
    return fn();
  }

  // Enqueue and wait for lock to clear
  return new Promise<T>((resolve, reject) => {
    globalBackoff.queue.push(() => {
      fn().then(resolve).catch(reject);
    });
  });
}

/**
 * Returns the current backoff status for telemetry/monitoring.
 */
export function getBackoffStatus(): { active: boolean; retryAfterSeconds: number; queueSize: number } {
  return {
    active: globalBackoff.active,
    retryAfterSeconds: globalBackoff.retryAfterSeconds,
    queueSize: globalBackoff.queue.length,
  };
}

// ─── Internal ──────────────────────────────────────────────────────

function clearBackoff(): void {
  globalBackoff.active = false;
  globalBackoff.retryAfterSeconds = 0;
  globalBackoff.until = 0;

  log.info("[Network] Rate limit lock cleared — resuming normal traffic.");

  // Drain the queued callbacks
  const pending = globalBackoff.queue.splice(0);
  for (const cb of pending) {
    try {
      cb();
    } catch (err) {
      log.error("[Network] Error executing queued callback", { error: (err as Error).message });
    }
  }
}
