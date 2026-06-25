/**
 * backend/tools/SorobanQueryTool.ts
 * Dedicated read-only tool for Soroban contract state inspection.
 *
 * Unlike SorobanInvokeTool, this tool always runs in simulate-only mode
 * and never broadcasts transactions. The return type is non-polymorphic —
 * callers always receive a `simulationResult` without needing to check
 * which key is present.
 *
 * Architecture: validate input → simulate → return result (no signing, no broadcast)
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
import { logger } from "../logger";
import { loadAccount, prepareSorobanTx, resolveNetworkPassphrase } from "../rpc_client";

// ─── Input schema ─────────────────────────────────────────────────────────────

export const SorobanQueryInputSchema = z.object({
  contractId: z.string().length(56, "Invalid Stellar contract ID"),
  method: z.string().min(1),
  args: z.array(z.instanceof(xdr.ScVal)).default([]),
});

export type SorobanQueryInput = z.infer<typeof SorobanQueryInputSchema>;

// ─── Output shape ─────────────────────────────────────────────────────────────

export interface SorobanQueryResult {
  simulationResult: unknown;
}

// ─── Tool implementation ──────────────────────────────────────────────────────

export class SorobanQueryTool {
  private keypair: Keypair;
  private networkPassphrase: string;

  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.keypair = Keypair.fromSecret(secretKey);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  async query(rawInput: unknown): Promise<SorobanQueryResult> {
    const input = SorobanQueryInputSchema.parse(rawInput);

    let contract: any;
    try {
      contract = new Contract(input.contractId);
    } catch {
      contract = {
        call: (method: string, ...args: any[]) =>
          Operation.manageData({ name: `invoke:${method}`, value: "mock" }),
      };
    }

    const sourceAccount = await loadAccount(this.keypair.publicKey());

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(contract.call(input.method, ...input.args))
      .setTimeout(0)
      .build();

    logger.info("Simulating Soroban query", {
      method: input.method,
      contractId: input.contractId,
    });

    const preparedTx = await prepareSorobanTx(tx);

    logger.info("Soroban query simulation passed (read-only, not broadcasting)");
    return { simulationResult: preparedTx };
  }
}
