/**
 * backend/tools/ContractStorageWatcherTool.ts
 *
 * Polling mechanism for Soroban contract storage keys.
 * Detects on-chain state changes for specific contract keys even when no events are emitted.
 */

import { EventEmitter } from "events";
import { Address, rpc, xdr } from "@stellar/stellar-sdk";
import { config } from "../config";
import { logger } from "../logger";
import { sorobanServer as defaultSorobanServer } from "../rpc_client";

export interface StorageChangeEvent {
  key: xdr.LedgerKey;
  keyXdr: string;
  oldValue?: string | undefined;
  newValue?: string | undefined;
  entry?: rpc.Api.LedgerEntryResult | undefined;
  ledger?: number | undefined;
}

export interface ContractStorageWatcherOptions {
  contractId: string;
  keys: Array<xdr.LedgerKey | xdr.ScVal | string>;
  pollIntervalMs?: number | undefined;
  maxPolls?: number | undefined;
  durability?: xdr.ContractDataDurability | undefined;
  initialState?: Map<string, string> | Record<string, string> | undefined;
  server?: rpc.Server | undefined;
}

export interface ContractStorageWatcherHandle extends EventEmitter {
  (): void;
  stop(): void;
  isWatching(): boolean;
  getPollCount(): number;
}

/**
 * Normalizes input key to xdr.LedgerKey for contract data.
 */
export function normalizeLedgerKey(
  contractId: string,
  key: xdr.LedgerKey | xdr.ScVal | string,
  durability: xdr.ContractDataDurability = xdr.ContractDataDurability.persistent()
): xdr.LedgerKey {
  if (key instanceof xdr.LedgerKey) {
    return key;
  }

  const contractScAddress = new Address(contractId).toScAddress();

  if (key instanceof xdr.ScVal) {
    return xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: contractScAddress,
        key,
        durability,
      })
    );
  }

  if (typeof key === "string") {
    // 1. Try decoding as raw LedgerKey base64
    try {
      return xdr.LedgerKey.fromXDR(key, "base64");
    } catch {
      // 2. Try decoding as ScVal base64
      try {
        const scVal = xdr.ScVal.fromXDR(key, "base64");
        return xdr.LedgerKey.contractData(
          new xdr.LedgerKeyContractData({
            contract: contractScAddress,
            key: scVal,
            durability,
          })
        );
      } catch {
        // 3. Fallback: treat string as a symbol ScVal
        const scVal = xdr.ScVal.scvSymbol(key);
        return xdr.LedgerKey.contractData(
          new xdr.LedgerKeyContractData({
            contract: contractScAddress,
            key: scVal,
            durability,
          })
        );
      }
    }
  }

  throw new Error(`Unsupported key format: ${String(key)}`);
}

/**
 * Creates a function-callable EventEmitter handle.
 */
function createWatcherHandle(
  onStop: () => void,
  isWatchingFn: () => boolean,
  getPollCountFn: () => number
): ContractStorageWatcherHandle {
  const handle = function () {
    onStop();
  } as unknown as ContractStorageWatcherHandle;

  Object.setPrototypeOf(handle, EventEmitter.prototype);
  EventEmitter.call(handle as unknown as EventEmitter);

  handle.stop = onStop;
  handle.isWatching = isWatchingFn;
  handle.getPollCount = getPollCountFn;

  return handle;
}

/**
 * Standalone tool and helper to watch Soroban contract storage key changes via polling.
 */
export class ContractStorageWatcherTool extends EventEmitter {
  private contractId: string;
  private ledgerKeys: xdr.LedgerKey[];
  private keyMap: Map<string, xdr.LedgerKey> = new Map();
  private pollIntervalMs: number;
  private maxPolls?: number | undefined;
  private server: rpc.Server;

  private pollCount = 0;
  private isStopped = false;
  private isInitialized = false;
  private timerId?: NodeJS.Timeout | undefined;
  private stateCache: Map<string, string> = new Map();

