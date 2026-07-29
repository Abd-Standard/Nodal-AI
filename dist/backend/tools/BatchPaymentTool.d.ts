/**
 * backend/tools/BatchPaymentTool.ts
 *
 * Executes 1–100 payment operations in a single atomic Stellar transaction.
 * Spending limit is enforced on the aggregate amount (sum of all payments).
 */
import { z } from "zod";
export declare const BatchPaymentInputSchema: z.ZodObject<{
    payments: z.ZodArray<z.ZodObject<{
        destination: z.ZodEffects<z.ZodString, string, string>;
        amount: z.ZodEffects<z.ZodString, string, string>;
        assetCode: z.ZodDefault<z.ZodString>;
        assetIssuer: z.ZodOptional<z.ZodString>;
        memoType: z.ZodDefault<z.ZodOptional<z.ZodEnum<["text", "id", "hash", "return"]>>>;
        memo: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodNumber]>>;
    }, "strip", z.ZodTypeAny, {
        destination: string;
        amount: string;
        assetCode: string;
        memoType: "id" | "text" | "hash" | "return";
        assetIssuer?: string | undefined;
        memo?: string | number | undefined;
    }, {
        destination: string;
        amount: string;
        assetCode?: string | undefined;
        assetIssuer?: string | undefined;
        memoType?: "id" | "text" | "hash" | "return" | undefined;
        memo?: string | number | undefined;
    }>, "many">;
}, "strip", z.ZodTypeAny, {
    payments: {
        destination: string;
        amount: string;
        assetCode: string;
        memoType: "id" | "text" | "hash" | "return";
        assetIssuer?: string | undefined;
        memo?: string | number | undefined;
    }[];
}, {
    payments: {
        destination: string;
        amount: string;
        assetCode?: string | undefined;
        assetIssuer?: string | undefined;
        memoType?: "id" | "text" | "hash" | "return" | undefined;
        memo?: string | number | undefined;
    }[];
}>;
export type BatchPaymentInput = z.infer<typeof BatchPaymentInputSchema>;
export declare class BatchPaymentTool {
    private keypair;
    private networkPassphrase;
    constructor(secretKey?: string);
    execute(rawInput: unknown): Promise<{
        txHash: string;
        ledger: number;
    }>;
}
//# sourceMappingURL=BatchPaymentTool.d.ts.map