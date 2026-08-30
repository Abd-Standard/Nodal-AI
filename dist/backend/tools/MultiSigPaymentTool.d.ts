/**
 * backend/tools/MultiSigPaymentTool.ts
 * Build M-of-N multi-signature payment transactions for high-value PayFi operations.
 */
import { z } from "zod";
export declare const MultiSigInputSchema: z.ZodObject<{
    destination: z.ZodString;
    amount: z.ZodEffects<z.ZodString, string, string>;
    assetCode: z.ZodDefault<z.ZodString>;
    assetIssuer: z.ZodOptional<z.ZodString>;
    memo: z.ZodOptional<z.ZodEffects<z.ZodString, string, string>>;
    additionalSigners: z.ZodArray<z.ZodString, "many">;
    minSignatures: z.ZodNumber;
    signatures: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    destination: string;
    amount: string;
    assetCode: string;
    additionalSigners: string[];
    minSignatures: number;
    assetIssuer?: string | undefined;
    memo?: string | undefined;
    signatures?: string[] | undefined;
}, {
    destination: string;
    amount: string;
    additionalSigners: string[];
    minSignatures: number;
    assetCode?: string | undefined;
    assetIssuer?: string | undefined;
    memo?: string | undefined;
    signatures?: string[] | undefined;
}>;
export type MultiSigInput = z.infer<typeof MultiSigInputSchema>;
export interface MultiSigResult {
    /** Unsigned transaction XDR — returned when signatures are not yet provided */
    unsignedXDR?: string;
    /** Settled transaction hash — returned when enough signatures were provided */
    txHash?: string;
    ledger?: number;
}
export declare class MultiSigPaymentTool {
    private keypair;
    private networkPassphrase;
    constructor(secretKey?: string);
    execute(rawInput: unknown): Promise<MultiSigResult>;
}
//# sourceMappingURL=MultiSigPaymentTool.d.ts.map