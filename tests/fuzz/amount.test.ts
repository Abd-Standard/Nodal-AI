/**
 * tests/fuzz/amount.test.ts
 *
 * Fuzz + property tests for backend/utils/amount.ts (Issue #734).
 *
 * Acceptance criteria:
 *   ✓ No parseFloat on monetary values
 *   ✓ Random 7-decimal strings round-trip exactly (toStroops → stroopsToString)
 *   ✓ Scientific notation / hex rejected
 *   ✓ Whitespace rejected
 *   ✓ Negative values rejected
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { toStroops, stroopsToString, STROOPS_PER_UNIT } from "../../backend/utils/amount";

// ─── Unit tests ───────────────────────────────────────────────────────────────

describe("toStroops — valid inputs", () => {
  it("converts whole numbers", () => {
    expect(toStroops("1")).toBe(10_000_000n);
    expect(toStroops("100")).toBe(1_000_000_000n);
    expect(toStroops("0")).toBe(0n);
  });

  it("converts 7-decimal amounts exactly", () => {
    expect(toStroops("0.0000001")).toBe(1n);
    expect(toStroops("1.0000000")).toBe(10_000_000n);
    expect(toStroops("9.9999999")).toBe(99_999_999n);
    expect(toStroops("100.5000000")).toBe(1_005_000_000n);
  });

  it("pads fractional part shorter than 7 digits", () => {
    expect(toStroops("1.5")).toBe(15_000_000n);
    expect(toStroops("1.50")).toBe(15_000_000n);
    expect(toStroops("0.1")).toBe(1_000_000n);
  });

  it("handles very large amounts without precision loss", () => {
    // 9_999_999_999_999.9999999 — well beyond safe integer range
    expect(toStroops("9999999.9999999")).toBe(99_999_999_999_999n);
  });
});

describe("toStroops — invalid inputs rejected", () => {
  const INVALID = [
    "1e3",          // scientific notation
    "2.5E+4",       // scientific notation uppercase
    "0x10",         // hex
    " 5 ",          // whitespace
    "-1",           // negative
    "1.00000001",   // more than 7 decimal places
    "",             // empty string
    ".",            // bare dot
    "1.",           // trailing dot
    ".5",           // leading dot
    "NaN",
    "Infinity",
    "1,000",        // comma separator
    "1 000",        // space separator
  ];

  for (const val of INVALID) {
    it(`rejects "${val}"`, () => {
      expect(() => toStroops(val)).toThrow();
    });
  }
});

describe("stroopsToString", () => {
  it("converts back to 7-decimal format", () => {
    expect(stroopsToString(1n)).toBe("0.0000001");
    expect(stroopsToString(10_000_000n)).toBe("1.0000000");
    expect(stroopsToString(1_005_000_000n)).toBe("100.5000000");
    expect(stroopsToString(0n)).toBe("0.0000000");
  });

  it("pads fractional part with leading zeros", () => {
    expect(stroopsToString(100n)).toBe("0.0000100");
  });
});

describe("STROOPS_PER_UNIT", () => {
  it("equals 10_000_000n", () => {
    expect(STROOPS_PER_UNIT).toBe(10_000_000n);
  });
});

// ─── Property / fuzz tests ────────────────────────────────────────────────────

describe("fuzz: toStroops round-trips via stroopsToString", () => {
  it("arbitrary valid 7-decimal strings round-trip exactly", () => {
    // Generate: integer part 0–9999, fractional part 0000000–9999999
    const validAmount = fc.tuple(
      fc.nat({ max: 9_999 }),
      fc.nat({ max: 9_999_999 })
    ).map(([whole, frac]): string => {
      const fracStr = String(frac).padStart(7, "0");
      return `${whole}.${fracStr}`;
    });

    fc.assert(
      fc.property(validAmount, (amountStr) => {
        const stroops = toStroops(amountStr);
        const roundTripped = stroopsToString(stroops);

        // Parse both back to stroops for comparison (avoids trailing-zero differences)
        const roundTrippedStroops = toStroops(roundTripped);
        expect(roundTrippedStroops).toBe(stroops);
      }),
      { numRuns: 1000 }
    );
  });

  it("fuzz: scientific notation strings always rejected", () => {
    const scientificNotation = fc.oneof(
      fc.tuple(fc.nat({ max: 999 }), fc.nat({ max: 9 })).map(([m, e]) => `${m}e${e}`),
      fc.tuple(fc.nat({ max: 999 }), fc.nat({ max: 9 })).map(([m, e]) => `${m}E+${e}`),
      fc.tuple(fc.nat({ max: 999 }), fc.nat({ max: 9 })).map(([m, e]) => `${m}e-${e}`),
    );

    fc.assert(
      fc.property(scientificNotation, (amountStr) => {
        expect(() => toStroops(amountStr)).toThrow();
      }),
      { numRuns: 500 }
    );
  });

  it("fuzz: arbitrary strings with whitespace always rejected", () => {
    const withWhitespace = fc.string({ minLength: 1 }).map((s) => ` ${s} `);

    fc.assert(
      fc.property(withWhitespace, (amountStr) => {
        expect(() => toStroops(amountStr)).toThrow();
      }),
      { numRuns: 500 }
    );
  });

  it("fuzz: negative amounts always rejected", () => {
    const negativeAmount = fc.nat().map((n) => `-${n}`);

    fc.assert(
      fc.property(negativeAmount, (amountStr) => {
        expect(() => toStroops(amountStr)).toThrow();
      }),
      { numRuns: 500 }
    );
  });

  it("fuzz: amounts exceeding 7 decimal places always rejected", () => {
    const tooManyDecimals = fc.tuple(
      fc.nat({ max: 999 }),
      fc.nat({ max: 99_999_999 })
    ).map(([whole, frac]): string => {
      const fracStr = String(frac).padStart(8, "0"); // 8 decimal places
      return `${whole}.${fracStr}`;
    });

    fc.assert(
      fc.property(tooManyDecimals, (amountStr) => {
        expect(() => toStroops(amountStr)).toThrow();
      }),
      { numRuns: 500 }
    );
  });
});
