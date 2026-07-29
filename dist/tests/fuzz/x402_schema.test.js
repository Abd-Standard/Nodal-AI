"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const fast_check_1 = __importDefault(require("fast-check"));
const zod_1 = require("zod");
const X402PaymentTool_1 = require("../../backend/tools/X402PaymentTool");
const VALID_PAY_TO = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
(0, vitest_1.describe)("X402ChallengeSchema fuzz", () => {
    (0, vitest_1.it)("never hangs, crashes, or returns anything other than a boolean `success` for arbitrary JSON values", () => {
        fast_check_1.default.assert(fast_check_1.default.property(fast_check_1.default.jsonValue(), (value) => {
            const result = X402PaymentTool_1.X402ChallengeSchema.safeParse(value);
            (0, vitest_1.expect)(typeof result.success).toBe("boolean");
        }), { numRuns: 1000 });
    });
    (0, vitest_1.it)("always either parses successfully or throws a ZodError -- never anything else", () => {
        fast_check_1.default.assert(fast_check_1.default.property(fast_check_1.default.jsonValue(), (value) => {
            try {
                X402PaymentTool_1.X402ChallengeSchema.parse(value);
            }
            catch (err) {
                (0, vitest_1.expect)(err).toBeInstanceOf(zod_1.z.ZodError);
            }
        }), { numRuns: 1000 });
    });
    (0, vitest_1.it)("accepts structurally-valid, semantically-plausible challenges", () => {
        const validChallengeArb = fast_check_1.default.record({
            resource: fast_check_1.default.webUrl(),
            amount: fast_check_1.default.string({ minLength: 1, maxLength: 20 }),
            assetCode: fast_check_1.default.constantFrom("XLM", "USDC"),
            assetIssuer: fast_check_1.default.constant("GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"),
            payTo: fast_check_1.default.constant(VALID_PAY_TO),
            nonce: fast_check_1.default.uuid({ version: 4 }),
            expiresAt: fast_check_1.default.date().map((d) => d.toISOString()),
        });
        fast_check_1.default.assert(fast_check_1.default.property(validChallengeArb, (challenge) => {
            const result = X402PaymentTool_1.X402ChallengeSchema.safeParse(challenge);
            (0, vitest_1.expect)(result.success).toBe(true);
        }), { numRuns: 1000 });
    });
    (0, vitest_1.it)("rejects a payTo that is not exactly 56 characters", () => {
        const invalidPayToArb = fast_check_1.default.record({
            resource: fast_check_1.default.webUrl(),
            amount: fast_check_1.default.string({ minLength: 1, maxLength: 20 }),
            assetCode: fast_check_1.default.constant("XLM"),
            assetIssuer: fast_check_1.default.constant(""),
            payTo: fast_check_1.default.string({ minLength: 0, maxLength: 100 }).filter((s) => s.length !== 56),
            nonce: fast_check_1.default.uuid({ version: 4 }),
            expiresAt: fast_check_1.default.date().map((d) => d.toISOString()),
        });
        fast_check_1.default.assert(fast_check_1.default.property(invalidPayToArb, (challenge) => {
            const result = X402PaymentTool_1.X402ChallengeSchema.safeParse(challenge);
            (0, vitest_1.expect)(result.success).toBe(false);
        }), { numRuns: 1000 });
    });
    (0, vitest_1.it)("rejects a non-XLM assetCode with an empty assetIssuer", () => {
        // Note: assetIssuer is omitted-with-default in the schema (falls back to
        // config.X402_ASSET_ISSUER when `undefined`), so an *explicit* empty
        // string is required here to actually exercise the "no issuer" branch of
        // the refine -- omitting the field would just pick up the config default.
        const missingIssuerArb = fast_check_1.default.record({
            resource: fast_check_1.default.webUrl(),
            amount: fast_check_1.default.string({ minLength: 1, maxLength: 20 }),
            assetCode: fast_check_1.default.constant("USDC"),
            assetIssuer: fast_check_1.default.constant(""),
            payTo: fast_check_1.default.constant(VALID_PAY_TO),
            nonce: fast_check_1.default.uuid({ version: 4 }),
            expiresAt: fast_check_1.default.date().map((d) => d.toISOString()),
        });
        fast_check_1.default.assert(fast_check_1.default.property(missingIssuerArb, (challenge) => {
            const result = X402PaymentTool_1.X402ChallengeSchema.safeParse(challenge);
            (0, vitest_1.expect)(result.success).toBe(false);
        }), { numRuns: 1000 });
    });
});
//# sourceMappingURL=x402_schema.test.js.map