/**
 * backend/tools/X402PaymentTool.ts
 * x402 machine-to-machine PayFi payment tool.
 */
import { z } from "zod";
import { INonceStore } from "../nonce_store";
export declare const X402ChallengeSchema: z.ZodEffects<z.ZodObject<{
    resource: z.ZodString;
    amount: z.ZodString;
    assetCode: z.ZodDefault<z.ZodString>;
    assetIssuer: z.ZodDefault<z.ZodString>;
    payTo: z.ZodString;
    nonce: z.ZodString;
    expiresAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    resource: string;
    amount: string;
    assetCode: string;
    assetIssuer: string;
    nonce: string;
    payTo: string;
    expiresAt: string;
}, {
    resource: string;
    amount: string;
    nonce: string;
    payTo: string;
    expiresAt: string;
    assetCode?: string | undefined;
    assetIssuer?: string | undefined;
}>, {
    resource: string;
    amount: string;
    assetCode: string;
    assetIssuer: string;
    nonce: string;
    payTo: string;
    expiresAt: string;
}, {
    resource: string;
    amount: string;
    nonce: string;
    payTo: string;
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
    private nonceStore;
    private paymentTool;
    private keypair;
    private horizonServer;
    private paymentCount;
    private windowStart;
    /**
     * @param secretKey   - Stellar secret key for signing payments.
     * @param nonceStore  - Pluggable nonce store.  Defaults to SqliteNonceStore
     *                      backed by the shared agent.db file.  Inject an
     *                      InMemoryNonceStore (or a custom Redis/DynamoDB
     *                      implementation of INonceStore) in tests or for
     *                      multi-instance deployments.
     */
    constructor(secretKey?: string, nonceStore?: INonceStore);
    /**
     * Respond to an x402 `402 Payment Required` challenge by executing a
     * Stellar payment and returning a signed proof of payment.
     *
     * ### Processing steps
     * 1. Parse and validate `rawChallenge` against {@link X402ChallengeSchema}.
     * 2. Guard against self-payment (payTo must not equal the agent's public key).
     * 3. If `ALLOWED_X402_ORIGINS` is configured, verify the challenge resource
     *    hostname is in the allow-list.
     * 4. Reject expired challenges (`expiresAt` < now).
     * 5. Delegate to {@link StellarPaymentTool.execute} to sign and submit
     *    the payment, using `SHA-256(nonce)[0:28 hex]` as the transaction memo.
     * 6. Return an {@link X402PaymentProof} with the settled `txHash`.
     *
     * @param rawChallenge - Raw (unvalidated) challenge object, typically the
     *   parsed JSON body of a `402 Payment Required` HTTP response.
     * @returns A resolved {@link X402PaymentProof} containing the `txHash`,
     *   original `nonce`, agent `payer` address, and `signedAt` timestamp.
     * @throws {z.ZodError} If `rawChallenge` does not conform to
     *   {@link X402ChallengeSchema} (missing fields, bad UUID, expired datetime, etc.).
     * @throws {Error} If the challenge has expired, the resource origin is not
     *   allowed, the destination equals the agent's own address, or the underlying
     *   Stellar payment fails.
     */
    respond(rawChallenge: unknown): Promise<X402PaymentProof>;
    /**
     * Verify that an {@link X402PaymentProof} corresponds to a settled Stellar
     * transaction that satisfies the original challenge's requirements.
     *
     * Fetches the transaction and its first operation from Horizon and checks:
     * - destination matches `originalChallenge.payTo`
     * - amount matches `originalChallenge.amount`
     * - asset code matches `originalChallenge.assetCode`
     * - transaction memo equals `originalChallenge.nonce.slice(0, 28)`
     * - source account matches `proof.payer`
     *
     * @param proof - The {@link X402PaymentProof} returned by {@link respond}.
     * @param originalChallenge - The parsed {@link X402Challenge} that was used
     *   to produce `proof`. Must be the same challenge passed to {@link respond}.
     * @returns Resolves with `void` when all checks pass.
     * @throws {Error} If the transaction cannot be found on Horizon, if the
     *   transaction has no payment operation, or if any of the verification
     *   checks (destination, amount, asset, memo, payer) fail.
     */
    verify(proof: X402PaymentProof, originalChallenge: X402Challenge): Promise<void>;
    private extractOp;
}
//# sourceMappingURL=X402PaymentTool.d.ts.map