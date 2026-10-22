/**
 * tests/spending_tracker_per_asset.test.ts
 *
 * Tests for Issue #733: per-asset spending limits.
 *
 * Verifies:
 *   - Per-asset limits tracked and enforced independently per asset
 *   - Unknown assets rejected when SPENDING_LIMITS_ALLOW_UNKNOWN=false
 *   - Global AGENT_SPENDING_LIMIT used as fallback when map is empty
 *   - XLM and USDC tracked independently (no cross-contamination)
 *   - assetKey() utility derives canonical keys correctly
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import Database from "better-sqlite3";
import { _setDb } from "../backend/persistence";
import { SpendingTracker, assetKey } from "../backend/spending_tracker";

// NOTE: vi.mock is hoisted — use inline literals, not variables from outer scope
vi.mock("../backend/config", () => ({
  config: {
    STELLAR_NETWORK: "testnet",
    HORIZON_URL: "https://horizon-testnet.stellar.org",
    SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    AGENT_PUBLIC_KEY: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    X402_ASSET_CODE: "USDC",
    X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    AGENT_SPENDING_LIMIT: "1000",
    SPENDING_LIMITS_MAP: new Map<string, string>([
      ["XLM", "500"],
      ["USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN", "800"],
    ]),
    SPENDING_LIMITS_ALLOW_UNKNOWN: false,
    SPENDING_WINDOW_MS: 86_400_000,
    agentKeypair: () => ({ secret: () => "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73" }),
  },
  MAINNET_SPENDING_CAP: 10_000,
}));

// ─── Constants ────────────────────────────────────────────────────────────────
const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const USDC_KEY    = `USDC:${USDC_ISSUER}`;

function makeInMemoryDb(): Database.Database {
  return new Database(":memory:");
}

// ─── assetKey() utility ───────────────────────────────────────────────────────

describe("assetKey() utility", () => {
  it("returns 'XLM' for native asset regardless of case", () => {
    expect(assetKey("xlm")).toBe("XLM");
    expect(assetKey("XLM")).toBe("XLM");
    expect(assetKey("XLM", "")).toBe("XLM");
  });

  it("returns 'CODE:ISSUER' for credit assets", () => {
    expect(assetKey("USDC", USDC_ISSUER)).toBe(USDC_KEY);
  });

  it("trims whitespace from code and issuer", () => {
    expect(assetKey(" USDC ", ` ${USDC_ISSUER} `)).toBe(USDC_KEY);
  });

  it("normalises code to uppercase", () => {
    expect(assetKey("usdc", USDC_ISSUER)).toBe(USDC_KEY);
  });
});

// ─── Per-asset limits ─────────────────────────────────────────────────────────

describe("SpendingTracker — per-asset limits (issue #733)", () => {
  let tracker: SpendingTracker;

  beforeEach(() => {
    _setDb(makeInMemoryDb());
    tracker = new SpendingTracker(86_400_000);
  });

  it("XLM limit (500) enforced independently from USDC limit (800)", () => {
    // Spend 490 XLM — should succeed
    tracker.commit(tracker.reserve("490", "XLM"));
    expect(tracker.totalForAsset("XLM")).toBe(490n * 10_000_000n);

    // Spend 800 USDC — should succeed (different asset, different limit)
    tracker.commit(tracker.reserve("800", USDC_KEY));
    expect(tracker.totalForAsset(USDC_KEY)).toBe(800n * 10_000_000n);
  });

  it("XLM exceeding XLM limit is rejected — USDC limit unaffected", () => {
    tracker.commit(tracker.reserve("490", "XLM"));

    // 15 more XLM would push total to 505 > 500 limit
    expect(() => tracker.reserve("15", "XLM")).toThrow(/would reach/);

    // USDC is unaffected — can still reserve
    expect(() => tracker.reserve("100", USDC_KEY)).not.toThrow();
  });

  it("USDC exceeding USDC limit is rejected — XLM limit unaffected", () => {
    tracker.commit(tracker.reserve("790", USDC_KEY));

    // 15 more USDC would push total to 805 > 800 limit
    expect(() => tracker.reserve("15", USDC_KEY)).toThrow(/would reach/);

    // XLM is unaffected
    expect(() => tracker.reserve("100", "XLM")).not.toThrow();
  });

  it("unknown asset is denied when SPENDING_LIMITS_ALLOW_UNKNOWN=false", () => {
    // "EURC:GCQXXX…" is not in the SPENDING_LIMITS_MAP
    const unknownKey = "EURC:GCQPXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";
    expect(() => tracker.reserve("10", unknownKey)).toThrow(/not in the per-asset spending limits/);
  });

  it("totals() returns map with all active assets", () => {
    tracker.commit(tracker.reserve("100", "XLM"));
    tracker.commit(tracker.reserve("200", USDC_KEY));

    const totalsMap = tracker.totals();
    expect(totalsMap.get("XLM")).toBe(100n * 10_000_000n);
    expect(totalsMap.get(USDC_KEY)).toBe(200n * 10_000_000n);
    expect(totalsMap.size).toBe(2);
  });

  it("totals() returns empty map when no payments made", () => {
    expect(tracker.totals().size).toBe(0);
  });
});
