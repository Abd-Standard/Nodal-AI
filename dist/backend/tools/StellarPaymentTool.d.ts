/**
 * backend/tools/StellarPaymentTool.ts
 * Standalone tool: native XLM or asset payment via Horizon.
 *
 * Architecture: Tool → simulate → sign → submit
 * Never broadcasts without a prior simulation pass.
 */
import { z } from "zod";
declare const SubmitResultSchema: z.ZodObject<{
    hash: z.ZodString;
    ledger: z.ZodNumber;
}, "strip", z.ZodTypeAny, {
    hash: string;
    ledger: number;
}, {
    hash: string;
    ledger: number;
}>;
export { SubmitResultSchema };
export type SubmitResult = z.infer<typeof SubmitResultSchema>;
/**
 * Zod schema for payment input validation.
 *
 * @property destination - 56-character Stellar public key (G...) of the recipient
 * @property amount - Positive decimal string with up to 7 decimal places (Stellar network limit)
 * @property assetCode - Asset code (default: "XLM")
 * @property assetIssuer - Asset issuer public key (required for non-XLM assets)
 * @property memo - Optional memo text, max 28 characters (Stellar network limit)
 */
export declare const PaymentInputSchema: z.ZodObject<{
    destination: z.ZodString;
    amount: z.ZodEffects<z.ZodString, string, string>;
    assetCode: z.ZodDefault<z.ZodString>;
    assetIssuer: z.ZodOptional<z.ZodString>;
    memo: z.ZodOptional<z.ZodEffects<z.ZodString, string, string>>;
}, "strip", z.ZodTypeAny, {
    destination: string;
    amount: string;
    assetCode: string;
    assetIssuer?: string | undefined;
    memo?: string | undefined;
}, {
    destination: string;
    amount: string;
    assetCode?: string | undefined;
    assetIssuer?: string | undefined;
    memo?: string | undefined;
}>;
export type PaymentInput = z.infer<typeof PaymentInputSchema>;
export declare class StellarPaymentTool {
    private keypair;
    private networkPassphrase;
    /**
     * Create a new StellarPaymentTool instance.
     *
     * @param secretKey - Stellar secret key (S...) for signing transactions
     */
    constructor(secretKey?: string);
    get publicKey(): string;
    /**
     * Execute a payment on the Stellar network.
     *
     * Steps:
     * 1. Validate input with Zod schema
     * 2. Resolve asset (native XLM or custom asset)
     * 3. Load source account to get latest sequence number
     * 4. Build transaction with payment operation and optional memo
     * 5. Validate transaction envelope
     * 6. Sign transaction with keypair
     * 7. Submit transaction to the network
     *
     * @param rawInput - Raw payment input (will be validated)
     * @returns Object containing transaction hash and ledger number
     * @throws {z.ZodError} If input fails validation
     * @throws {Error} If source account not found or transaction submission fails
     */
    execute(rawInput: unknown): Promise<{
        txHash: string;
        ledger: number;
    }>;
}
//# sourceMappingURL=StellarPaymentTool.d.ts.map