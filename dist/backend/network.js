"use strict";
/**
 * backend/network.ts
 *
 * Rate-limit aware network handler for Horizon/Soroban RPC calls.
 * Detects HTTP 429 responses, extracts Retry-After, and pauses outbound traffic.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.isThrottled = isThrottled;
exports.handleRateLimitResponse = handleRateLimitResponse;
exports.withBackoffGuard = withBackoffGuard;
exports.getBackoffStatus = getBackoffStatus;
const logger_1 = require("./utils/logger");
const log = (0, logger_1.createLogger)("network");
const globalBackoff = {
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
function isThrottled() {
    if (!globalBackoff.active)
        return false;
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
function handleRateLimitResponse(retryAfterHeader) {
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
    log.warn(`[Network] Rate limit reached. Throttling outbound traffic for ${waitSeconds} seconds.`);
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
async function withBackoffGuard(fn) {
    if (!isThrottled()) {
        return fn();
    }
    // Enqueue and wait for lock to clear
    return new Promise((resolve, reject) => {
        globalBackoff.queue.push(() => {
            fn().then(resolve).catch(reject);
        });
    });
}
/**
 * Returns the current backoff status for telemetry/monitoring.
 */
function getBackoffStatus() {
    return {
        active: globalBackoff.active,
        retryAfterSeconds: globalBackoff.retryAfterSeconds,
        queueSize: globalBackoff.queue.length,
    };
}
// ─── Internal ──────────────────────────────────────────────────────
function clearBackoff() {
    globalBackoff.active = false;
    globalBackoff.retryAfterSeconds = 0;
    globalBackoff.until = 0;
    log.info("[Network] Rate limit lock cleared — resuming normal traffic.");
    // Drain the queued callbacks
    const pending = globalBackoff.queue.splice(0);
    for (const cb of pending) {
        try {
            cb();
        }
        catch (err) {
            log.error({ error: err.message }, "[Network] Error executing queued callback");
        }
    }
}
//# sourceMappingURL=network.js.map