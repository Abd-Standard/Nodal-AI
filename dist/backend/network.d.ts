/**
 * backend/network.ts
 *
 * Rate-limit aware network handler for Horizon/Soroban RPC calls.
 * Detects HTTP 429 responses, extracts Retry-After, and pauses outbound traffic.
 */
export interface BackoffState {
    active: boolean;
    until: number;
    retryAfterSeconds: number;
    queue: Array<() => void>;
}
/**
 * Check whether the network is currently throttled.
 * Callers should check this before making outbound calls.
 */
export declare function isThrottled(): boolean;
/**
 * Notify the network layer that a 429 response was received.
 * Extracts the Retry-After header value and activates the backoff lock.
 *
 * @param retryAfterHeader - Value of the Retry-After header (seconds), or a fallback.
 */
export declare function handleRateLimitResponse(retryAfterHeader?: string | null): void;
/**
 * If throttled, enqueue the callback to be called when the lock clears.
 * If not throttled, executes immediately.
 */
export declare function withBackoffGuard<T>(fn: () => Promise<T>): Promise<T>;
/**
 * Returns the current backoff status for telemetry/monitoring.
 */
export declare function getBackoffStatus(): {
    active: boolean;
    retryAfterSeconds: number;
    queueSize: number;
};
//# sourceMappingURL=network.d.ts.map