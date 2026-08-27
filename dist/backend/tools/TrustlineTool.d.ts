/**
 * backend/tools/TrustlineTool.ts
 * Manage asset trustlines for the agent account.
 */
import { z } from "zod";
export declare const TrustlineInputSchema: z.ZodObject<{
    assetCode: z.ZodString;
    assetIssuer: z.ZodEffects<z.ZodString, string, string>;
    action: z.ZodEnum<["add", "remove"]>;
    limit: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    assetCode: string;
    assetIssuer: string;
    action: "add" | "remove";
    limit?: string | undefined;
}, {
    assetCode: string;
    assetIssuer: string;
    action: "add" | "remove";
    limit?: string | undefined;
}>;
export type TrustlineInput = z.infer<typeof TrustlineInputSchema>;
export declare class TrustlineTool {
    private keypair;
    private networkPassphrase;
    constructor(secretKey?: string);
    checkTrustline(assetCode: string, assetIssuer: string): Promise<boolean>;
    execute(rawInput: unknown): Promise<{
        txHash: string;
        ledger: number;
    }>;
}
//# sourceMappingURL=TrustlineTool.d.ts.map