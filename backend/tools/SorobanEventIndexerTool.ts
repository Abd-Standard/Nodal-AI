/**
 * backend/tools/SorobanEventIndexerTool.ts
 * Query historical Soroban contract events by ledger range.
 */

import { rpc } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config } from '../config';
import * as rpcClient from '../rpc_client';
import { withBackoffGuard } from '../network';
import { stellarContractIdSchema } from '../utils/stellarSchemas';

export const SorobanEventIndexerInputSchema = z.object({
  contractId: stellarContractIdSchema('contractId'),
  fromLedger: z.number().int().positive(),
  toLedger: z.number().int().positive(),
  topics: z.array(z.array(z.string())).optional(),
});

export type SorobanEventIndexerInput = z.infer<typeof SorobanEventIndexerInputSchema>;

export interface SorobanEventIndexerResult {
  events: rpc.Api.EventResponse[];
  latestLedger: number;
}

async function withLocalRetry<T>(
  operation: () => Promise<T>,
  retries = config.MAX_RETRIES,
  delayMs = config.RETRY_DELAY_MS
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt >= retries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

export class SorobanEventIndexerTool {
  async query(rawInput: unknown): Promise<SorobanEventIndexerResult> {
    const input = SorobanEventIndexerInputSchema.parse(rawInput);

    if (input.fromLedger > input.toLedger) {
      throw new Error('fromLedger must be less than or equal to toLedger');
    }

    const filters: rpc.Api.EventFilter[] = [
      {
        type: 'contract',
        contractIds: [input.contractId],
        ...(input.topics ? { topics: input.topics } : {}),
      },
    ];

    const response = await withBackoffGuard(() =>
      withLocalRetry(
        () =>
          (rpcClient as any).sorobanServer.getEvents({
            startLedger: input.fromLedger,
            endLedger: input.toLedger,
            filters,
          } as rpc.Server.GetEventsRequest),
        config.MAX_RETRIES,
        config.RETRY_DELAY_MS
      )
    );

    return {
      events: response.events,
      latestLedger: response.latestLedger ?? input.toLedger,
    };
  }
}
