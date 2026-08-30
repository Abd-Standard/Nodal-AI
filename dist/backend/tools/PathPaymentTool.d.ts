/**
 * backend/tools/PathPaymentTool.ts
 * Cross-asset path payment via Stellar's pathPaymentStrictSend operation.
 * Enables sending one asset and having the recipient receive a different asset
 * through the Stellar DEX (e.g., send XLM, recipient receives USDC).
 */
import { z } from "zod";
export declare const PathPaymentInputSchema: z.ZodObject<{
    destination: z.ZodString;
    sendAsset: z.ZodObject<{
        code: z.ZodString;
        issuer: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        code: string;
        issuer?: string | undefined;
    }, {
        code: string;
        issuer?: string | undefined;
    }>;
    sendAmount: z.ZodEffects<z.ZodString, string, string>;
    destAsset: z.ZodObject<{
        code: z.ZodString;
        issuer: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        code: string;
        issuer?: string | undefined;
    }, {
        code: string;
        issuer?: string | undefined;
    }>;
    destMinAmount: z.ZodEffects<z.ZodString, string, string>;
    path: z.ZodDefault<z.ZodOptional<z.ZodArray<z.ZodObject<{
        code: z.ZodString;
        issuer: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        code: string;
        issuer?: string | undefined;
    }, {
        code: string;
        issuer?: string | undefined;
    }>, "many">>>;
    memoType: z.ZodDefault<z.ZodOptional<z.ZodEnum<["text", "id", "hash", "return"]>>>;
    memo: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodNumber]>>;
}, "strip", z.ZodTypeAny, {
    path: {
        code: string;
        issuer?: string | undefined;
    }[];
    destination: string;
    memoType: "id" | "text" | "hash" | "return";
    sendAsset: {
        code: string;
        issuer?: string | undefined;
    };
    sendAmount: string;
    destAsset: {
        code: string;
        issuer?: string | undefined;
    };
    destMinAmount: string;
    memo?: string | number | undefined;
}, {
    destination: string;
    sendAsset: {
        code: string;
        issuer?: string | undefined;
    };
    sendAmount: string;
    destAsset: {
        code: string;
        issuer?: string | undefined;
    };
    destMinAmount: string;
    path?: {
        code: string;
        issuer?: string | undefined;
    }[] | undefined;
    memoType?: "id" | "text" | "hash" | "return" | undefined;
    memo?: string | number | undefined;
}>;
export type PathPaymentInput = z.infer<typeof PathPaymentInputSchema>;
export declare class PathPaymentTool {
    private keypair;
    private networkPassphrase;
    constructor(secretKey?: string);
    get publicKey(): string;
    execute(rawInput: unknown): Promise<{
        txHash: string;
        ledger: number;
    }>;
}
//# sourceMappingURL=PathPaymentTool.d.ts.map