  constructor(options: ContractStorageWatcherOptions) {
    super();

    this.contractId = options.contractId;
    this.pollIntervalMs = options.pollIntervalMs ?? config.CONTRACT_EVENT_POLL_MS ?? 5000;
    this.maxPolls = options.maxPolls;
    this.server = options.server ?? defaultSorobanServer;

    const durability = options.durability ?? xdr.ContractDataDurability.persistent();
    this.ledgerKeys = options.keys.map((k) => {
      const ledgerKey = normalizeLedgerKey(this.contractId, k, durability);
      const keyXdr = ledgerKey.toXDR("base64");
      this.keyMap.set(keyXdr, ledgerKey);
      return ledgerKey;
    });

    if (options.initialState) {
      if (options.initialState instanceof Map) {
        for (const [k, v] of options.initialState.entries()) {
          this.stateCache.set(k, v);
        }
      } else {
        for (const [k, v] of Object.entries(options.initialState)) {
          this.stateCache.set(k, v);
        }
      }
      this.isInitialized = true;
    }

    // Begin polling
    void this.scheduleNext(0);
  }

  public stop = (): void => {
    this.isStopped = true;
    if (this.timerId) {
      clearTimeout(this.timerId);
      this.timerId = undefined;
    }
  };

  public isWatching = (): boolean => {
    return !this.isStopped;
  };

  public getPollCount = (): number => {
    return this.pollCount;
  };

  private scheduleNext(delayMs: number): void {
    if (this.isStopped) return;
    this.timerId = setTimeout(() => {
      void this.poll();
    }, delayMs);
  }

  public async poll(): Promise<void> {
    if (this.isStopped) return;

    try {
      this.pollCount++;
      const response = await this.server.getLedgerEntries(...this.ledgerKeys);
      const currentEntries = response?.entries ?? [];
      const currentMap = new Map<string, { entry: rpc.Api.LedgerEntryResult; valXdr: string }>();

      for (const entry of currentEntries) {
        const keyXdr =
          typeof entry.key === "string"
            ? entry.key
            : entry.key?.toXDR?.("base64") ?? String(entry.key);

        const valXdr =
          typeof entry.val === "string"
            ? entry.val
            : entry.val?.toXDR?.("base64") ?? String(entry.val);

        currentMap.set(keyXdr, { entry, valXdr });
      }

      if (!this.isInitialized) {
        // First poll sets the baseline state
        for (const [keyXdr, { valXdr }] of currentMap.entries()) {
          this.stateCache.set(keyXdr, valXdr);
        }
        this.isInitialized = true;
      } else {
        // Check for modified or new keys
        for (const [keyXdr, { entry, valXdr }] of currentMap.entries()) {
          const prevVal = this.stateCache.get(keyXdr);
          if (prevVal !== valXdr) {
            const key = this.keyMap.get(keyXdr) ?? (entry.key as xdr.LedgerKey);
            const changeEvent: StorageChangeEvent = {
              key,
              keyXdr,
              oldValue: prevVal,
              newValue: valXdr,
              entry,
              ledger: response?.latestLedger,
            };
            this.stateCache.set(keyXdr, valXdr);
            this.emit("change", changeEvent);
          }
        }

        // Check for deleted keys that existed previously
        for (const [prevKeyXdr, prevVal] of this.stateCache.entries()) {
          if (!currentMap.has(prevKeyXdr)) {
            const key = this.keyMap.get(prevKeyXdr) ?? normalizeLedgerKey(this.contractId, prevKeyXdr);
            const changeEvent: StorageChangeEvent = {
              key,
              keyXdr: prevKeyXdr,
              oldValue: prevVal,
              newValue: undefined,
              ledger: response?.latestLedger,
            };
            this.stateCache.delete(prevKeyXdr);
            this.emit("change", changeEvent);
          }
        }
      }

      this.emit("poll", this.pollCount, currentEntries);
    } catch (err) {
      logger.error("ContractStorageWatcherTool polling error", {
        contractId: this.contractId,
        pollCount: this.pollCount,
        error: (err as Error).message,
      });
      this.emit("error", err);
    }

    if (this.maxPolls !== undefined && this.pollCount >= this.maxPolls) {
      this.stop();
      this.emit("done", { totalPolls: this.pollCount });
      return;
    }

    if (!this.isStopped) {
      this.scheduleNext(this.pollIntervalMs);
    }
  }
}

/**
 * Functional interface to watch contract storage changes.
 */
export function watchContractStorage(
  options: ContractStorageWatcherOptions
): ContractStorageWatcherHandle {
  const watcher = new ContractStorageWatcherTool(options);
  const handle = createWatcherHandle(watcher.stop, watcher.isWatching, watcher.getPollCount);

  watcher.on("change", (e) => handle.emit("change", e));
  watcher.on("poll", (...args) => handle.emit("poll", ...args));
  watcher.on("done", (...args) => handle.emit("done", ...args));
  watcher.on("error", (e) => handle.emit("error", e));

  return handle;
}
