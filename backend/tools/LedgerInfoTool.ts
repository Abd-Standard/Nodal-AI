/**
 * backend/tools/LedgerInfoTool.ts
 * Tool for querying the latest ledger state from Soroban RPC with caching.
 */

import { z } from "zod";
import { config } from "../config";
import { sorobanServer, withRetry } from "../rpc_client";
import { withBackoffGuard } from "../network";
import { createLogger } from "../utils/logger";

const log = createLogger("ledger-info-tool");

export const LedgerInfoInputSchema = z
  .object({
    forceRefresh: z.boolean().optional().default(false),
  })
  .optional()
  .default({});

export type LedgerInfoInput = z.infer<typeof LedgerInfoInputSchema>;

export interface LedgerInfoResult {
  sequence: number;
  closeTime: number;
  protocolVersion: number;
}

export class LedgerInfoTool {
  private cache: { data: LedgerInfoResult; expiresAt: number } | null = null;
  private readonly ttlMs: number;

  constructor(ttlMs: number = 6_000) {
    this.ttlMs = ttlMs;
  }

  /**
   * Fetch current ledger info from Soroban RPC.
   * Returns cached snapshot if called within 6 seconds unless forceRefresh is true.
   */
  async execute(rawInput?: unknown): Promise<LedgerInfoResult> {
    const input = LedgerInfoInputSchema.parse(rawInput ?? {});
    const now = Date.now();

    if (!input.forceRefresh && this.cache && this.cache.expiresAt > now) {
      log.debug({ cachedSequence: this.cache.data.sequence }, "Serving ledger info from cache");
      return this.cache.data;
    }

    log.info("Fetching latest ledger info from Soroban RPC");

    const response = await withBackoffGuard(() =>
      withRetry(
        () => sorobanServer.getLatestLedger(),
        config.MAX_RETRIES,
        config.RETRY_DELAY_MS
      )
    );

    const data: LedgerInfoResult = {
      sequence: Number(response.sequence),
      closeTime: Number(response.closeTime),
      protocolVersion: Number(response.protocolVersion),
    };

    this.cache = {
      data,
      expiresAt: now + this.ttlMs,
    };

    log.info(
      { sequence: data.sequence, closeTime: data.closeTime, protocolVersion: data.protocolVersion },
      "Latest ledger info fetched"
    );

    return data;
  }

  /**
   * Invalidate the active ledger cache.
   */
  clearCache(): void {
    this.cache = null;
  }
}
