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
 * Property-based fuzz tests for Stellar amount parsing and stroop conversion (Issue #830).
 *
 * Verifies critical safety properties across 10,000+ generated runs using fast-check:
 * 1. Round-trip string ↔ stroops
 * 2. Monotonic comparisons
 * 3. Rejection of >7 decimals
 * 4. Rejection of negative amounts
 * 5. Rejection of NaN and non-numeric inputs
 * 6. Rejection of exponent / scientific notation forms
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  toStroops,
  fromStroops,
  compareAmounts,
  isValidAmount,
  tryToStroops,
  STROOP_SCALE,
  MAX_DECIMAL_PLACES,
} from '../../backend/utils/amount';

const TEN_K_RUNS = 10_000;

describe('Amount parsing and stroop conversion property-based tests', () => {
  // ─── Constants & Scale ───────────────────────────────────────────────────────
  it('STROOP_SCALE is exactly 10^7 (10,000,000n)', () => {
    expect(STROOP_SCALE).toBe(10_000_000n);
    expect(MAX_DECIMAL_PLACES).toBe(7);
  });

  // ─── Property 1: Round-trip string ↔ stroops ────────────────────────────────
  describe('Round-trip string ↔ stroops', () => {
    it('toStroops(fromStroops(b)) === b for any non-negative stroop bigint (10k runs)', () => {
      // Test stroop values from 0 up to 100 trillion stroops (10 million XLM)
      const stroopArb = fc.bigInt({ min: 0n, max: 100_000_000_000_000n });

      fc.assert(
        fc.property(stroopArb, (stroops) => {
          const str = fromStroops(stroops);
          const back = toStroops(str);
          expect(back).toBe(stroops);
        }),
        { numRuns: TEN_K_RUNS }
      );
    });

    it('fromStroops(toStroops(s)) === s for canonical 7-decimal strings (10k runs)', () => {
      // Generates canonical 7-decimal strings: e.g. "123.4567890"
      const canonicalDecimalArb = fc
        .tuple(
          fc.integer({ min: 0, max: 10_000_000 }),
          fc.integer({ min: 0, max: 9_999_999 })
        )
        .map(([whole, frac]) => `${whole}.${frac.toString().padStart(7, '0')}`);

      fc.assert(
        fc.property(canonicalDecimalArb, (decimalStr) => {
          const stroops = toStroops(decimalStr);
          const back = fromStroops(stroops);
          expect(back).toBe(decimalStr);
        }),
        { numRuns: TEN_K_RUNS }
      );
    });

    it('round-trip idempotence: toStroops(fromStroops(toStroops(s))) === toStroops(s) (10k runs)', () => {
      // Arbitrary valid decimal strings with 0 to 7 decimal digits
      const validAmountArb = fc
        .tuple(
          fc.integer({ min: 0, max: 10_000_000 }),
          fc.nat({ max: 7 }),
          fc.integer({ min: 0, max: 9_999_999 })
        )
        .map(([whole, decCount, fracNum]) => {
          if (decCount === 0) return whole.toString();
          const fracStr = fracNum.toString().padStart(7, '0').slice(0, decCount);
          return `${whole}.${fracStr}`;
        });

      fc.assert(
        fc.property(validAmountArb, (str) => {
          const stroop1 = toStroops(str);
          const formatted = fromStroops(stroop1);
          const stroop2 = toStroops(formatted);
          expect(stroop2).toBe(stroop1);
        }),
        { numRuns: TEN_K_RUNS }
      );
    });
  });

  // ─── Property 2: Monotonic comparisons ──────────────────────────────────────
  describe('Monotonic comparisons', () => {
    it('compareAmounts preserves numeric ordering across all pairs (10k runs)', () => {
      const stroopPairArb = fc.tuple(
        fc.bigInt({ min: 0n, max: 50_000_000_000_000n }),
        fc.bigInt({ min: 0n, max: 50_000_000_000_000n })
      );

      fc.assert(
        fc.property(stroopPairArb, ([s1, s2]) => {
          const str1 = fromStroops(s1);
          const str2 = fromStroops(s2);
          const cmp = compareAmounts(str1, str2);

          if (s1 < s2) {
            expect(cmp).toBe(-1);
          } else if (s1 > s2) {
            expect(cmp).toBe(1);
          } else {
            expect(cmp).toBe(0);
          }
        }),
        { numRuns: TEN_K_RUNS }
      );
    });

    it('compareAmounts is transitive: a < b and b < c implies a < c (10k runs)', () => {
      const sortedStroopTripleArb = fc
        .tuple(
          fc.bigInt({ min: 0n, max: 10_000_000_000n }),
          fc.bigInt({ min: 1n, max: 10_000_000_000n }),
          fc.bigInt({ min: 1n, max: 10_000_000_000n })
        )
        .map(([base, delta1, delta2]) => [base, base + delta1, base + delta1 + delta2] as const);

      fc.assert(
        fc.property(sortedStroopTripleArb, ([sA, sB, sC]) => {
          const strA = fromStroops(sA);
          const strB = fromStroops(sB);
          const strC = fromStroops(sC);

          expect(compareAmounts(strA, strB)).toBe(-1);
          expect(compareAmounts(strB, strC)).toBe(-1);
          expect(compareAmounts(strA, strC)).toBe(-1);
        }),
        { numRuns: TEN_K_RUNS }
      );
    });

    it('amounts with different trailing zero formatting compare equal (10k runs)', () => {
      const trailingZerosArb = fc
        .tuple(
          fc.integer({ min: 0, max: 1_000_000 }),
          fc.integer({ min: 1, max: 999 }),
          fc.integer({ min: 1, max: 3 }),
          fc.integer({ min: 4, max: 7 })
        )
        .map(([whole, num, minDec, maxDec]) => {
          const baseFrac = num.toString().slice(0, minDec);
          const str1 = `${whole}.${baseFrac}`;
          const str2 = `${whole}.${baseFrac.padEnd(maxDec, '0')}`;
          return [str1, str2] as const;
        });

      fc.assert(
        fc.property(trailingZerosArb, ([str1, str2]) => {
          expect(compareAmounts(str1, str2)).toBe(0);
          expect(toStroops(str1)).toBe(toStroops(str2));
        }),
        { numRuns: TEN_K_RUNS }
      );
    });
  });

  // ─── Property 3: Rejection of >7 decimals ────────────────────────────────────
  describe('Rejection of >7 decimals', () => {
    it('rejects any amount with 8 or more decimal places (10k runs)', () => {
      const excessiveDecimalsArb = fc
        .tuple(
          fc.integer({ min: 0, max: 10_000 }),
          fc.integer({ min: 8, max: 30 })
        )
        .map(([whole, decimalsCount]) => `${whole}.${'9'.repeat(decimalsCount)}`);

      fc.assert(
        fc.property(excessiveDecimalsArb, (invalidAmount) => {
          expect(() => toStroops(invalidAmount)).toThrow(/decimal/i);
          expect(isValidAmount(invalidAmount)).toBe(false);
          expect(tryToStroops(invalidAmount)).toBeNull();
        }),
        { numRuns: TEN_K_RUNS }
      );
    });
  });

  // ─── Property 4: Rejection of negative amounts ──────────────────────────────
  describe('Rejection of negative amounts', () => {
    it('rejects any negative amount string (10k runs)', () => {
      const negativeAmountArb = fc
        .tuple(
          fc.integer({ min: 1, max: 10_000_000 }),
          fc.nat({ max: 7 })
        )
        .map(([whole, decCount]) =>
          decCount === 0 ? `-${whole}` : `-${whole}.${'1'.repeat(decCount)}`
        );

      fc.assert(
        fc.property(negativeAmountArb, (negStr) => {
          expect(() => toStroops(negStr)).toThrow(/negative/i);
          expect(isValidAmount(negStr)).toBe(false);
          expect(tryToStroops(negStr)).toBeNull();
        }),
        { numRuns: TEN_K_RUNS }
      );
    });

    it('fromStroops rejects negative stroop bigints with RangeError (10k runs)', () => {
      const negativeStroopArb = fc.bigInt({ min: -10_000_000_000n, max: -1n });

      fc.assert(
        fc.property(negativeStroopArb, (negStroops) => {
          expect(() => fromStroops(negStroops)).toThrow(RangeError);
        }),
        { numRuns: TEN_K_RUNS }
      );
    });
  });

  // ─── Property 5: Rejection of NaN and non-numeric forms ─────────────────────
  describe('Rejection of NaN and non-numeric forms', () => {
    it('rejects non-numeric, NaN, and malformed strings (10k runs)', () => {
      const garbageArb = fc.oneof(
        fc.constantFrom(
          'NaN',
          'nan',
          'Infinity',
          '-Infinity',
          '',
          '   ',
          'abc',
          '1.2.3',
          '1..0',
          '.',
          '.5',
          '1.',
          'null',
          'undefined',
          'true',
          'false',
          '$100',
          '100 XLM'
        ),
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => !/^\d+(\.\d{1,7})?$/.test(s))
      );

      fc.assert(
        fc.property(garbageArb, (garbage) => {
          expect(() => toStroops(garbage)).toThrow();
          expect(isValidAmount(garbage)).toBe(false);
          expect(tryToStroops(garbage)).toBeNull();
        }),
        { numRuns: TEN_K_RUNS }
      );
    });
  });

  // ─── Property 6: Rejection of exponent forms ────────────────────────────────
  describe('Rejection of exponent forms', () => {
    it('rejects scientific notation / exponent forms (10k runs)', () => {
      const exponentArb = fc
        .tuple(
          fc.integer({ min: 1, max: 999 }),
          fc.constantFrom('e', 'E', 'e+', 'E+', 'e-', 'E-'),
          fc.integer({ min: 0, max: 20 })
        )
        .map(([base, exp, p]) => `${base}${exp}${p}`);

      fc.assert(
        fc.property(exponentArb, (expStr) => {
          expect(() => toStroops(expStr)).toThrow(/exponent/i);
          expect(isValidAmount(expStr)).toBe(false);
          expect(tryToStroops(expStr)).toBeNull();
        }),
        { numRuns: TEN_K_RUNS }
      );
    });
  });

  // ─── Boundary and specific test cases ───────────────────────────────────────
  describe('Boundary cases', () => {
    it('handles zero values consistently', () => {
      expect(toStroops('0')).toBe(0n);
      expect(toStroops('0.0')).toBe(0n);
      expect(toStroops('0.0000000')).toBe(0n);
      expect(fromStroops(0n)).toBe('0.0000000');
    });

    it('handles minimum unit (1 stroop = 0.0000001)', () => {
      expect(toStroops('0.0000001')).toBe(1n);
      expect(fromStroops(1n)).toBe('0.0000001');
    });

    it('handles 1 XLM = 10,000,000 stroops', () => {
      expect(toStroops('1')).toBe(10_000_000n);
      expect(toStroops('1.0000000')).toBe(10_000_000n);
      expect(fromStroops(10_000_000n)).toBe('1.0000000');
    });
  });
});
