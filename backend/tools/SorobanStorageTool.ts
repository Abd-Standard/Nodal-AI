/**
 * backend/tools/SorobanStorageTool.ts
 * Tool for inspecting Soroban smart contract persistent storage entries.
 */

import { Address, nativeToScVal, scValToNative, xdr } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { sorobanServer, withRetry } from '../rpc_client';
import { withBackoffGuard } from '../network';

const log = createLogger('soroban-storage');

// ─── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Recursively converts JavaScript values returned by `scValToNative`
 * (including BigInt, Uint8Array/Buffer, Map) into JSON-serializable primitives.
 */
export function toJsonSerializable(val: unknown): unknown {
  if (val === null || val === undefined) {
    return val;
  }
  if (typeof val === 'bigint') {
    return val.toString();
  }
  if (Buffer.isBuffer(val) || val instanceof Uint8Array) {
    return Buffer.from(val).toString('hex');
  }
  if (Array.isArray(val)) {
    return val.map(toJsonSerializable);
  }
  if (val instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of val.entries()) {
      obj[String(toJsonSerializable(k))] = toJsonSerializable(v);
    }
    return obj;
  }
  if (typeof val === 'object') {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(val)) {
      obj[k] = toJsonSerializable(v);
    }
    return obj;
  }
  return val;
}

// ─── Input Schema ─────────────────────────────────────────────────────────────

export const SorobanStorageInputSchema = z.object({
  /** 56-character Stellar contract address (strkey C… encoding). */
  contractId: z.string().length(56, 'Invalid Stellar contract ID'),

  /**
   * Keys to query in storage. Can be ScVal instances or native values.
   */
  keys: z
    .array(z.union([z.instanceof(xdr.ScVal), z.unknown()]))
    .min(1, 'At least one storage key must be specified'),

  /** Storage durability type: defaults to persistent. */
  durability: z.enum(['persistent', 'temporary', 'instance']).default('persistent'),
});

export type SorobanStorageInput = z.infer<typeof SorobanStorageInputSchema>;

export interface StorageEntryResult {
  key: unknown;
  value: unknown;
  lastModifiedLedgerSeq?: number;
  liveUntilLedgerSeq?: number;
}

export interface SorobanStorageResult {
  entries: StorageEntryResult[];
  latestLedger?: number;
}

// ─── Tool Class ───────────────────────────────────────────────────────────────

export class SorobanStorageTool {
  /**
   * Query contract storage entries and return decoded JSON-serializable data.
   */
  async execute(rawInput: unknown): Promise<SorobanStorageResult> {
    const input = SorobanStorageInputSchema.parse(rawInput);

    log.info(
      { contractId: input.contractId, keyCount: input.keys.length, durability: input.durability },
      'Fetching Soroban contract storage entries'
    );

    const contractAddress = new Address(input.contractId).toScAddress();

    const durabilityVal =
      input.durability === 'temporary'
        ? xdr.ContractDataDurability.temporary()
        : input.durability === 'instance'
          ? xdr.ContractDataDurability.instance()
          : xdr.ContractDataDurability.persistent();

    const ledgerKeys: xdr.LedgerKey[] = input.keys.map((key) => {
      const scVal = key instanceof xdr.ScVal ? key : nativeToScVal(key);
      return xdr.LedgerKey.contractData(
        new xdr.LedgerKeyContractData({
          contract: contractAddress,
          key: scVal,
          durability: durabilityVal,
        })
      );
    });

    const response = await withBackoffGuard(() =>
      withRetry(
        () => sorobanServer.getLedgerEntries(...ledgerKeys),
        config.MAX_RETRIES,
        config.RETRY_DELAY_MS
      )
    );

    const entries: StorageEntryResult[] = (response.entries ?? []).map((entry: any) => {
      let entryData: xdr.LedgerEntryData;
      if (typeof entry.val === 'string') {
        entryData = xdr.LedgerEntryData.fromXDR(entry.val, 'base64');
      } else if (entry.val instanceof xdr.LedgerEntryData) {
        entryData = entry.val;
      } else if (entry.val && typeof entry.val.contractData === 'function') {
        entryData = entry.val;
      } else {
        throw new Error('Unable to parse LedgerEntryData from RPC response');
      }

      const contractData = entryData.contractData();
      const keyNative = scValToNative(contractData.key());
      const valNative = scValToNative(contractData.val());

      return {
        key: toJsonSerializable(keyNative),
        value: toJsonSerializable(valNative),
        lastModifiedLedgerSeq: entry.lastModifiedLedgerSeq,
        liveUntilLedgerSeq: entry.liveUntilLedgerSeq,
      };
    });

    log.info(
      { contractId: input.contractId, entriesFound: entries.length },
      'Soroban storage query completed'
    );

    return {
      entries,
      latestLedger: response.latestLedger,
    };
  }
}
