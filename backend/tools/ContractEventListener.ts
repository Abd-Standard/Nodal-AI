/**
 * backend/tools/ContractEventListener.ts
 * Polling-based listener for Soroban contract events with automatic reconnect
 * and exponential backoff on stream drop.
 *
 * Soroban RPC has no WebSocket stream, so this tool polls getEvents()
 * on an interval and invokes a callback for each new matching event.
 *
 * Architecture: poll getEvents() → filter by eventTypes → invoke onEvent → repeat
 *
 * API CONTRACT & RETURN VALUE:
 * ----------------------------
 * `listen()` returns a `ContractEventListenerHandle` which extends `EventEmitter`
 * and is also callable as a stop function:
 * 1. Callable stop function: Calling `handle()` directly stops polling (used by
 *    callers treating the return value as a cleanup callback, e.g., agent.ts).
 * 2. Method `handle.stop()`: Explicit stop method.
 * 3. EventEmitter events:
 *    - 'error': Emitted when reconnect retries are exhausted (if an 'error' listener is registered).
 *    - 'connectionError': Emitted when reconnect retries are exhausted.
 * 4. Callback:
 *    - Pass an `onError` callback in `options` to be notified of exhaustion directly.
 */

import { EventEmitter } from 'events';
import { rpc } from '@stellar/stellar-sdk';
import { config } from '../config';
import { logger } from '../logger';
import { sorobanServer } from '../rpc_client';

export interface ContractEventListenerOptions {
  /** Maximum number of consecutive polling failures before giving up. Default: 5 */
  maxReconnectAttempts?: number;
  /** Polling interval in milliseconds. Default: 2000ms (or config.RETRY_DELAY_MS * 2) */
  pollIntervalMs?: number;
  /**
   * Optional callback invoked when polling fails after maxReconnectAttempts.
   * Preferred over listening for 'connectionError' events.
   */
  onError?: (error: Error) => void;
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

  const normalizedOptions: ContractEventListenerOptions =
    typeof options === 'number' ? { maxReconnectAttempts: options } : (options ?? {});

  const maxReconnectAttempts = normalizedOptions.maxReconnectAttempts ?? 5;
  const onErrorCallback = normalizedOptions.onError;

  const pollIntervalMs =
    normalizedOptions.pollIntervalMs ||
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
      } as rpc.Api.GetEventsRequest);

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
          cursor = lastEvent.id;
        }
      } else if ('cursor' in response && response.cursor) {
        cursor = response.cursor;
      }

      if (!isStopped) {
        timerId = setTimeout(poll, pollIntervalMs);
      }
    } catch (err) {
      reconnectAttempts++;
      logger.error(
        {
          contractId,
          reconnectAttempts,
          maxReconnectAttempts,
          error: (err as Error).message,
        },
        'ContractEventListener polling error'
      );

      if (reconnectAttempts >= maxReconnectAttempts) {
        isStopped = true;
        if (timerId) {
          clearTimeout(timerId);
          timerId = undefined;
        }

        const error = err instanceof Error ? err : new Error(String(err));

        // Emit 'error' event on handle if listeners are registered.
        // Node's EventEmitter throws unhandled exception if 'error' is emitted with no listener,
        // so checking listenerCount protects callers that treat handle as a pure stop function.
        if (handle.listenerCount('error') > 0) {
          handle.emit('error', error);
        }

        // Also emit safe custom event 'connectionError'
        handle.emit('connectionError', error);

        // Also call the optional onError callback if provided (preferred approach)
        if (onErrorCallback) {
          try {
            onErrorCallback(error);
          } catch (callbackErr) {
            logger.error(
              {
                contractId,
                error: (callbackErr as Error).message,
              },
              'ContractEventListener onError callback threw'
            );
          }
        }

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
