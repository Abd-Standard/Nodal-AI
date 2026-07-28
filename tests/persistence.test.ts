/**
 * tests/persistence.test.ts
 *
 * Tests for backend/persistence.ts using an in-memory SQLite database.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { saveResult, getResults, _setDb } from "../backend/persistence";
import type { AgentResult } from "../backend/agent";

function makeInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
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

beforeEach(() => {
  _setDb(makeInMemoryDb());
});

const TIMESTAMP = "2026-06-25T22:00:00.000Z";

function makeResult(overrides: Partial<AgentResult> = {}): AgentResult & { timestamp: string } {
  return {
    success: true,
    taskType: "stellar_payment",
    data: { txHash: "abc123" },
    timestamp: TIMESTAMP,
    ...overrides,
  };
}

describe("persistence", () => {
  it("saves a successful result and retrieves it", () => {
    saveResult(makeResult());
    const results = getResults();
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(true);
    expect(results[0].taskType).toBe("stellar_payment");
    expect(results[0].timestamp).toBe(TIMESTAMP);
    expect((results[0].data as any).txHash).toBe("abc123");
  });

  it("saves a failed result and retrieves the error", () => {
    saveResult(makeResult({ success: false, data: undefined, error: "Network failure" }));
    const results = getResults();
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toBe("Network failure");
    expect(results[0].data).toBeUndefined();
  });

  it("respects the limit parameter and returns results newest-first", () => {
    for (let i = 0; i < 5; i++) {
      saveResult(makeResult({ data: { index: i }, timestamp: `2026-06-25T22:0${i}:00.000Z` }));
    }
    const results = getResults(3);
    expect(results).toHaveLength(3);
    // Newest first — last inserted has the highest id
    expect((results[0].data as any).index).toBe(4);
  });

  it("returns an empty array when no results have been saved", () => {
    expect(getResults()).toEqual([]);
  });

  it("persists multiple task types independently", () => {
    saveResult(makeResult({ taskType: "stellar_payment" }));
    saveResult(makeResult({ taskType: "soroban_invoke", data: { result: "ok" } }));
    saveResult(makeResult({ taskType: "x402_respond", data: { protocol: "x402" } }));

    const results = getResults();
    expect(results).toHaveLength(3);
    const types = results.map((r) => r.taskType);
    expect(types).toContain("stellar_payment");
    expect(types).toContain("soroban_invoke");
    expect(types).toContain("x402_respond");
  });
});
