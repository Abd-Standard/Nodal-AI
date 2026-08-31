/**
 * backend/tools/ContractEventListener.ts
 * Polling-based listener for Soroban contract events with automatic reconnect
 * and exponential backoff on stream drop.
 *
 * Soroban RPC has no WebSocket stream, so this tool polls getEvents()
 * on an interval and invokes a callback for each new matching event.
 *
 * Architecture: poll getEvents() → filter by eventTypes → invoke onEvent → repeat
 */

import { EventEmitter } from 'events';
import { rpc } from '@stellar/stellar-sdk';
import { config } from '../config';
import { logger } from '../logger';
import { sorobanServer } from '../rpc_client';

export interface ContractEventListenerOptions {
  maxReconnectAttempts?: number;
  pollIntervalMs?: number;
}

export interface ContractEventListenerHandle extends EventEmitter {
  (): void;
  stop(): void;
}

function createListenerHandle(onStop: () => void): ContractEventListenerHandle {
  const handle = function () {
    onStop();
  } as unknown as ContractEventListenerHandle;
  Object.setPrototypeOf(handle, EventEmitter.prototype);
  EventEmitter.call(handle as unknown as EventEmitter);
  handle.stop = onStop;
  return handle;
}

export function listen(
  contractId: string,
  eventTypes: string[],
  onEvent: (event: rpc.Api.EventResponse) => void,
  options?: number | ContractEventListenerOptions
): ContractEventListenerHandle {
  let cursor: string | undefined;
  let startLedgerPromise: Promise<number> | undefined;

  const maxReconnectAttempts =
    typeof options === 'number' ? options : (options?.maxReconnectAttempts ?? 5);

  const pollIntervalMs =
    (typeof options === 'object' && options?.pollIntervalMs) ||
    config.CONTRACT_EVENT_POLL_MS ||
    config.RETRY_DELAY_MS * 2;

  let reconnectAttempts = 0;
  let isStopped = false;
  let timerId: NodeJS.Timeout | undefined;

  const stop = () => {
    isStopped = true;
    if (timerId) {
      clearTimeout(timerId);
      timerId = undefined;
    }
  };

  const handle = createListenerHandle(stop);

  const poll = async () => {
    if (isStopped) return;

    try {
      if (!cursor && !startLedgerPromise) {
        startLedgerPromise = sorobanServer.getLatestLedger().then((l) => l.sequence);
      }

      const response = await sorobanServer.getEvents({
        filters: [{ type: 'contract', contractIds: [contractId] }],
        ...(cursor ? { cursor } : { startLedger: await startLedgerPromise! }),
      } as rpc.Server.GetEventsRequest);

      // Successfully contacted RPC: reset reconnect attempts
      reconnectAttempts = 0;

      for (const event of response.events) {
        const matches =
          eventTypes.length === 0 || event.topic.some((t) => eventTypes.includes(t.toString()));
        if (matches) onEvent(event);
      }

      if (response.events.length > 0) {
        const lastEvent = response.events[response.events.length - 1];
        if (lastEvent) {
          cursor = lastEvent.pagingToken;
        }
      } else if ('cursor' in response && response.cursor) {
        cursor = response.cursor;
      }

      if (!isStopped) {
        timerId = setTimeout(poll, pollIntervalMs);
      }
    } catch (err) {
      reconnectAttempts++;
      logger.error('ContractEventListener polling error', {
        contractId,
        reconnectAttempts,
        maxReconnectAttempts,
        error: (err as Error).message,
      });

      if (reconnectAttempts >= maxReconnectAttempts) {
        isStopped = true;
        if (timerId) {
          clearTimeout(timerId);
          timerId = undefined;
        }
        handle.emit('error', err);
        return;
      }

      if (!isStopped) {
        const baseDelay = pollIntervalMs;
        const exponential = baseDelay * Math.pow(2, reconnectAttempts - 1);
        const backoffDelay = Math.min(exponential, 30_000);
        timerId = setTimeout(poll, backoffDelay);
      }
    }
  };

  void poll();
  return handle;
}
