"use strict";
/**
 * tests/fuzz/payment_schema.test.ts
 *
 * Property-based fuzz tests for PaymentInputSchema (issue #242).
 * Runs 1000+ generated inputs per property via fast-check to ensure no
 * edge case (arbitrary strings, Unicode memo content, zero-value amount
 * formatting) bypasses validation.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const fast_check_1 = __importDefault(require("fast-check"));
const zod_1 = require("zod");
const StellarPaymentTool_1 = require("../../backend/tools/StellarPaymentTool");
const VALID_DEST = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
(0, vitest_1.describe)("PaymentInputSchema fuzz", () => {
    (0, vitest_1.it)("amount: any random string either parses or throws a ZodError -- never anything else", () => {
        fast_check_1.default.assert(fast_check_1.default.property(fast_check_1.default.string(), (amount) => {
            try {
                StellarPaymentTool_1.PaymentInputSchema.parse({ destination: VALID_DEST, amount, assetCode: "XLM" });
            }
            catch (err) {
                (0, vitest_1.expect)(err).toBeInstanceOf(zod_1.z.ZodError);
            }
        }), { numRuns: 1000 });
    });
    (0, vitest_1.it)("destination: random-length strings pass validation only at exactly 56 characters", () => {
        fast_check_1.default.assert(fast_check_1.default.property(fast_check_1.default.string({ minLength: 0, maxLength: 100 }), (destination) => {
            const result = StellarPaymentTool_1.PaymentInputSchema.safeParse({
                destination,
                amount: "1",
                assetCode: "XLM",
            });
            (0, vitest_1.expect)(result.success).toBe(destination.length === 56);
        }), { numRuns: 1000 });
    });
    (0, vitest_1.it)("memo: Unicode strings are rejected exactly when their UTF-8 byte length exceeds 28", () => {
        fast_check_1.default.assert(fast_check_1.default.property(fast_check_1.default.fullUnicodeString({ minLength: 0, maxLength: 40 }), (memo) => {
            const byteLength = Buffer.byteLength(memo, "utf8");
            const result = StellarPaymentTool_1.PaymentInputSchema.safeParse({
                destination: VALID_DEST,
                amount: "1",
                assetCode: "XLM",
                memo,
            });
            (0, vitest_1.expect)(result.success).toBe(byteLength <= 28);
        }), { numRuns: 1000 });
    });
    (0, vitest_1.it)("amount: zero-value decimals are always rejected regardless of trailing-zero formatting", () => {
        // Generates "0", "0.0", "0.00", ... "0.000000000" (up to 9 trailing zeros).
        const zeroValueArb = fast_check_1.default
            .nat({ max: 9 })
            .map((zeros) => (zeros === 0 ? "0" : `0.${"0".repeat(zeros)}`));
        fast_check_1.default.assert(fast_check_1.default.property(zeroValueArb, (amount) => {
            const result = StellarPaymentTool_1.PaymentInputSchema.safeParse({
                destination: VALID_DEST,
                amount,
                assetCode: "XLM",
            });
            (0, vitest_1.expect)(result.success).toBe(false);
        }), { numRuns: 1000 });
    });
    (0, vitest_1.it)('explicitly rejects "0", "0.0", and "0.0000000" from the issue description', () => {
        for (const amount of ["0", "0.0", "0.0000000"]) {
            const result = StellarPaymentTool_1.PaymentInputSchema.safeParse({
                destination: VALID_DEST,
                amount,
                assetCode: "XLM",
            });
            (0, vitest_1.expect)(result.success).toBe(false);
        }
    });
    (0, vitest_1.it)("valid decimal amounts with 1-7 fraction digits always parse successfully", () => {
        const validAmountArb = fast_check_1.default
            .tuple(fast_check_1.default.integer({ min: 1, max: 1_000_000 }), fast_check_1.default.nat({ max: 7 }))
            .map(([whole, decimals]) => decimals === 0 ? `${whole}` : `${whole}.${"1".repeat(decimals)}`);
        fast_check_1.default.assert(fast_check_1.default.property(validAmountArb, (amount) => {
            const result = StellarPaymentTool_1.PaymentInputSchema.safeParse({
                destination: VALID_DEST,
                amount,
                assetCode: "XLM",
            });
            (0, vitest_1.expect)(result.success).toBe(true);
        }), { numRuns: 1000 });
    });
});
//# sourceMappingURL=payment_schema.test.js.map