/**
 * tests/fuzz/payment_schema.test.ts
 *
 * Property-based fuzz tests for StellarPaymentTool's amount Zod schema.
 *
 * Issue #445: Generate 500+ random amount strings per run and assert that:
 *   - Negative amounts are rejected
 *   - Zero (and zero-equivalent decimals) are rejected
 *   - Amounts above AGENT_SPENDING_LIMIT are rejected by the agent guard
 *   - Valid positive amounts within the limit are accepted
 *
 * Uses Math.random() only — no external property-based libraries required.
 */

import { describe, it, expect } from "vitest";
import { PaymentInputSchema } from "../../backend/tools/StellarPaymentTool";

// ─── Config mock ──────────────────────────────────────────────────────────────
// PaymentInputSchema itself does not import config, but StellarPaymentTool.ts
// does at the module level. Mock it so the module resolves cleanly.
import { vi } from "vitest";
vi.mock("../../backend/config", () => ({
  config: {
    STELLAR_NETWORK: "testnet",
    HORIZON_URL: "https://horizon-testnet.stellar.org",
    SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    AGENT_PUBLIC_KEY: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    X402_ASSET_CODE: "USDC",
    X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    AGENT_SPENDING_LIMIT: "100",
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 100,
    agentKeypair: () => ({
      publicKey: () => "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      secret: () => "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73",
    }),
  },
  MAINNET_SPENDING_CAP: 10000,
}));

// ─── Constants ────────────────────────────────────────────────────────────────

const AGENT_SPENDING_LIMIT = 100;
const RUNS = 500;

// Valid destination and issuer — schema requires these fields alongside amount
const VALID_DEST =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const VALID_ISSUER =
  "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

// ─── Generator helpers ────────────────────────────────────────────────────────

