/**
 * backend/network.ts
 *
 * Rate-limit aware network handler for Horizon/Soroban RPC calls.
 * Detects HTTP 429 responses, extracts Retry-After, and pauses outbound traffic.
 */

import { createLogger } from './utils/logger';

const log = createLogger('network');

// ─── Backoff state ────────────────────────────────────────────────

export interface BackoffState {
  active: boolean;
  until: number; // timestamp (ms) when the lock expires
  retryAfterSeconds: number;
  queue: Array<() => void>; // callbacks waiting for the lock to clear
  generation: number; // incremented on each new backoff activation
}

const globalBackoff: BackoffState = {
  active: false,
  until: 0,
  retryAfterSeconds: 0,
  queue: [],
  generation: 0,
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
  globalBackoff.generation += 1;
  const generation = globalBackoff.generation;

  log.warn(`[Network] Rate limit reached. Throttling outbound traffic for ${waitSeconds} seconds.`);

  // Schedule auto-clear when the backoff expires. The generation is captured
  // here so that if a newer backoff activation supersedes this one before
  // this timer fires, the stale timer becomes a no-op instead of clearing
  // (and draining the queue of) the newer, still-active backoff.
  const remaining = globalBackoff.until - Date.now();
  setTimeout(() => {
    clearBackoff(generation);
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

  // Enqueue and wait for lock to clear. The generation is captured at
  // enqueue time so a callback that outlives its own backoff activation
  // (superseded by a newer one before it gets drained) is rejected instead
  // of running under a since-changed backoff state.
  const enqueuedGeneration = globalBackoff.generation;
  return new Promise<T>((resolve, reject) => {
    globalBackoff.queue.push(() => {
      if (globalBackoff.generation !== enqueuedGeneration) {
        reject(new Error('Backoff superseded before queued callback could run'));
        return;
      }
      fn().then(resolve).catch(reject);
    });
  });
}

/**
 * Returns the current backoff status for telemetry/monitoring.
 */
export function getBackoffStatus(): {
  active: boolean;
  retryAfterSeconds: number;
  queueSize: number;
} {
  return {
    active: globalBackoff.active,
    retryAfterSeconds: globalBackoff.retryAfterSeconds,
    queueSize: globalBackoff.queue.length,
  };
}

// ─── CAIP-2 network identifiers (#775) ─────────────────────────────

/** Network names as configured in STELLAR_NETWORK. */
export type StellarNetworkName = 'testnet' | 'mainnet' | 'futurenet';

const CAIP2_BY_NETWORK = {
  testnet: 'stellar:testnet',
  mainnet: 'stellar:pubnet',
  futurenet: 'stellar:futurenet',
} as const satisfies Record<StellarNetworkName, string>;

/** CAIP-2 chain identifier for a Stellar network, as used by x402 v2. */
export type Caip2NetworkId = (typeof CAIP2_BY_NETWORK)[StellarNetworkName];

/**
 * CAIP-2 identifier for a configured network name: `testnet` → `stellar:testnet`,
 * `mainnet` → `stellar:pubnet`, `futurenet` → `stellar:futurenet`.
 *
 * @throws Error for an unknown network name.
 */
export function toCaip2(network: string): Caip2NetworkId {
  const id = CAIP2_BY_NETWORK[network as StellarNetworkName];
  if (!id) throw new Error(`Unknown Stellar network: ${network}`);
  return id;
}

/**
 * Configured network name for a CAIP-2 identifier — the inverse of {@link toCaip2}.
 *
 * @throws Error for an identifier that is not a known Stellar CAIP-2 chain ID.
 */
export function fromCaip2(id: string): StellarNetworkName {
  for (const [network, caip2] of Object.entries(CAIP2_BY_NETWORK)) {
    if (caip2 === id) return network as StellarNetworkName;
  }
  throw new Error(`Unknown Stellar CAIP-2 network identifier: ${id}`);
}

// ─── Internal ──────────────────────────────────────────────────────

function clearBackoff(generation?: number): void {
  if (generation !== undefined && generation !== globalBackoff.generation) {
    // A newer backoff activation has superseded this timer; skip clearing.
    return;
  }

  globalBackoff.active = false;
  globalBackoff.retryAfterSeconds = 0;
  globalBackoff.until = 0;

  log.info('[Network] Rate limit lock cleared — resuming normal traffic.');

  // Drain the queued callbacks
  const pending = globalBackoff.queue.splice(0);
  for (const cb of pending) {
    try {
      cb();
    } catch (err) {
      log.error({ error: (err as Error).message }, '[Network] Error executing queued callback');
    }
  }
}
