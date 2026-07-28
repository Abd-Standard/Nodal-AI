/**
 * tests/fuzz/x402_schema.test.ts
 *
 * Property-based fuzz tests for X402ChallengeSchema (issue #241) -- the x402
 * challenge schema is a security boundary (it's parsed directly from a
 * base64-decoded memo payload, see backend/agent.ts's stream handler), so it
 * must never hang, crash, or silently return something other than a parsed
 * value or a ZodError for arbitrary input.
 *
 * Previously this file used node:test + a `node:assert` import named
 * `expect` (which node:assert does not export) and only fuzzed raw strings
 * that mostly failed JSON.parse before ever reaching the schema -- it did
 * not actually run under this project's test runner (vitest picks up every
 * tests/**\/*.test.ts file per vitest.config.ts, and `npm run test:fuzz`
 * runs `vitest run tests/fuzz/**`) and barely exercised the schema. Rewritten
 * to use vitest (matching every other test file in this repo) and to fuzz
 * both arbitrary JSON-shaped values and structurally-valid challenge objects.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { z } from "zod";
import { X402ChallengeSchema } from "../../backend/tools/X402PaymentTool";

const VALID_PAY_TO = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

describe("X402ChallengeSchema fuzz", () => {
  it("never hangs, crashes, or returns anything other than a boolean `success` for arbitrary JSON values", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const result = X402ChallengeSchema.safeParse(value);
        expect(typeof result.success).toBe("boolean");
      }),
      { numRuns: 1000 }
    );
  });

  it("always either parses successfully or throws a ZodError -- never anything else", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        try {
          X402ChallengeSchema.parse(value);
        } catch (err) {
          expect(err).toBeInstanceOf(z.ZodError);
        }
      }),
      { numRuns: 1000 }
    );
  });

  it("accepts structurally-valid, semantically-plausible challenges", () => {
    const validChallengeArb = fc.record({
      resource: fc.webUrl(),
      amount: fc.string({ minLength: 1, maxLength: 20 }),
      assetCode: fc.constantFrom("XLM", "USDC"),
      assetIssuer: fc.constant(
        "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
      ),
      payTo: fc.constant(VALID_PAY_TO),
      nonce: fc.uuid({ version: 4 }),
      expiresAt: fc.date().map((d) => d.toISOString()),
    });

    fc.assert(
      fc.property(validChallengeArb, (challenge) => {
        const result = X402ChallengeSchema.safeParse(challenge);
        expect(result.success).toBe(true);
      }),
      { numRuns: 1000 }
    );
  });

  it("rejects a payTo that is not exactly 56 characters", () => {
    const invalidPayToArb = fc.record({
      resource: fc.webUrl(),
      amount: fc.string({ minLength: 1, maxLength: 20 }),
      assetCode: fc.constant("XLM"),
      assetIssuer: fc.constant(""),
      payTo: fc.string({ minLength: 0, maxLength: 100 }).filter((s) => s.length !== 56),
      nonce: fc.uuid({ version: 4 }),
      expiresAt: fc.date().map((d) => d.toISOString()),
    });

    fc.assert(
      fc.property(invalidPayToArb, (challenge) => {
        const result = X402ChallengeSchema.safeParse(challenge);
        expect(result.success).toBe(false);
      }),
      { numRuns: 1000 }
    );
  });

  it("rejects a non-XLM assetCode with an empty assetIssuer", () => {
    // Note: assetIssuer is omitted-with-default in the schema (falls back to
    // config.X402_ASSET_ISSUER when `undefined`), so an *explicit* empty
    // string is required here to actually exercise the "no issuer" branch of
    // the refine -- omitting the field would just pick up the config default.
    const missingIssuerArb = fc.record({
      resource: fc.webUrl(),
      amount: fc.string({ minLength: 1, maxLength: 20 }),
      assetCode: fc.constant("USDC"),
      assetIssuer: fc.constant(""),
      payTo: fc.constant(VALID_PAY_TO),
      nonce: fc.uuid({ version: 4 }),
      expiresAt: fc.date().map((d) => d.toISOString()),
    });

    fc.assert(
      fc.property(missingIssuerArb, (challenge) => {
        const result = X402ChallengeSchema.safeParse(challenge);
        expect(result.success).toBe(false);
      }),
      { numRuns: 1000 }
    );
  });
});
