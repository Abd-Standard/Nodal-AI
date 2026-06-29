/**
 * backend/tools/ContractEventListener.ts
 * Polling-based listener for Soroban contract events.
 *
 * Soroban RPC has no WebSocket stream, so this tool polls getEvents()
 * on an interval and invokes a callback for each new matching event.
 *
 * Architecture: poll getEvents() → filter by eventTypes → invoke onEvent → repeat
 */

import { rpc } from "@stellar/stellar-sdk";
import { config } from "../config";
import { logger } from "../logger";
import { sorobanServer } from "../rpc_client";

export function listen(
  contractId: string,
  eventTypes: string[],
  onEvent: (event: rpc.Api.EventResponse) => void
): () => void {
  let cursor: string | undefined;
  let startLedgerPromise: Promise<number> | undefined;

  const pollIntervalMs = config.RETRY_DELAY_MS * 2;

  const poll = async () => {
    try {
      if (!cursor && !startLedgerPromise) {
        startLedgerPromise = sorobanServer
          .getLatestLedger()
          .then((l) => l.sequence);
      }

      const response = await sorobanServer.getEvents({
        filters: [{ type: "contract", contractIds: [contractId] }],
        ...(cursor ? { cursor } : { startLedger: await startLedgerPromise! }),
      } as rpc.Server.GetEventsRequest);

      for (const event of response.events) {
        const matches =
          eventTypes.length === 0 ||
          event.topic.some((t) => eventTypes.includes(t.toString()));
        if (matches) onEvent(event);
      }

      if (response.events.length > 0) {
        cursor = response.events[response.events.length - 1].pagingToken;
      } else if ("cursor" in response && response.cursor) {
        cursor = response.cursor;
      }
    } catch (err) {
      logger.error("ContractEventListener polling error", {
        contractId,
        error: (err as Error).message,
      });
    }
  };

  const intervalId = setInterval(poll, pollIntervalMs);
  return () => clearInterval(intervalId);
}
