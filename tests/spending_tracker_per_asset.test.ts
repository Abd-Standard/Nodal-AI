/**
 * tests/spending_tracker_per_asset.test.ts
 *
 * Covers Issue #733: per-asset spending limits.
 *
 *   ✅ Per-asset limit config parsed and validated by Zod (config.test.ts covers that)
 *   ✅ Unknown asset → rejected unless explicitly allowed
 *   ✅ /spending reports per-asset usage (this covers tracker.report())
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { _setDb } from "../backend/persistence";

function makeInMemoryDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_results (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT    NOT NULL,
      taskType  TEXT    NOT NULL,
      success   INTEGER NOT NULL,
      data      TEXT,
      error     TEXT
    );
    CREATE TABLE IF NOT EXISTS spending_records (
      id        TEXT    PRIMARY KEY,
      assetCode TEXT    NOT NULL,
      issuer    TEXT,
      stroops   TEXT    NOT NULL,
      timestamp INTEGER NOT NULL
    );
  `);
  return db;
}

// ── Config mock with per-asset limits ─────────────────────────────────────────
// NOTE: vi.mock is hoisted to top-of-file by Vitest, so the factory must NOT
// reference variables defined in the test body. Use literal strings here.

vi.mock("../backend/config", () => ({
  config: {
    SPENDING_WINDOW_MS:   86_400_000,
    AGENT_SPENDING_LIMIT: "1000", // fallback — not used in per-asset mode
    SPENDING_LIMITS: [
      { assetCode: "XLM",  limit: "500" },
      {
        assetCode: "USDC",
        issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        limit: "200",
      },
    ],
    X402_ASSET_CODE: "XLM",
    STELLAR_NETWORK: "testnet",
  },
}));

import { SpendingTracker } from "../backend/spending_tracker";

// Literal issuer kept in sync with the vi.mock factory above
const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

describe("SpendingTracker per-asset limits — Issue #733", () => {
  beforeEach(() => {
    _setDb(makeInMemoryDb());
  });

  it("allows a payment within the XLM limit", async () => {
    const tracker = new SpendingTracker();
    await expect(tracker.reserve("xlm-1", "XLM", undefined, "100")).resolves.toBeUndefined();
  });

  it("allows a payment within the USDC limit", async () => {
    const tracker = new SpendingTracker();
    await expect(tracker.reserve("usdc-1", "USDC", USDC_ISSUER, "100")).resolves.toBeUndefined();
  });

  it("rejects when XLM total would exceed its limit", async () => {
    const tracker = new SpendingTracker();
    await tracker.reserve("xlm-2a", "XLM", undefined, "400");
    await expect(tracker.reserve("xlm-2b", "XLM", undefined, "200")).rejects.toThrow(/exceed/);
  });

  it("rejects when USDC total would exceed its limit", async () => {
    const tracker = new SpendingTracker();
    await tracker.reserve("usdc-2a", "USDC", USDC_ISSUER, "150");
    await expect(tracker.reserve("usdc-2b", "USDC", USDC_ISSUER, "100")).rejects.toThrow(/exceed/);
  });

  it("XLM and USDC limits are independent (XLM full does not block USDC)", async () => {
    const tracker = new SpendingTracker();
    await tracker.reserve("xlm-3", "XLM", undefined, "500"); // XLM at limit
    // USDC should still be available
    await expect(tracker.reserve("usdc-3", "USDC", USDC_ISSUER, "100")).resolves.toBeUndefined();
  });

  it("unknown asset is denied by default (#733)", async () => {
    const tracker = new SpendingTracker();
    await expect(
      tracker.reserve("btc-1", "BTC", "GBTCISSUERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", "1")
    ).rejects.toThrow(/not in the configured SPENDING_LIMITS/);
  });

  it("report() returns per-asset usage", async () => {
    const tracker = new SpendingTracker();
    await tracker.reserve("rep-1", "XLM",  undefined,   "100");
    tracker.commit("rep-1");
    await tracker.reserve("rep-2", "USDC", USDC_ISSUER, "50");
    tracker.commit("rep-2");

    const report = tracker.report();
    expect(report).toHaveLength(2);

    const xlmEntry  = report.find((r) => r.asset === "XLM");
    const usdcEntry = report.find((r) => r.asset.startsWith("USDC"));

    expect(xlmEntry).toBeDefined();
    expect(xlmEntry!.total).toBe("100.0000000");
    expect(xlmEntry!.limit).toBe("500");
    expect(xlmEntry!.remaining).toBe("400.0000000");

    expect(usdcEntry).toBeDefined();
    expect(usdcEntry!.total).toBe("50.0000000");
    expect(usdcEntry!.limit).toBe("200");
    expect(usdcEntry!.remaining).toBe("150.0000000");
  });
});
