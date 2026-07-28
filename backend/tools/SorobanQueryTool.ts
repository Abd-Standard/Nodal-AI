/**
 * backend/tools/SorobanQueryTool.ts
 * Read-only Soroban contract query tool.
 *
 * Always runs simulation via prepareSorobanTx and never broadcasts.
 * This is the safe default for AI-agent read operations.
 */

import { SorobanInvokeTool, SorobanInvokeInputSchema } from "./SorobanInvokeTool";
import { z } from "zod";
import { config } from "../config";
import { logger } from "../logger";
import { withTimeout } from "../rpc_client";

// ─── Input schema ─────────────────────────────────────────────────────────────

/**
 * Reuses SorobanInvokeInputSchema but omits simulateOnly since it's always true.
 */
export const SorobanQueryInputSchema = SorobanInvokeInputSchema.omit({ simulateOnly: true });

export type SorobanQueryInput = z.infer<typeof SorobanQueryInputSchema>;

// ─── Output shape ─────────────────────────────────────────────────────────────

export interface SorobanQueryResult {
  simulationResult: unknown;
}

// ─── Tool implementation ──────────────────────────────────────────────────────

export class SorobanQueryTool {
  private invokeTool: SorobanInvokeTool;

  constructor(secretKey: string = config.agentKeypair().secret()) {
    this.invokeTool = new SorobanInvokeTool(secretKey);
  }

  /**
   * Query a Soroban contract read-only.
   * Runs simulation via prepareSorobanTx. Never broadcasts.
   * @returns { simulationResult: unknown }
   */
  async query(rawInput: unknown): Promise<SorobanQueryResult> {
    const input = SorobanQueryInputSchema.parse(rawInput);
    logger.info("Querying Soroban contract (read-only)", {
      method: input.method,
      contractId: input.contractId,
    });
    const result = await withTimeout(
      this.invokeTool.execute({ ...input, simulateOnly: true }),
      config.RPC_TIMEOUT_MS
    );
    if ("simulationResult" in result) {
      return { simulationResult: result.simulationResult };
    }
    throw new Error("SorobanQueryTool expected simulation result but got txHash");
  }
}