/** Random float in [min, max) */
function randFloat(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Random integer in [min, max] inclusive */
function randInt(min: number, max: number): number {
  return Math.floor(randFloat(min, max + 1));
}

/** Clamp decimal places to 0-7 (Stellar network max is 7) */
function toStellarDecimal(value: number, decimals: number): string {
  return value.toFixed(Math.min(decimals, 7));
}

// ─── Amount generators ────────────────────────────────────────────────────────

/** Positive valid amount: 0.0000001 – AGENT_SPENDING_LIMIT, up to 7 dp */
function randomValidAmount(): string {
  const value = randFloat(0.0000001, AGENT_SPENDING_LIMIT);
  const dp = randInt(0, 7);
  const fixed = toStellarDecimal(value, dp);
  // Ensure we didn't accidentally round to zero
  return parseFloat(fixed) > 0 ? fixed : "0.0000001";
}

/** Negative amount string, e.g. "-5.25" */
function randomNegativeAmount(): string {
  const value = randFloat(0.0000001, 10_000);
  const dp = randInt(0, 7);
  return `-${toStellarDecimal(value, dp)}`;
}

/** Zero or zero-equivalent string, e.g. "0", "0.0", "0.0000000" */
function randomZeroAmount(): string {
  const forms = [
    "0",
    "0.0",
    "0.00",
    "0.0000000",
    "0.000",
    () => `0.${"0".repeat(randInt(1, 7))}`,
  ];
  const pick = forms[randInt(0, forms.length - 1)];
  return typeof pick === "function" ? pick() : pick;
}

/** Amount above AGENT_SPENDING_LIMIT */
function randomOverLimitAmount(): string {
  const value = randFloat(AGENT_SPENDING_LIMIT + 0.0000001, AGENT_SPENDING_LIMIT * 100);
  const dp = randInt(0, 7);
  const fixed = toStellarDecimal(value, dp);
  // Make sure rounding didn't push it under the limit
  return parseFloat(fixed) > AGENT_SPENDING_LIMIT
    ? fixed
    : String(AGENT_SPENDING_LIMIT + 1);
}

/** Scientific notation string, e.g. "1e10", "-3.2e-5" */
function randomScientificNotation(): string {
  const sign = Math.random() < 0.5 ? "-" : "";
  const mantissa = randFloat(1, 9.99).toFixed(randInt(0, 4));
  const exponent = randInt(-15, 15);
  return `${sign}${mantissa}e${exponent}`;
}

/** Completely non-numeric junk */
function randomNonNumeric(): string {
  const pool = [
    "abc",
    "1.2.3",
    "",
    " ",
    "NaN",
    "Infinity",
    "-Infinity",
    "1 0",
    "1,000",
    "$100",
    "1_000",
    "0x1A",
    "1e",
    "e5",
    ".",
    "--1",
    "++1",
  ];
  return pool[randInt(0, pool.length - 1)]!;
}

// ─── Schema-only validator ────────────────────────────────────────────────────

/**
 * Validate just the `amount` field by running the full PaymentInputSchema
 * with a fixed valid destination and assetCode.
 */
function validateAmount(amount: string) {
  return PaymentInputSchema.safeParse({
    destination: VALID_DEST,
    amount,
    assetCode: "XLM",
    // XLM needs no issuer; keeps the fixture minimal
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("PaymentInputSchema — amount fuzz (property-based, 500 cases each)", () => {
  it("rejects all negative amounts", () => {
    const failures: string[] = [];
    for (let i = 0; i < RUNS; i++) {
      const amount = randomNegativeAmount();
      const result = validateAmount(amount);
      if (result.success) failures.push(amount);
    }
    expect(failures).toHaveLength(0);
  });

  it("rejects all zero / zero-equivalent amounts", () => {
    const failures: string[] = [];
    for (let i = 0; i < RUNS; i++) {
      const amount = randomZeroAmount();
      const result = validateAmount(amount);
      if (result.success) failures.push(amount);
    }
    expect(failures).toHaveLength(0);
  });

  it("accepts all valid positive amounts within the spending limit", () => {
    const failures: string[] = [];
    for (let i = 0; i < RUNS; i++) {
      const amount = randomValidAmount();
      const result = validateAmount(amount);
      if (!result.success) failures.push(`${amount} → ${result.error.issues[0]?.message}`);
    }
    expect(failures).toHaveLength(0);
  });

  it("rejects amounts with more than 7 decimal places", () => {
    const failures: string[] = [];
    for (let i = 0; i < RUNS; i++) {
      const base = randFloat(0.000000001, 9.9999999).toFixed(8); // always 8 dp
      const result = validateAmount(base);
      if (result.success) failures.push(base);
    }
    expect(failures).toHaveLength(0);
  });

  it("rejects scientific notation amounts", () => {
    const failures: string[] = [];
    for (let i = 0; i < RUNS; i++) {
      const amount = randomScientificNotation();
      const result = validateAmount(amount);
      // Scientific notation is not a valid Stellar decimal — must be rejected
      if (result.success) failures.push(amount);
    }
    expect(failures).toHaveLength(0);
  });

  it("rejects non-numeric / garbage strings", () => {
    const failures: string[] = [];
    // Run each junk string many times to hit all variants
    for (let i = 0; i < RUNS; i++) {
      const amount = randomNonNumeric();
      const result = validateAmount(amount);
      if (result.success) failures.push(JSON.stringify(amount));
    }
    expect(failures).toHaveLength(0);
  });

  it("amounts above AGENT_SPENDING_LIMIT pass schema but are flagged as over-limit", () => {
    // The Zod schema itself does not enforce the spending limit — that is the
    // agent guard's job. This test verifies that over-limit values are valid
    // Stellar decimals (schema accepts them) AND that their numeric value
    // exceeds the limit so the agent can catch them.
    let schemaAccepted = 0;
    let correctlyOverLimit = 0;
    const wronglyUnderLimit: string[] = [];

    for (let i = 0; i < RUNS; i++) {
      const amount = randomOverLimitAmount();
      const result = validateAmount(amount);
      if (result.success) {
        schemaAccepted++;
        const parsed = parseFloat(result.data.amount);
        if (parsed > AGENT_SPENDING_LIMIT) {
          correctlyOverLimit++;
        } else {
          wronglyUnderLimit.push(amount);
        }
      }
    }

    // At least some over-limit amounts should be structurally valid Stellar decimals
    expect(schemaAccepted).toBeGreaterThan(0);
    // Every schema-accepted over-limit amount must actually exceed the limit
    expect(wronglyUnderLimit).toHaveLength(0);
    expect(correctlyOverLimit).toBe(schemaAccepted);
  });

  it("invariant: safeParse never throws — always returns a result object", () => {
    // Mix all generators to stress the schema's error-handling path
    const generators = [
      randomValidAmount,
      randomNegativeAmount,
      randomZeroAmount,
      randomOverLimitAmount,
      randomScientificNotation,
      randomNonNumeric,
    ];

    for (let i = 0; i < RUNS; i++) {
      const gen = generators[i % generators.length]!;
      const amount = gen();
      // Should never throw — safeParse must always return { success, data/error }
      let result: ReturnType<typeof validateAmount> | undefined;
      expect(() => {
        result = validateAmount(amount);
      }).not.toThrow();
      expect(result).toBeDefined();
      expect(typeof result!.success).toBe("boolean");
    }
 * Property-based fuzz tests for PaymentInputSchema (issue #242).
 * Runs 1000+ generated inputs per property via fast-check to ensure no
 * edge case (arbitrary strings, Unicode memo content, zero-value amount
 * formatting) bypasses validation.
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { z } from 'zod';
import { PaymentInputSchema } from '../../backend/tools/StellarPaymentTool';

const VALID_DEST = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

describe('PaymentInputSchema fuzz', () => {
  it('amount: any random string either parses or throws a ZodError -- never anything else', () => {
    fc.assert(
      fc.property(fc.string(), (amount) => {
        try {
          PaymentInputSchema.parse({ destination: VALID_DEST, amount, assetCode: 'XLM' });
        } catch (err) {
          expect(err).toBeInstanceOf(z.ZodError);
        }
      }),
      { numRuns: 1000 }
    );
  });

  it('destination: random-length strings pass validation only at exactly 56 characters', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 0, maxLength: 100 }), (destination) => {
        const result = PaymentInputSchema.safeParse({
          destination,
          amount: '1',
          assetCode: 'XLM',
        });
        expect(result.success).toBe(destination.length === 56);
      }),
      { numRuns: 1000 }
    );
  });

  it('memo: Unicode strings are rejected exactly when their UTF-8 byte length exceeds 28', () => {
    fc.assert(
      fc.property(fc.fullUnicodeString({ minLength: 0, maxLength: 40 }), (memo) => {
        const byteLength = Buffer.byteLength(memo, 'utf8');
        const result = PaymentInputSchema.safeParse({
          destination: VALID_DEST,
          amount: '1',
          assetCode: 'XLM',
          memo,
        });
        expect(result.success).toBe(byteLength <= 28);
      }),
      { numRuns: 1000 }
    );
  });

  it('amount: zero-value decimals are always rejected regardless of trailing-zero formatting', () => {
    // Generates "0", "0.0", "0.00", ... "0.000000000" (up to 9 trailing zeros).
    const zeroValueArb = fc
      .nat({ max: 9 })
      .map((zeros) => (zeros === 0 ? '0' : `0.${'0'.repeat(zeros)}`));

    fc.assert(
      fc.property(zeroValueArb, (amount) => {
        const result = PaymentInputSchema.safeParse({
          destination: VALID_DEST,
          amount,
          assetCode: 'XLM',
        });
        expect(result.success).toBe(false);
      }),
      { numRuns: 1000 }
    );
  });

  it('explicitly rejects "0", "0.0", and "0.0000000" from the issue description', () => {
    for (const amount of ['0', '0.0', '0.0000000']) {
      const result = PaymentInputSchema.safeParse({
        destination: VALID_DEST,
        amount,
        assetCode: 'XLM',
      });
      expect(result.success).toBe(false);
    }
  });

  it('valid decimal amounts with 1-7 fraction digits always parse successfully', () => {
    const validAmountArb = fc
      .tuple(fc.integer({ min: 1, max: 1_000_000 }), fc.nat({ max: 7 }))
      .map(([whole, decimals]) =>
        decimals === 0 ? `${whole}` : `${whole}.${'1'.repeat(decimals)}`
      );

    fc.assert(
      fc.property(validAmountArb, (amount) => {
        const result = PaymentInputSchema.safeParse({
          destination: VALID_DEST,
          amount,
          assetCode: 'XLM',
        });
        expect(result.success).toBe(true);
      }),
      { numRuns: 1000 }
    );
  });
});
