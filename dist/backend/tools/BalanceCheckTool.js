"use strict";
/**
 * backend/tools/BalanceCheckTool.ts
 * Standalone tool: query asset balances for a Stellar account via Horizon.
 *
 * Architecture: validate input → loadAccount (with retry) → filter + return balances
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BalanceCheckTool = exports.BalanceCheckInputSchema = void 0;
const zod_1 = require("zod");
const rpc_client_1 = require("../rpc_client");
const logger_1 = require("../utils/logger");
const log = (0, logger_1.createLogger)("balance-check");
// ─── Input schema ─────────────────────────────────────────────────────────────
exports.BalanceCheckInputSchema = zod_1.z.object({
    publicKey: zod_1.z.string().length(56, "Invalid Stellar public key"),
    assetCode: zod_1.z.string().min(1).max(12).optional(),
    assetIssuer: zod_1.z.string().length(56, "Invalid asset issuer address").optional(),
});
// ─── Tool implementation ──────────────────────────────────────────────────────
class BalanceCheckTool {
    /**
     * Fetch balances for a Stellar account via Horizon.
     *
     * Validates the input, loads the account from Horizon, and returns all
     * balance lines. When `assetCode` is provided the result is filtered to
     * matching entries only; passing `assetIssuer` alongside `assetCode`
     * narrows the filter further to a specific token issuance.
     *
     * ### Filtering behaviour
     *
     * | `assetCode` | `assetIssuer` | Rows returned |
     * |-------------|---------------|---------------|
     * | omitted     | —             | all balances  |
     * | `"XLM"`     | —             | native only   |
     * | `"USDC"`    | omitted       | all USDC issuances |
     * | `"USDC"`    | `"GA5Z…"`     | only USDC from that issuer |
     *
     * @param rawInput - Raw (unvalidated) input; parsed via {@link BalanceCheckInputSchema}.
     * @returns An object containing the queried `publicKey` and a filtered (or
     *   full) list of {@link BalanceLine} entries.
     * @throws {z.ZodError} If `publicKey` is not exactly 56 characters, or if
     *   `assetIssuer` is provided and is not exactly 56 characters.
     * @throws {Error} If Horizon cannot load the account (e.g. account not found,
     *   network timeout).
     */
    async getBalance(rawInput) {
        const input = exports.BalanceCheckInputSchema.parse(rawInput);
        log.info({ msg: "Fetching account balances", publicKey: input.publicKey });
        const account = await (0, rpc_client_1.loadAccount)(input.publicKey);
        let balances = account.balances.map((b) => ({
            assetType: b.asset_type,
            assetCode: b.asset_type !== "native" ? b.asset_code : undefined,
            assetIssuer: b.asset_type !== "native" ? b.asset_issuer : undefined,
            balance: b.balance,
        }));
        if (input.assetCode) {
            balances = balances.filter((b) => input.assetCode === "XLM"
                ? b.assetType === "native"
                : b.assetCode === input.assetCode &&
                    (!input.assetIssuer || b.assetIssuer === input.assetIssuer));
        }
        log.info({ msg: "Balance check complete", publicKey: input.publicKey, count: balances.length });
        return { publicKey: input.publicKey, balances };
    }
}
exports.BalanceCheckTool = BalanceCheckTool;
//# sourceMappingURL=BalanceCheckTool.js.map