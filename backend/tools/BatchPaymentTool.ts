/**
 * backend/tools/BatchPaymentTool.ts
 *
 * Executes 1–100 payment operations in a single atomic Stellar transaction.
 * Spending limit is enforced on the aggregate amount (sum of all payments).
 */

import {
  Keypair,
  TransactionBuilder,
  Operation,
  Asset,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { z } from "zod";
import { config } from "../config";
import { loadAccount, resolveNetworkPassphrase, submitTransaction } from "../rpc_client";
import { PaymentInputSchema, SubmitResultSchema } from "./StellarPaymentTool";
import { SOROBAN_TX_TIMEOUT } from "./SorobanInvokeTool";

export const BatchPaymentInputSchema = z.object({
  payments: z.array(PaymentInputSchema).min(1).max(100),
});

export type BatchPaymentInput = z.infer<typeof BatchPaymentInputSchema>;

export class BatchPaymentTool {
  private keypair: Keypair;
  private networkPassphrase: string;

  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  async execute(rawInput: unknown): Promise<{ txHash: string; ledger: number }> {
    const { payments } = BatchPaymentInputSchema.parse(rawInput);

    // Aggregate spending limit check
    const total = payments.reduce((sum, p) => sum + parseFloat(p.amount), 0);
    const limit = parseFloat(config.AGENT_SPENDING_LIMIT);
    if (total > limit) {
      throw new Error(
        `Batch total ${total} ${config.X402_ASSET_CODE} exceeds AGENT_SPENDING_LIMIT of ${config.AGENT_SPENDING_LIMIT}`
      );
    }

    const sourceAccount = await loadAccount(this.keypair.publicKey());

    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    });

    for (const p of payments) {
      if (p.assetCode !== "XLM" && !p.assetIssuer) {
        throw new Error(`Asset issuer is required for non-native asset ${p.assetCode}`);
      }
      const asset = p.assetCode === "XLM" ? Asset.native() : new Asset(p.assetCode, p.assetIssuer);
      builder.addOperation(
        Operation.payment({ destination: p.destination, asset, amount: p.amount })
      );
    }

    const tx = builder.setTimeout(SOROBAN_TX_TIMEOUT).build();
    tx.sign(this.keypair);

    const result = SubmitResultSchema.parse(await submitTransaction(tx));
    return { txHash: result.hash, ledger: result.ledger };
  }
}
