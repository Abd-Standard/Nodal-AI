/**
 * backend/tools/BalanceCheckTool.ts
 * Standalone tool: query asset balances for a Stellar account via Horizon.
 *
 * Architecture: validate input → loadAccount (with retry) → filter + return balances
 */
import { z } from "zod";
export declare const BalanceCheckInputSchema: z.ZodObject<{
    publicKey: z.ZodString;
    assetCode: z.ZodOptional<z.ZodString>;
    assetIssuer: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    publicKey: string;
    assetCode?: string | undefined;
    assetIssuer?: string | undefined;
}, {
    publicKey: string;
    assetCode?: string | undefined;
    assetIssuer?: string | undefined;
}>;
export type BalanceCheckInput = z.infer<typeof BalanceCheckInputSchema>;
export interface BalanceLine {
    assetType: string;
    assetCode?: string;
    assetIssuer?: string;
    balance: string;
}
export interface BalanceResult {
    publicKey: string;
    balances: BalanceLine[];
}
export declare class BalanceCheckTool {
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
    getBalance(rawInput: unknown): Promise<BalanceResult>;
}
//# sourceMappingURL=BalanceCheckTool.d.ts.map