/**
 * backend/tools/SorobanQueryTool.ts
 * Read-only Soroban contract query tool.
 *
 * Always runs simulation via prepareSorobanTx and never broadcasts.
 * This is the safe default for AI-agent read operations.
 */
import { xdr } from "@stellar/stellar-sdk";
import { z } from "zod";
/**
 * Reuses the Soroban invoke input schema but omits `simulateOnly` because this
 * tool is always read-only.
 */
export declare const SorobanQueryInputSchema: z.ZodObject<Omit<{
    contractId: z.ZodString;
    method: z.ZodString;
    args: z.ZodDefault<z.ZodArray<z.ZodType<xdr.ScVal, z.ZodTypeDef, xdr.ScVal>, "many">>;
    simulateOnly: z.ZodDefault<z.ZodBoolean>;
}, "simulateOnly">, "strip", z.ZodTypeAny, {
    contractId: string;
    method: string;
    args: xdr.ScVal[];
}, {
    contractId: string;
    method: string;
    args?: xdr.ScVal[] | undefined;
}>;
export type SorobanQueryInput = z.infer<typeof SorobanQueryInputSchema>;
export interface SorobanQueryResult {
    simulationResult: unknown;
}
export declare class SorobanQueryTool {
    private keypair;
    private networkPassphrase;
    constructor(secretKey?: string);
    /**
     * Simulate a Soroban contract call without broadcasting a transaction.
     */
    query(rawInput: unknown): Promise<SorobanQueryResult>;
}
//# sourceMappingURL=SorobanQueryTool.d.ts.map