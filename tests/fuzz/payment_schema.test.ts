/**
 * tests/fuzz/payment_schema.test.ts
 *
 * Property-based fuzz tests for PaymentInputSchema (issue #242).
 * Runs 1000+ generated inputs per property via fast-check to ensure no
 * edge case (arbitrary strings, Unicode memo content, zero-value amount
 * formatting) bypasses validation.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { z } from "zod";
import { PaymentInputSchema } from "../../backend/tools/StellarPaymentTool";

const VALID_DEST = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

describe("PaymentInputSchema fuzz", () => {
  it("amount: any random string either parses or throws a ZodError -- never anything else", () => {
    fc.assert(
      fc.property(fc.string(), (amount) => {
        try {
          PaymentInputSchema.parse({ destination: VALID_DEST, amount, assetCode: "XLM" });
        } catch (err) {
          expect(err).toBeInstanceOf(z.ZodError);
        }
      }),
      { numRuns: 1000 }
    );
  });

  it("destination: random-length strings pass validation only at exactly 56 characters", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 100 }), (destination) => {
        const result = PaymentInputSchema.safeParse({
          destination,
          amount: "1",
          assetCode: "XLM",
        });
        expect(result.success).toBe(destination.length === 56);
      }),
      { numRuns: 1000 }
    );
  });

  it("memo: Unicode strings are rejected exactly when their UTF-8 byte length exceeds 28", () => {
    fc.assert(
      fc.property(fc.fullUnicodeString({ minLength: 0, maxLength: 40 }), (memo) => {
        const byteLength = Buffer.byteLength(memo, "utf8");
        const result = PaymentInputSchema.safeParse({
          destination: VALID_DEST,
          amount: "1",
          assetCode: "XLM",
          memo,
        });
        expect(result.success).toBe(byteLength <= 28);
      }),
      { numRuns: 1000 }
    );
  });

  it("amount: zero-value decimals are always rejected regardless of trailing-zero formatting", () => {
    // Generates "0", "0.0", "0.00", ... "0.000000000" (up to 9 trailing zeros).
    const zeroValueArb = fc
      .nat({ max: 9 })
      .map((zeros) => (zeros === 0 ? "0" : `0.${"0".repeat(zeros)}`));

    fc.assert(
      fc.property(zeroValueArb, (amount) => {
        const result = PaymentInputSchema.safeParse({
          destination: VALID_DEST,
          amount,
          assetCode: "XLM",
        });
        expect(result.success).toBe(false);
      }),
      { numRuns: 1000 }
    );
  });

  it('explicitly rejects "0", "0.0", and "0.0000000" from the issue description', () => {
    for (const amount of ["0", "0.0", "0.0000000"]) {
      const result = PaymentInputSchema.safeParse({
        destination: VALID_DEST,
        amount,
        assetCode: "XLM",
      });
      expect(result.success).toBe(false);
    }
  });

  it("valid decimal amounts with 1-7 fraction digits always parse successfully", () => {
    const validAmountArb = fc
      .tuple(fc.integer({ min: 1, max: 1_000_000 }), fc.nat({ max: 7 }))
      .map(([whole, decimals]) =>
        decimals === 0 ? `${whole}` : `${whole}.${"1".repeat(decimals)}`
      );

    fc.assert(
      fc.property(validAmountArb, (amount) => {
        const result = PaymentInputSchema.safeParse({
          destination: VALID_DEST,
          amount,
          assetCode: "XLM",
        });
        expect(result.success).toBe(true);
      }),
      { numRuns: 1000 }
    );
  });
});
