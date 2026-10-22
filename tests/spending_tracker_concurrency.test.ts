/**
 * tests/spending_tracker_concurrency.test.ts
 *
 * Tests for Issue #732: concurrent tasks must never collectively exceed the
 * spending limit even with MAX_CONCURRENT_TASKS > 1.
 *
 * The reserve() method is a synchronous critical section — check + push happen
 * in a single tick with no await gap, so concurrent async tasks are serialised
 * naturally in the JS event loop.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { _setDb } from "../backend/persistence";
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
    AGENT_SPENDING_LIMIT: "100",   // low limit: 100 units
    SPENDING_LIMITS_MAP: new Map<string, string>(),
    SPENDING_LIMITS_ALLOW_UNKNOWN: true,
    SPENDING_WINDOW_MS: 86_400_000,
    agentKeypair: () => ({ secret: () => "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73" }),
  },
  MAINNET_SPENDING_CAP: 10_000,
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeInMemoryDb(): Database.Database {
  return new Database(":memory:");
}

/** Simulate an async payment: reserve → (async work) → commit/rollback */
async function simulatePayment(
  tracker: SpendingTracker,
  amount: string,
  assetKey: string,
  shouldSucceed: boolean,
  delayMs = 0
): Promise<{ reserved: boolean; error?: string }> {
  let reservationId: string;
  try {
    reservationId = tracker.reserve(amount, assetKey);
  } catch (err) {
    return { reserved: false, error: (err as Error).message };
  }

  // Simulate async tool execution (e.g., Stellar RPC call)
  if (delayMs > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }

  if (shouldSucceed) {
    tracker.commit(reservationId);
  } else {
    tracker.rollback(reservationId);
  }
  return { reserved: true };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SpendingTracker — concurrent reservation safety (issue #732)", () => {
  let tracker: SpendingTracker;

  beforeEach(() => {
    _setDb(makeInMemoryDb());
    tracker = new SpendingTracker(86_400_000);
  });

  it("20 parallel payments of 6 units each — total must never exceed limit of 100", async () => {
    const ASSET = "XLM";
    const LIMIT_STROOPS = 100n * 10_000_000n; // 100 units in stroops

    // Fire 20 concurrent payments of 6 units each (total attempt: 120)
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        simulatePayment(tracker, "6", ASSET, true)
      )
    );

    const succeeded = results.filter((r) => r.reserved).length;
    const failed    = results.filter((r) => !r.reserved).length;

    // Some must succeed, some must be rejected
    expect(succeeded).toBeGreaterThan(0);
    expect(failed).toBeGreaterThan(0);

    // Total in the tracker must never exceed the limit
    const total = tracker.totalForAsset(ASSET);
    expect(total).toBeLessThanOrEqual(LIMIT_STROOPS);

    // At most floor(100/6) = 16 payments can succeed
    expect(succeeded).toBeLessThanOrEqual(16);
  });

  it("sequential payments that exactly hit the limit — next one is rejected", () => {
    const ASSET = "XLM";

    // 10 payments of 10 units each = 100 units (hits limit exactly)
    for (let i = 0; i < 10; i++) {
      const id = tracker.reserve("10", ASSET);
      tracker.commit(id);
    }

    expect(tracker.totalForAsset(ASSET)).toBe(100n * 10_000_000n);

    // 11th payment should be rejected
    expect(() => tracker.reserve("1", ASSET)).toThrow(/would reach/);
  });

  it("rolled-back payments free up capacity for subsequent payments", async () => {
    const ASSET = "XLM";

    // Reserve 90 units
    const id1 = tracker.reserve("90", ASSET);
    // Reserve 5 units
    const id2 = tracker.reserve("5", ASSET);
    // Total so far = 95

    // Roll back the 90 unit reservation (payment failed)
    tracker.rollback(id1);
    // Total now = 5

    // Should now be able to reserve 90 units again
    expect(() => tracker.reserve("90", ASSET)).not.toThrow();

    // Commit the 5
    tracker.commit(id2);
  });

  it("parallel payments: committed spend equals sum of only successful reservations", async () => {
    const ASSET = "XLM";

    // 10 payments of 10 units each — limit is 100, so all 10 should be able to reserve
    // (10 * 10 = 100 exactly). Odd-indexed ones get rolled back.
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        simulatePayment(tracker, "10", ASSET, i % 2 === 0) // even=commit, odd=rollback
      )
    );

    // All 10 should have successfully reserved (10*10=100 = limit)
    const allReserved = results.every((r) => r.reserved);
    expect(allReserved).toBe(true);

    // After rollbacks: only even-indexed (5 payments) remain
    // 5 * 10 units = 50 units = 500_000_000 stroops
    const total = tracker.totalForAsset(ASSET);
    expect(total).toBe(50n * 10_000_000n);
    expect(total).toBeLessThanOrEqual(100n * 10_000_000n);
  });
});
