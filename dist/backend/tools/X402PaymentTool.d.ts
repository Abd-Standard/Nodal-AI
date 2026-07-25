/**
 * backend/tools/X402PaymentTool.ts
 * x402 machine-to-machine PayFi payment tool.
 */
import { z } from "zod";
export declare const X402ChallengeSchema: z.ZodEffects<z.ZodObject<{
    resource: z.ZodString;
    amount: z.ZodString;
    assetCode: z.ZodDefault<z.ZodString>;
    assetIssuer: z.ZodDefault<z.ZodString>;
    payTo: z.ZodString;
    nonce: z.ZodString;
    expiresAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    amount: string;
    assetCode: string;
    assetIssuer: string;
    resource: string;
    payTo: string;
    nonce: string;
    expiresAt: string;
}, {
    amount: string;
    resource: string;
    payTo: string;
    nonce: string;
    expiresAt: string;
    assetCode?: string | undefined;
    assetIssuer?: string | undefined;
}>, {
    amount: string;
    assetCode: string;
    assetIssuer: string;
    resource: string;
    payTo: string;
    nonce: string;
    expiresAt: string;
}, {
    amount: string;
    resource: string;
    payTo: string;
    nonce: string;
    expiresAt: string;
    assetCode?: string | undefined;
    assetIssuer?: string | undefined;
}>;
export type X402Challenge = z.infer<typeof X402ChallengeSchema>;
export interface X402PaymentProof {
    protocol: "x402";
    network: string;
    txHash: string;
    nonce: string;
    payer: string;
    signedAt: string;
}
export declare class X402PaymentTool {
    private paymentTool;
    private keypair;
    private horizonServer;
    constructor(secretKey?: string);
    respond(rawChallenge: unknown): Promise<X402PaymentProof>;
    verify(proof: X402PaymentProof, originalChallenge: X402Challenge): Promise<void>;
    private extractOp;
}
//# sourceMappingURL=X402PaymentTool.d.ts.map