/**
 * backend/tools/FeeBumpTool.ts
 * Wraps any failed transaction in a fee-bump envelope for sponsored retry.
 * Allows the agent to pay fees on behalf of a transaction signed by a different account.
 */
import { z } from "zod";
export declare const FeeBumpInputSchema: z.ZodObject<{
    innerTxXdr: z.ZodString;
    feeAccount: z.ZodOptional<z.ZodString>;
    baseFeeMultiplier: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    innerTxXdr: string;
    baseFeeMultiplier: number;
    feeAccount?: string | undefined;
}, {
    innerTxXdr: string;
    feeAccount?: string | undefined;
    baseFeeMultiplier?: number | undefined;
}>;
export type FeeBumpInput = z.infer<typeof FeeBumpInputSchema>;
export declare class FeeBumpTool {
    private keypair;
    private networkPassphrase;
    constructor(secretKey?: string);
    get publicKey(): string;
    execute(rawInput: unknown): Promise<{
        txHash: string;
        ledger: number;
    }>;
}
//# sourceMappingURL=FeeBumpTool.d.ts.map