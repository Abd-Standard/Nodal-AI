/**
 * tests/fuzz/amount.test.ts
 *
 * Fuzz tests for backend/utils/amount.ts — Issue #734.
 *
 * Acceptance criteria:
 *   ✅ Random 7-decimal strings round-trip exactly (toStroops → fromStroops)
 *   ✅ Scientific notation rejected
 *   ✅ Hex rejected
 *   ✅ Whitespace rejected
 *   ✅ Negative values rejected
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { toStroops, fromStroops } from "../../backend/utils/amount";

// ── Round-trip ────────────────────────────────────────────────────────────────

describe("amount.ts — fuzz round-trip (Issue #734)", () => {
  it("random valid 7-decimal amount strings round-trip exactly", () => {
    fc.assert(
      fc.property(
        // Integer part: 0 to 999_999_999 (fits in a u64 stroop count)
        fc.integer({ min: 0, max: 999_999_999 }),
        // Fractional part: 0 to 9_999_999 (7 digits)
        fc.integer({ min: 0, max: 9_999_999 }),
        (intPart, fracPart) => {
          const fracStr = fracPart.toString().padStart(7, "0");
          const amountStr = `${intPart}.${fracStr}`;
          const stroops = toStroops(amountStr);
          const roundTripped = fromStroops(stroops);
          // Round-trip must be exactly equal
          expect(roundTripped).toBe(amountStr);
        }
      ),
      { numRuns: 1000 }
    );
  });

  it("integer amounts (no decimal) round-trip exactly", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000_000 }),
        (intPart) => {
          const amountStr = String(intPart);
          const stroops = toStroops(amountStr);
          const roundTripped = fromStroops(stroops);
          // fromStroops always returns 7 decimal places
          expect(roundTripped).toBe(`${intPart}.0000000`);
        }
      ),
      { numRuns: 500 }
    );
  });
});

// ── Rejection tests ───────────────────────────────────────────────────────────

describe("amount.ts — invalid input rejection (Issue #734)", () => {
  const INVALID_AMOUNTS = [
    "1e3",           // scientific notation
    "1E3",           // scientific notation (uppercase)
    "0x10",          // hex
    " 5 ",           // whitespace
    "5 ",            // trailing space
    " 5",            // leading space
    "-1",            // negative
    "-0.5000000",    // negative decimal
    "1.00000001",    // too many decimal places (8)
    "1.12345678",    // too many decimal places (8)
    "",              // empty string
    ".",             // just a dot
    ".5",            // no integer part
    "abc",           // non-numeric
    "1,000",         // comma separator
    "NaN",           // NaN
    "Infinity",      // Infinity
    "1.2.3",         // double dot
  ];

  for (const invalid of INVALID_AMOUNTS) {
    it(`rejects "${invalid}"`, () => {
      expect(() => toStroops(invalid)).toThrow();
    });
  }
});

// ── Known values ──────────────────────────────────────────────────────────────

describe("amount.ts — known stroop values", () => {
  it("1 XLM = 10_000_000 stroops", () => {
    expect(toStroops("1")).toBe(10_000_000n);
    expect(toStroops("1.0000000")).toBe(10_000_000n);
  });

  it("0.0000001 XLM = 1 stroop (minimum unit)", () => {
    expect(toStroops("0.0000001")).toBe(1n);
  });

  it("1.5 XLM = 15_000_000 stroops", () => {
    expect(toStroops("1.5")).toBe(15_000_000n);
    expect(toStroops("1.5000000")).toBe(15_000_000n);
  });

  it("100 XLM = 1_000_000_000 stroops", () => {
    expect(toStroops("100")).toBe(1_000_000_000n);
  });

  it("fromStroops(1n) = '0.0000001'", () => {
    expect(fromStroops(1n)).toBe("0.0000001");
  });

  it("fromStroops(10_000_000n) = '1.0000000'", () => {
    expect(fromStroops(10_000_000n)).toBe("1.0000000");
  });
});

// ── Property: toStroops is strictly monotone ─────────────────────────────────

describe("amount.ts — monotonicity", () => {
  it("larger amount string produces larger stroop value", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 500_000_000 }),
        fc.integer({ min: 1, max: 500_000_000 }),
        (a, b) => {
          // Build two valid amounts that are clearly ordered
          const smaller = `${Math.min(a, b)}.0000000`;
          const larger  = `${Math.max(a, b) + 1}.0000000`;
          expect(toStroops(larger)).toBeGreaterThan(toStroops(smaller));
        }
      ),
      { numRuns: 500 }
    );
  });
});
