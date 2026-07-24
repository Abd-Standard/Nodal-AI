/**
 * backend/tools/FeeBumpTool.ts
 * Wraps any failed transaction in a fee-bump envelope for sponsored retry.
 * Allows the agent to pay fees on behalf of a transaction signed by a different account.
 */

import {
  Keypair,
  TransactionBuilder,
  FeeBumpTransaction,
  Transaction,
  Networks,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { z } from "zod";
import { config } from "../config";
import { logger } from "../logger";
import { resolveNetworkPassphrase, submitTransaction } from "../rpc_client";
import { createLogger } from "../utils/logger";
import { SubmitResultSchema } from "./StellarPaymentTool";

const log = createLogger("fee-bump");

// ─── Input schema ─────────────────────────────────────────────────────────────

export const FeeBumpInputSchema = z.object({
  innerTxXdr: z.string().min(1, "innerTxXdr must be a non-empty base64 XDR string"),
  feeAccount: z.string().length(56, "Invalid Stellar public key").optional(),
  baseFeeMultiplier: z.number().int().min(2).default(2),
});

export type FeeBumpInput = z.infer<typeof FeeBumpInputSchema>;

// ─── Tool implementation ──────────────────────────────────────────────────────

export class FeeBumpTool {
  private keypair: Keypair;
  private networkPassphrase: string;

  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  get publicKey(): string {
    return this.keypair.publicKey();
  }

  async execute(rawInput: unknown): Promise<{ txHash: string; ledger: number }> {
    const input = FeeBumpInputSchema.parse(rawInput);

    const feeAccount = input.feeAccount ?? this.keypair.publicKey();

    // Deserialize the inner transaction from XDR
    let innerTx: Transaction;
    try {
      innerTx = TransactionBuilder.fromXDR(
        input.innerTxXdr,
        this.networkPassphrase
      ) as Transaction;
    } catch {
      throw new Error(`Invalid inner transaction XDR: unable to deserialize`);
    }

    if (innerTx instanceof FeeBumpTransaction) {
      throw new Error("Inner transaction must not itself be a fee-bump transaction");
    }

    const baseFee = parseInt(innerTx.fee, 10);
    const operationCount = innerTx.operations.length || 1;
    const feePerOp = Math.ceil(baseFee / operationCount);
    // baseFeeMultiplier must be >= 2 to ensure the fee-bump fee is strictly greater than
    // the inner transaction's fee, preventing fee_insufficient network rejections.
    const newFeePerOp = Math.max(feePerOp * input.baseFeeMultiplier, BASE_FEE);
    // Fee-bump fee must be at least (inner ops + 1) * newFeePerOp per Stellar protocol
    const feeBumpFee = String((operationCount + 1) * newFeePerOp);

    logger.info("Building fee-bump transaction", {
      feeAccount,
      innerTxHash: innerTx.hash().toString("hex"),
      baseFeeMultiplier: input.baseFeeMultiplier,
      feeBumpFee,
    });

    const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
      feeAccount,
      feeBumpFee,
      innerTx,
      this.networkPassphrase
    );

    feeBumpTx.sign(this.keypair);

    const result = SubmitResultSchema.parse(await submitTransaction(feeBumpTx));
    return { txHash: result.hash, ledger: result.ledger };
  }
}
