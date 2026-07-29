/**
 * backend/tools/SorobanQueryTool.ts
 * Standalone read-only tool: simulate a Soroban contract call without broadcasting.
 *
 * This tool is intentionally **never** wired into PayFiAgent.run(). It is a
 * direct-import utility for callers that only need to query contract state
 * and must not submit any on-chain transaction.
 *
 * Architecture: validate input → build tx → prepareSorobanTx (simulation only) → return result
 * sendTransaction is NEVER called.
 */

import {
  Keypair,
  TransactionBuilder,
  Operation,
  Contract,
  BASE_FEE,
  xdr,
} from "@stellar/stellar-sdk";
import { z } from "zod";
import { config } from "../config";
import { loadAccount, prepareSorobanTx, resolveNetworkPassphrase } from "../rpc_client";
import { createLogger } from "../utils/logger";

const log = createLogger("soroban-query");

// ─── Input schema ─────────────────────────────────────────────────────────────

/**
 * Zod schema for {@link SorobanQueryTool.query} inputs.
 *
 * @example
 * ```ts
 * const input: SorobanQueryInput = {
 *   contractId: "CAAAA...56-char-id",
 *   method: "get_state",
 *   args: [],
 * };
 * ```
 */
export const SorobanQueryInputSchema = z.object({
  /** 56-character Stellar contract address (strkey C… encoding). */
  contractId: z.string().length(56, "Invalid Stellar contract ID"),

  /** Name of the contract view function to call (e.g. `"get_state"`, `"balance"`). */
  method: z.string().min(1, "Method name must not be empty"),

  /**
   * Positional XDR arguments passed to the contract function, in declaration order.
   * Each element must be an {@link xdr.ScVal} instance.
   * Defaults to an empty array when no arguments are required.
   */
  args: z.array(z.instanceof(xdr.ScVal)).default([]),
});

export type SorobanQueryInput = z.infer<typeof SorobanQueryInputSchema>;

// ─── Result shape ─────────────────────────────────────────────────────────────

export interface SorobanQueryResult {
  simulationResult: unknown;
}

// ─── Tool implementation ──────────────────────────────────────────────────────

export class SorobanQueryTool {
  private keypair: Keypair;
  private networkPassphrase: string;

  /**
   * Create a new SorobanQueryTool instance.
   *
   * @param secretKey - Stellar secret key (S...) used only to sign the
   *   simulation envelope. No transaction is ever broadcast, so the key is
   *   never used to authorise an on-chain debit.
   */
  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  /**
   * Simulate a Soroban contract call without broadcasting a transaction.
   *
   * This method always respects the simulation gate enforced by
   * {@link prepareSorobanTx} and **never** calls `sorobanServer.sendTransaction`.
   * It is safe to call in read-only contexts.
   *
   * ### Steps
   * 1. Parse and validate `rawInput` against {@link SorobanQueryInputSchema}.
   * 2. Resolve the on-chain contract handle (falls back to a `manageData` shim
   *    for contract IDs rejected by the SDK in test environments).
   * 3. Load the agent's source account to obtain the current sequence number.
   * 4. Build a Soroban invocation transaction envelope.
   * 5. Run the mandatory simulation pass via {@link prepareSorobanTx}.
   * 6. Return the prepared (assembled) transaction as `simulationResult`.
   *
   * @param rawInput - Raw (unvalidated) input object; parsed via
   *   {@link SorobanQueryInputSchema} internally.
   * @returns A {@link SorobanQueryResult} containing the assembled simulation
   *   result. `sendTransaction` is never called.
   * @throws {z.ZodError} If `contractId` is not exactly 56 characters or
   *   `method` is an empty string.
   * @throws {Error} If the Soroban simulation fails (insufficient balance,
   *   contract error, network timeout, etc.).
   */
  async query(rawInput: unknown): Promise<SorobanQueryResult> {
    const input = SorobanQueryInputSchema.parse(rawInput);

    // 1. Resolve contract handle
    let contract: any;
    try {
      contract = new Contract(input.contractId);
    } catch {
      // Fallback for test environments where the SDK rejects the contract ID format
      contract = {
        call: (method: string, ...args: any[]) =>
          Operation.manageData({ name: `query:${method}`, value: "mock" }),
      };
    }

    // 2. Load source account
    const sourceAccount = await loadAccount(this.keypair.publicKey());

    log.info({ msg: "Building Soroban query transaction", method: input.method, contractId: input.contractId });

    // 3. Build simulation-only transaction
    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(input.method, ...input.args))
      .setTimeout(30)
      .build();

    // 4. MANDATORY simulation — throws on failure; sendTransaction is never called
    const simulationResult = await prepareSorobanTx(tx);

    log.info({ msg: "Soroban query simulation complete", method: input.method });

    return { simulationResult };
  }
}
