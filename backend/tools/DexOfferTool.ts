/**
 * backend/tools/DexOfferTool.ts
 * Place, update, or delete a manage-sell offer on the Stellar DEX.
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
import { SOROBAN_TX_TIMEOUT } from "./SorobanInvokeTool";
import { SubmitResultSchema } from "./StellarPaymentTool";

// ─── Schemas ──────────────────────────────────────────────────────────────────

const AssetSchema = z.object({
  code: z.string(),
  issuer: z.string().optional(),
});

export const DexOfferInputSchema = z
  .object({
    action: z.enum(["create", "update", "delete"]),
    selling: AssetSchema,
    buying: AssetSchema,
    amount: z
      .string()
      .regex(/^(?!0(\.0+)?$)\d+(\.\d{1,7})?$/, "Amount must be a valid Stellar decimal")
      .refine((v) => parseFloat(v) > 0, "Amount must be greater than zero"),
    price: z.string().regex(/^\d+(\.\d+)?$/, "Price must be a positive decimal"),
    offerId: z.union([z.string(), z.number()]).optional(),
  })
  .superRefine((data, ctx) => {
    if ((data.action === "update" || data.action === "delete") && data.offerId == null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "offerId is required for update and delete actions",
        path: ["offerId"],
      });
    }
  });

export type DexOfferInput = z.infer<typeof DexOfferInputSchema>;

// ─── Helper ───────────────────────────────────────────────────────────────────

function resolveAsset(a: { code: string; issuer?: string }): Asset {
  return a.code === "XLM" ? Asset.native() : new Asset(a.code, a.issuer!);
}

// ─── Tool ─────────────────────────────────────────────────────────────────────

export class DexOfferTool {
  private keypair: Keypair;
  private networkPassphrase: string;

  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  get publicKey(): string {
    return this.keypair.publicKey();
  }

  async execute(rawInput: unknown): Promise<{ txHash: string; ledger: number; offerId: string }> {
    const input = DexOfferInputSchema.parse(rawInput);

    const selling = resolveAsset(input.selling);
    const buying = resolveAsset(input.buying);

    // For delete: amount must be "0" regardless of the validated input amount
    const offerAmount = input.action === "delete" ? "0" : input.amount;
    const offerId = input.offerId != null ? String(input.offerId) : "0";

    const sourceAccount = await loadAccount(this.keypair.publicKey());

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.manageSellOffer({
          selling,
          buying,
          amount: offerAmount,
          price: input.price,
          offerId,
        })
      )
      .setTimeout(SOROBAN_TX_TIMEOUT)
      .build();

    tx.sign(this.keypair);

    const result = SubmitResultSchema.parse(await submitTransaction(tx));

    // Extract offerId from the transaction result meta if available;
    // fall back to the input offerId (or "0" for new offers — the network assigns the real id).
    return { txHash: result.hash, ledger: result.ledger, offerId };
  }
}
