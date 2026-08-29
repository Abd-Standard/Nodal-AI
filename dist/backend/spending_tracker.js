"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SpendingTracker = void 0;
const config_1 = require("./config");
const logger_1 = require("./logger");
/**
 * Simple in‑memory spending tracker that records each payment amount and
 * maintains a rolling time window. It is used by the agent to enforce a
 * cumulative spending limit within `config.SPENDING_WINDOW_MS`.
 */
class SpendingTracker {
    windowMs;
    records = [];
    constructor(windowMs = config_1.config.SPENDING_WINDOW_MS) {
        this.windowMs = windowMs;
    }
    /**
     * Record a payment amount. The amount is expected to be a numeric string.
     * Throws if the new cumulative total exceeds `config.AGENT_SPENDING_LIMIT`.
     */
    record(amountStr) {
        const amount = parseFloat(amountStr);
        if (isNaN(amount))
            return; // let callers handle invalid input
        const now = Date.now();
        this.pruneOld(now);
        this.records.push({ amount, timestamp: now });
        const total = this.total();
        const limit = parseFloat(config_1.config.AGENT_SPENDING_LIMIT);
        if (!isNaN(total) && !isNaN(limit)) {
            if (total > limit * 0.8) {
                logger_1.logger.warn("Approaching spending limit", { total, limit, percent: (total / limit * 100).toFixed(1) });
            }
            if (total > limit) {
                throw new Error(`Cumulative spending ${total} exceeds limit ${limit}`);
            }
        }
    }
    /** Return the total amount spent within the current window. */
    total() {
        const now = Date.now();
        this.pruneOld(now);
        return this.records.reduce((sum, r) => sum + r.amount, 0);
    }
    pruneOld(now) {
        const cutoff = now - this.windowMs;
        while (this.records.length > 0) {
            const first = this.records[0];
            if (first && first.timestamp < cutoff) {
                this.records.shift();
            }
            else {
                break;
            }
        }
    }
    clear() {
        this.records = [];
    }
}
exports.SpendingTracker = SpendingTracker;
//# sourceMappingURL=spending_tracker.js.map