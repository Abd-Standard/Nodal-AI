"use strict";
/**
 * backend/tools/X402PaymentTool.ts
 * x402 machine-to-machine PayFi payment tool.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.X402PaymentTool = exports.X402ChallengeSchema = void 0;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const zod_1 = require("zod");
const crypto_1 = require("crypto");
const config_1 = require("../config");
const rpc_client_1 = require("../rpc_client");
const StellarPaymentTool_1 = require("./StellarPaymentTool");
const logger_1 = require("../logger");
// ─── x402 schemas ────────────────────────────────────────────────────────────
exports.X402ChallengeSchema = zod_1.z.object({
    resource: zod_1.z.string().url("Must be a valid resource URL"),
    amount: zod_1.z.string(),
    assetCode: zod_1.z.string().default(config_1.config.X402_ASSET_CODE),
    assetIssuer: zod_1.z.string().default(config_1.config.X402_ASSET_ISSUER),
    payTo: zod_1.z.string().length(56, "Invalid payTo Stellar address"),
    nonce: zod_1.z.string().uuid("Nonce must be a UUID v4"),
    expiresAt: zod_1.z.string().datetime(),
}).refine((data) => data.assetCode === "XLM" || !!data.assetIssuer, { message: "assetIssuer is required for non-XLM payments", path: ["assetIssuer"] });
// ─── Tool implementation ──────────────────────────────────────────────────────
class X402PaymentTool {
    paymentTool;
    keypair;
    horizonServer;
    constructor(secretKey = config_1.config.agentKeypair().secret()) {
        this.keypair = stellar_sdk_1.Keypair.fromSecret(secretKey);
        this.paymentTool = new StellarPaymentTool_1.StellarPaymentTool(secretKey);
        this.horizonServer = rpc_client_1.horizonServer;
    }
    async respond(rawChallenge) {
        const challenge = exports.X402ChallengeSchema.parse(rawChallenge);
        if (challenge.payTo === this.keypair.publicKey()) {
            throw new Error("Payment destination cannot be the agent's own address");
        }
        if (config_1.config.ALLOWED_X402_ORIGINS) {
            const allowedOrigins = config_1.config.ALLOWED_X402_ORIGINS.split(",").map(o => o.trim());
            const hostname = new URL(challenge.resource).hostname;
            if (!allowedOrigins.includes(hostname)) {
                throw new Error("x402: untrusted resource origin");
            }
        }
        else {
            logger_1.logger.warn("ALLOWED_X402_ORIGINS is not set. All origins accepted.");
        }
        if (new Date(challenge.expiresAt) < new Date()) {
            throw new Error(`x402 challenge expired at ${challenge.expiresAt}`);
        }
        const { txHash } = await this.paymentTool.execute({
            destination: challenge.payTo,
            amount: challenge.amount,
            assetCode: challenge.assetCode,
            assetIssuer: challenge.assetCode === "XLM" ? undefined : challenge.assetIssuer,
            // SPEC: memo = SHA-256(nonce)[0:28 hex chars]; resource server must apply the same derivation to verify.
            memo: (0, crypto_1.createHash)("sha256").update(challenge.nonce).digest("hex").slice(0, 28),
        });
        return {
            protocol: "x402",
            network: config_1.config.STELLAR_NETWORK,
            txHash,
            nonce: challenge.nonce,
            payer: this.keypair.publicKey(),
            signedAt: new Date().toISOString(),
        };
    }
    async verify(proof, originalChallenge) {
        const tx = await this.horizonServer
            .transactions()
            .transaction(proof.txHash)
            .call();
        const ops = await this.horizonServer
            .operations()
            .forTransaction(proof.txHash)
            .call();
        const op = ops.records?.[0];
        if (!op) {
            throw new Error("x402 verification failed: missing operation");
        }
        const parsed = this.extractOp(op);
        if (parsed.to !== originalChallenge.payTo) {
            throw new Error("x402 verification failed: destination mismatch");
        }
        if (parsed.amount !== originalChallenge.amount) {
            throw new Error("x402 verification failed: amount mismatch");
        }
        if (parsed.assetCode !== originalChallenge.assetCode) {
            throw new Error("x402 verification failed: asset mismatch");
        }
        const expectedMemo = originalChallenge.nonce.slice(0, 28);
        if (tx.memo !== expectedMemo) {
            throw new Error("x402 verification failed: nonce mismatch");
        }
        if (parsed.from !== proof.payer) {
            throw new Error("x402 verification failed: payer mismatch");
        }
    }
    extractOp(op) {
        return {
            to: op.to || op.destination,
            amount: op.amount,
            assetCode: op.asset_code || op.asset?.code,
            from: op.from || op.source_account,
        };
    }
}
exports.X402PaymentTool = X402PaymentTool;
//# sourceMappingURL=X402PaymentTool.js.map