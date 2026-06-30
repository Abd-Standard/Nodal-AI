/**
 * backend/tools/X402PaymentTool.ts
 * x402 machine-to-machine PayFi payment tool.
 */

import { Keypair, Horizon } from "@stellar/stellar-sdk";
import { z } from "zod";
import { createHash } from "crypto";
import { config } from "../config";
import { horizonServer } from "../rpc_client";
import { StellarPaymentTool } from "./StellarPaymentTool";
import { logger } from "../logger";

// ─── x402 schemas ────────────────────────────────────────────────────────────

export const X402ChallengeSchema = z.object({
  resource: z.string().url("Must be a valid resource URL"),
  amount: z.string(),
  assetCode: z.string().default(config.X402_ASSET_CODE),
  assetIssuer: z.string().default(config.X402_ASSET_ISSUER),
  payTo: z.string().length(56, "Invalid payTo Stellar address"),
  nonce: z.string().uuid("Nonce must be a UUID v4"),
  expiresAt: z.string().datetime(),
}).refine(
  (data) => data.assetCode === "XLM" || !!data.assetIssuer,
  { message: "assetIssuer is required for non-XLM payments", path: ["assetIssuer"] }
);

export type X402Challenge = z.infer<typeof X402ChallengeSchema>;

export interface X402PaymentProof {
  protocol: "x402";
  network: string;
  txHash: string;
  nonce: string;
  payer: string;
  signedAt: string;
}

// ─── Tool implementation ──────────────────────────────────────────────────────

const RATE_LIMIT_WINDOW_MS = 60_000;

export class X402PaymentTool {
  // TODO: persist to Redis for multi-instance deployments
  private usedNonces = new Set<string>();
  private paymentTool: StellarPaymentTool;
  private keypair: Keypair;
  private horizonServer: Horizon.Server;
  private paymentCount = 0;
  private windowStart = Date.now();

  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.paymentTool = new StellarPaymentTool(secretKey);
    this.horizonServer = horizonServer;
  }

  async respond(rawChallenge: unknown): Promise<X402PaymentProof> {
    const now = Date.now();
    if (now - this.windowStart >= RATE_LIMIT_WINDOW_MS) {
      this.paymentCount = 0;
      this.windowStart = now;
    }

    if (this.paymentCount >= config.MAX_X402_PAYMENTS_PER_MINUTE) {
      throw new Error("x402: rate limit exceeded");
    }
    this.paymentCount++;

    const challenge = X402ChallengeSchema.parse(rawChallenge);

    if (challenge.payTo === this.keypair.publicKey()) {
      throw new Error("Payment destination cannot be the agent's own address");
    }

    if (config.ALLOWED_X402_ORIGINS) {
      const allowedOrigins = config.ALLOWED_X402_ORIGINS.split(",").map(o => o.trim());
      const hostname = new URL(challenge.resource).hostname;
      if (!allowedOrigins.includes(hostname)) {
        throw new Error("x402: untrusted resource origin");
      }
    } else {
      logger.warn("ALLOWED_X402_ORIGINS is not set. All origins accepted.");
    }

    if (new Date(challenge.expiresAt) < new Date()) {
      throw new Error(`x402 challenge expired at ${challenge.expiresAt}`);
    }

    if (this.usedNonces.has(challenge.nonce)) {
      throw new Error("x402: nonce already used");
    }

    const { txHash } = await this.paymentTool.execute({
      destination: challenge.payTo,
      amount: challenge.amount,
      assetCode: challenge.assetCode,
      assetIssuer:
        challenge.assetCode === "XLM" ? undefined : challenge.assetIssuer,
      // SPEC: memo = SHA-256(nonce)[0:28 hex chars]; resource server must apply the same derivation to verify.
      memo: createHash("sha256").update(challenge.nonce).digest("hex").slice(0, 28),
    });

    this.usedNonces.add(challenge.nonce);

    return {
      protocol: "x402",
      network: config.STELLAR_NETWORK,
      txHash,
      nonce: challenge.nonce,
      payer: this.keypair.publicKey(),
      signedAt,
    };
  }

  async verify(
    proof: X402PaymentProof,
    originalChallenge: X402Challenge
  ): Promise<void> {
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

  private extractOp(op: any) {
    return {
      to: op.to || op.destination,
      amount: op.amount,
      assetCode: op.asset_code || op.asset?.code,
      from: op.from || op.source_account,
    };
  }
}