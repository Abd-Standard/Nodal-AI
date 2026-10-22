/**
 * tests/spending_tracker_persistence.test.ts
 *
 * Tests for Issue #731: SpendingTracker.rollback() must delete the persisted
 * row so rolled-back spend does not reappear after a process restart.
 *
 * Uses an in-memory SQLite DB injected via _setDb() to stay hermetic.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { _setDb, getSpendingRecordsSince } from "../backend/persistence";
import { SpendingTracker } from "../backend/spending_tracker";

// ─── Mock config ──────────────────────────────────────────────────────────────
vi.mock("../backend/config", () => ({
  config: {
    STELLAR_NETWORK: "testnet",
    HORIZON_URL: "https://horizon-testnet.stellar.org",
    SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    AGENT_PUBLIC_KEY: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    X402_ASSET_CODE: "USDC",
    X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    AGENT_SPENDING_LIMIT: "1000",
    SPENDING_LIMITS_MAP: new Map<string, string>(),
    SPENDING_LIMITS_ALLOW_UNKNOWN: true,
    SPENDING_WINDOW_MS: 86_400_000,
    agentKeypair: () => ({ secret: () => "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73" }),
  },
  MAINNET_SPENDING_CAP: 10_000,
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  return db; // _setDb will call initSchema
}

function cutoffIso(): string {
  return new Date(Date.now() - 86_400_000).toISOString();
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SpendingTracker — rollback deletes persisted row (issue #731)", () => {
  let tracker: SpendingTracker;

  beforeEach(() => {
    _setDb(makeInMemoryDb());
    tracker = new SpendingTracker(86_400_000);
  });

  it("rollback + restart: rolled-back amount is excluded from total", () => {
    // Reserve and immediately roll back
    const id = tracker.reserve("50", "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
    expect(tracker.totalForAsset("USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN")).toBe(500_000_000n); // 50 * 1e7

    tracker.rollback(id);
    // In-memory total should be 0 after rollback
    expect(tracker.totalForAsset("USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN")).toBe(0n);

    // Simulate restart: fresh tracker restores from DB
    const trackerAfterRestart = new SpendingTracker(86_400_000);
    trackerAfterRestart.restore();

    // The rolled-back row was deleted — total must still be 0
    expect(trackerAfterRestart.totalForAsset("USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN")).toBe(0n);
  });

  it("commit + restart: committed amount IS restored", () => {
    const id = tracker.reserve("100", "XLM");
    tracker.commit(id);
    expect(tracker.totalForAsset("XLM")).toBe(1_000_000_000n); // 100 * 1e7

    // Simulate restart
    const trackerAfterRestart = new SpendingTracker(86_400_000);
    trackerAfterRestart.restore();

    // Committed row is still in DB — total should be restored
    expect(trackerAfterRestart.totalForAsset("XLM")).toBe(1_000_000_000n);
  });

  it("rollback removes the row from spending_records table", () => {
    const id = tracker.reserve("75", "XLM");

    // Row should exist in DB
    const rowsBefore = getSpendingRecordsSince(cutoffIso());
    expect(rowsBefore.some((r) => r.id === id)).toBe(true);

    tracker.rollback(id);

    // Row should be gone from DB
    const rowsAfter = getSpendingRecordsSince(cutoffIso());
    expect(rowsAfter.some((r) => r.id === id)).toBe(false);
  });

  it("rollback is idempotent — second rollback does not throw", () => {
    const id = tracker.reserve("10", "XLM");
    tracker.rollback(id);
    // Second rollback on same id should not throw
    expect(() => tracker.rollback(id)).not.toThrow();
  });

  it("multiple commits accumulate correctly after restore", () => {
    tracker.commit(tracker.reserve("100", "XLM"));
    tracker.commit(tracker.reserve("200", "XLM"));

    const trackerAfterRestart = new SpendingTracker(86_400_000);
    trackerAfterRestart.restore();

    // 300 XLM = 3_000_000_000 stroops
    expect(trackerAfterRestart.totalForAsset("XLM")).toBe(3_000_000_000n);
  });
});
