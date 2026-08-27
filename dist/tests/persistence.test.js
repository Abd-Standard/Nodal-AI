"use strict";
/**
 * tests/persistence.test.ts
 *
 * Tests for backend/persistence.ts using an in-memory SQLite database.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const persistence_1 = require("../backend/persistence");
function makeInMemoryDb() {
    const db = new better_sqlite3_1.default(":memory:");
    db.exec(`
    CREATE TABLE IF NOT EXISTS agent_results (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp     TEXT    NOT NULL,
      taskType      TEXT    NOT NULL,
      success       INTEGER NOT NULL,
      data          TEXT,
      error         TEXT,
      correlationId TEXT
    )
  `);
    return db;
}
(0, vitest_1.beforeEach)(() => {
    (0, persistence_1._setDb)(makeInMemoryDb());
});
const TIMESTAMP = "2026-06-25T22:00:00.000Z";
function makeResult(overrides = {}) {
    return {
        success: true,
        taskType: "stellar_payment",
        data: { txHash: "abc123" },
        timestamp: TIMESTAMP,
        ...overrides,
    };
}
(0, vitest_1.describe)("persistence", () => {
    (0, vitest_1.it)("saves a successful result and retrieves it", () => {
        (0, persistence_1.saveResult)(makeResult());
        const results = (0, persistence_1.getResults)();
        (0, vitest_1.expect)(results).toHaveLength(1);
        const result = results[0];
        (0, vitest_1.expect)(result).toBeDefined();
        if (!result)
            return;
        (0, vitest_1.expect)(result.success).toBe(true);
        (0, vitest_1.expect)(result.taskType).toBe("stellar_payment");
        (0, vitest_1.expect)(result.timestamp).toBe(TIMESTAMP);
        (0, vitest_1.expect)(result.data.txHash).toBe("abc123");
    });
    (0, vitest_1.it)("saves a failed result and retrieves the error", () => {
        (0, persistence_1.saveResult)(makeResult({ success: false, data: undefined, error: "Network failure" }));
        const results = (0, persistence_1.getResults)();
        (0, vitest_1.expect)(results).toHaveLength(1);
        const result = results[0];
        (0, vitest_1.expect)(result).toBeDefined();
        if (!result)
            return;
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.error).toBe("Network failure");
        (0, vitest_1.expect)(result.data).toBeUndefined();
    });
    (0, vitest_1.it)("respects the limit parameter and returns results newest-first", () => {
        for (let i = 0; i < 5; i++) {
            (0, persistence_1.saveResult)(makeResult({ data: { index: i }, timestamp: `2026-06-25T22:0${i}:00.000Z` }));
        }
        const results = (0, persistence_1.getResults)(3);
        (0, vitest_1.expect)(results).toHaveLength(3);
        // Newest first — last inserted has the highest id
        const result = results[0];
        (0, vitest_1.expect)(result).toBeDefined();
        if (result) {
            (0, vitest_1.expect)(result.data.index).toBe(4);
        }
    });
    (0, vitest_1.it)("returns an empty array when no results have been saved", () => {
        (0, vitest_1.expect)((0, persistence_1.getResults)()).toEqual([]);
    });
    (0, vitest_1.it)("persists multiple task types independently", () => {
        (0, persistence_1.saveResult)(makeResult({ taskType: "stellar_payment" }));
        (0, persistence_1.saveResult)(makeResult({ taskType: "soroban_invoke", data: { result: "ok" } }));
        (0, persistence_1.saveResult)(makeResult({ taskType: "x402_respond", data: { protocol: "x402" } }));
        const results = (0, persistence_1.getResults)();
        (0, vitest_1.expect)(results).toHaveLength(3);
        const types = results.map((r) => r.taskType);
        (0, vitest_1.expect)(types).toContain("stellar_payment");
        (0, vitest_1.expect)(types).toContain("soroban_invoke");
        (0, vitest_1.expect)(types).toContain("x402_respond");
    });
});
//# sourceMappingURL=persistence.test.js.map