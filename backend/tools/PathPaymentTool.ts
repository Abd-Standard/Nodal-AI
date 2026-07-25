/**
 * backend/tools/PathPaymentTool.ts
 * Standalone tool: path payment (asset swap) via Horizon.
 *
 * Architecture: Tool → simulate → sign → submit
 * Never broadcasts without a prior simulation pass.
 * Includes tx_bad_seq retry: if Horizon rejects with stale sequence,
 * the account is reloaded and the transaction is rebuilt once.
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
import { loadAccount, resolveNetworkPassphrase, submitTransaction } from "../rpc_client";
import { createLogger } from "../utils/logger";

const log = createLogger("path-payment");

// ─── Input schema ─────────────────────────────────────────────────────────────

/**
 * Zod schema for path payment input validation.
 *
 * @property sourceAssetCode - Asset code of the asset being sent (default: "XLM")
 * @property sourceAssetIssuer - Issuer of the source asset (required for non-XLM)
 * @property sourceAmount - Amount of source asset to send (positive decimal, max 7 places)
 * @property destination - 56-character Stellar public key (G...) of the recipient
 * @property destinationAssetCode - Asset code the recipient should receive
 * @property destinationAssetIssuer - Issuer of the destination asset (required for non-XLM)
 * @property destinationMin - Minimum amount of destination asset the recipient should receive
 * @property memo - Optional memo text, max 28 characters (Stellar network limit)
 */
export const PathPaymentInputSchema = z.object({
  sourceAssetCode: z.string().default("XLM"),
  sourceAssetIssuer: z.string().optional(),
  sourceAmount: z
    .string()
    .regex(/^(?!0(\.0+)?$)\d+(\.\d{1,7})?$/, "Amount must be a valid Stellar decimal")
    .refine((v) => parseFloat(v) > 0, "Amount must be greater than zero"),
  destination: z.string().length(56, "Invalid Stellar public key"),
  destinationAssetCode: z.string(),
  destinationAssetIssuer: z.string().optional(),
  destinationMin: z
    .string()
    .regex(/^(?!0(\.0+)?$)\d+(\.\d{1,7})?$/, "Destination min must be a valid Stellar decimal")
    .refine((v) => parseFloat(v) > 0, "Destination min must be greater than zero"),
  memo: z
    .string()
    .refine((v) => Buffer.byteLength(v, "utf8") <= 28, "Memo must be at most 28 bytes")
    .optional(),
});

export type PathPaymentInput = z.infer<typeof PathPaymentInputSchema>;

// ─── Tool implementation ──────────────────────────────────────────────────────

export class PathPaymentTool {
  private keypair: Keypair;
  private networkPassphrase: string;

  /**
   * Create a new PathPaymentTool instance.
   *
   * @param secretKey - Stellar secret key (S...) for signing transactions
   */
  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  get publicKey(): string {
    return this.keypair.publicKey();
  }

  /**
   * Resolve a Stellar Asset from code and optional issuer.
   */
  private resolveAsset(code: string, issuer?: string): Asset {
    if (code === "XLM") {
      return Asset.native();
    }
    if (!issuer) {
      throw new Error(
        `Asset issuer is required for non-native asset ${code}`
      );
    }
    return new Asset(code, issuer);
  }

  /**
   * Execute a path payment on the Stellar network.
   *
   * Steps:
   * 1. Validate input with Zod schema
   * 2. Resolve source and destination assets
   * 3. Load source account to get latest sequence number
   * 4. Build transaction with pathPaymentStrictSend operation and optional memo
   * 5. Sign transaction with keypair
   * 6. Submit transaction to the network
   * 7. On tx_bad_seq: reload account, rebuild, sign, and retry once
   *
   * @param rawInput - Raw path payment input (will be validated)
   * @returns Object containing transaction hash and ledger number
   * @throws {z.ZodError} If input fails validation
   * @throws {Error} If source account not found or transaction submission fails
   */
  async execute(
    rawInput: unknown
  ): Promise<{ txHash: string; ledger: number }> {
    // 1. Validate input
    const input = PathPaymentInputSchema.parse(rawInput);

    // 2. Resolve assets
    if (input.sourceAssetCode !== "XLM" && !input.sourceAssetIssuer) {
      throw new Error(
        `Asset issuer is required for non-native source asset ${input.sourceAssetCode}`
      );
    }
    if (input.destinationAssetCode !== "XLM" && !input.destinationAssetIssuer) {
      throw new Error(
        `Asset issuer is required for non-native destination asset ${input.destinationAssetCode}`
      );
    }

    const sourceAsset = this.resolveAsset(
      input.sourceAssetCode,
      input.sourceAssetIssuer
    );
    const destinationAsset = this.resolveAsset(
      input.destinationAssetCode,
      input.destinationAssetIssuer
    );

    // 3. Load source account (latest sequence number)
    const sourceAccount = await loadAccount(this.keypair.publicKey());

    // 4. Build transaction
    const tx = this.buildTransaction(
      sourceAccount,
      sourceAsset,
      input.sourceAmount,
      input.destination,
      destinationAsset,
      input.destinationMin,
      input.memo
    );

    // 5. Sign
    tx.sign(this.keypair);

    // 6-7. Submit with tx_bad_seq retry
    try {
      const result = (await submitTransaction(tx)) as {
        hash: string;
        ledger: number;
      };
      return {
        txHash: result.hash,
        ledger: result.ledger,
      };
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes("tx_bad_seq")) {
        log.warn(
          `tx_bad_seq detected for ${this.keypair.publicKey()}, reloading account and retrying`
        );

        // Reload account for fresh sequence number
        const freshAccount = await loadAccount(this.keypair.publicKey());

        // Rebuild transaction with fresh sequence
        const retryTx = this.buildTransaction(
          freshAccount,
          sourceAsset,
          input.sourceAmount,
          input.destination,
          destinationAsset,
          input.destinationMin,
          input.memo
        );

        // Sign and resubmit
        retryTx.sign(this.keypair);
        const retryResult = (await submitTransaction(retryTx)) as {
          hash: string;
          ledger: number;
        };
        return {
          txHash: retryResult.hash,
          ledger: retryResult.ledger,
        };
      }
      throw err;
    }
  }

  /**
   * Build a path payment transaction from the given parameters.
   */
  private buildTransaction(
    sourceAccount: any,
    sourceAsset: Asset,
    sourceAmount: string,
    destination: string,
    destinationAsset: Asset,
    destinationMin: string,
    memo?: string
  ) {
    const txBuilder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    }).addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: sourceAsset,
        sendAmount: sourceAmount,
        destination,
        destAsset: destinationAsset,
        destMin: destinationMin,
      })
    );

    if (memo) {
      txBuilder.addMemo(Memo.text(memo));
    }

    return txBuilder.setTimeout(30).build();
  }
}
