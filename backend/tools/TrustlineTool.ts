/**
 * backend/tools/TrustlineTool.ts
 * Manage asset trustlines for the agent account.
 */

import { Keypair, TransactionBuilder, Operation, Asset, BASE_FEE } from "@stellar/stellar-sdk";
import { z } from "zod";
import { config } from "../config";
import { loadAccount, submitTransaction, horizonServer, resolveNetworkPassphrase } from "../rpc_client";

export const TrustlineInputSchema = z.object({
  assetCode: z.string().min(1).max(12),
  assetIssuer: z.string().length(56, "Invalid asset issuer address"),
  action: z.enum(["add", "remove"]),
  limit: z.string().optional(),
});

export type TrustlineInput = z.infer<typeof TrustlineInputSchema>;

export class TrustlineTool {
  private keypair: Keypair;
  private networkPassphrase: string;

  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  async checkTrustline(assetCode: string, assetIssuer: string): Promise<boolean> {
    const account = await loadAccount(this.keypair.publicKey());
    return (account.balances as any[]).some(
      (b) => b.asset_type !== "native" && b.asset_code === assetCode && b.asset_issuer === assetIssuer
    );
  }

  async execute(rawInput: unknown): Promise<{ txHash: string; ledger: number }> {
    const input = TrustlineInputSchema.parse(rawInput);
    const asset = new Asset(input.assetCode, input.assetIssuer);
    const account = await loadAccount(this.keypair.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.changeTrust({
          asset,
          limit: input.action === "remove" ? "0" : input.limit,
        })
      )
      .setTimeout(30)
      .build();

    tx.sign(this.keypair);
    const result = (await submitTransaction(tx)) as { hash: string; ledger: number };
    return { txHash: result.hash, ledger: result.ledger };
  }
}
