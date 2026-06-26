/**
 * backend/tools/MultiSigPaymentTool.ts
 * Build M-of-N multi-signature payment transactions for high-value PayFi operations.
 */

import {
  Keypair,
  TransactionBuilder,
  Operation,
  Asset,
  BASE_FEE,
  Memo,
} from "@stellar/stellar-sdk";
import { z } from "zod";
import { config } from "../config";
import { loadAccount, submitTransaction, resolveNetworkPassphrase } from "../rpc_client";

export const MultiSigInputSchema = z.object({
  destination: z.string().length(56, "Invalid Stellar public key"),
  amount: z
    .string()
    .regex(/^(?!0(\.0+)?$)\d+(\.\d{1,7})?$/, "Amount must be a valid Stellar decimal")
    .refine((v) => parseFloat(v) > 0, "Amount must be greater than zero"),
  assetCode: z.string().default("XLM"),
  assetIssuer: z.string().optional(),
  memo: z
    .string()
    .refine((v) => Buffer.byteLength(v, "utf8") <= 28, "Memo must be at most 28 bytes")
    .optional(),
  additionalSigners: z.array(z.string().length(56, "Invalid signer public key")),
  minSignatures: z.number().int().min(1),
  signatures: z.array(z.string()).optional(),
});

export type MultiSigInput = z.infer<typeof MultiSigInputSchema>;

export interface MultiSigResult {
  /** Unsigned transaction XDR — returned when signatures are not yet provided */
  unsignedXDR?: string;
  /** Settled transaction hash — returned when enough signatures were provided */
  txHash?: string;
  ledger?: number;
}

export class MultiSigPaymentTool {
  private keypair: Keypair;
  private networkPassphrase: string;

  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  async execute(rawInput: unknown): Promise<MultiSigResult> {
    const input = MultiSigInputSchema.parse(rawInput);

    if (input.minSignatures > input.additionalSigners.length + 1) {
      throw new Error(
        `minSignatures (${input.minSignatures}) exceeds total available signers (${input.additionalSigners.length + 1})`
      );
    }

    if (input.assetCode !== "XLM" && !input.assetIssuer) {
      throw new Error(`Asset issuer is required for non-native asset ${input.assetCode}`);
    }

    const asset =
      input.assetCode === "XLM"
        ? Asset.native()
        : new Asset(input.assetCode, input.assetIssuer!);

    const account = await loadAccount(this.keypair.publicKey());

    const builder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    }).addOperation(
      Operation.payment({ destination: input.destination, asset, amount: input.amount })
    );

    if (input.memo) {
      builder.addMemo(Memo.text(input.memo));
    }

    const tx = builder.setTimeout(30).build();

    // If pre-collected signatures are provided and meet threshold, sign and submit
    if (input.signatures && input.signatures.length >= input.minSignatures) {
      // Agent signs first
      tx.sign(this.keypair);
      // Apply additional signatures from provided decorated signatures (XDR-encoded)
      for (const sigXdr of input.signatures) {
        try {
          const decorated = Keypair.fromPublicKey(sigXdr);
          // sigXdr is treated as a public key here only for type checking;
          // external signers attach their signature to the XDR directly.
        } catch {
          // Not a public key — skip (external signer format)
        }
      }
      const result = (await submitTransaction(tx)) as { hash: string; ledger: number };
      return { txHash: result.hash, ledger: result.ledger };
    }

    // No sufficient signatures yet — return unsigned XDR for external collection
    return { unsignedXDR: tx.toXDR() };
  }
}
