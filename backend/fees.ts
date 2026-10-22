/**
 * backend/fees.ts
 * Dynamic inclusion-fee estimation and surge retry (Issue #790).
 *
 * Tools used to bid a fixed BASE_FEE, which stalls or fails as soon as the
 * network enters surge pricing. estimateFee() bids from Horizon's fee_stats
 * instead, capped by MAX_FEE_STROOPS; submitFeeBumped() is the recovery path
 * when a transaction is still rejected with tx_insufficient_fee.
 */

import {
  BASE_FEE,
  FeeBumpTransaction,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { config } from './config';
import { horizonServer, submitTransaction } from './rpc_client';
import type { Signer } from './signer';
import { createLogger } from './utils/logger';

const log = createLogger('fees');

export type FeePriority = 'low' | 'medium' | 'high';

// fee_charged percentile each priority bids at.
const PRIORITY_PERCENTILE = {
  low: 'p50',
  medium: 'p90',
  high: 'p99',
} as const;

/**
 * Per-operation inclusion fee, in stroops, for the given priority.
 *
 * Bids the fee_charged percentile for the priority (p50/p90/p99), never below
 * the network minimum (the last ledger's base fee or BASE_FEE) and never above
 * MAX_FEE_STROOPS. If fee_stats cannot be read, falls back to BASE_FEE rather
 * than blocking the transaction: the surge retry still covers a low bid.
 */
export async function estimateFee({
  priority = 'medium',
}: { priority?: FeePriority } = {}): Promise<string> {
  let estimate: number;
  try {
    const stats = await horizonServer.feeStats();
    const charged = Number(stats.fee_charged[PRIORITY_PERCENTILE[priority]]);
    const floor = Math.max(Number(BASE_FEE), Number(stats.last_ledger_base_fee));
    estimate = Math.max(floor, charged);
    if (!Number.isFinite(estimate)) {
      throw new Error('fee_stats returned a non-numeric fee');
    }
  } catch (err) {
    log.warn({ err, priority }, 'fee_stats unavailable, falling back to BASE_FEE');
    return BASE_FEE;
  }
  return String(Math.min(estimate, config.MAX_FEE_STROOPS));
}

/** Whether a submission failed because the bid fee was below the surge price. */
export function isInsufficientFeeError(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 3; depth++) {
    if (e instanceof Error && e.message.includes('tx_insufficient_fee')) return true;
    const resultCode = (
      e as { response?: { data?: { extras?: { result_codes?: { transaction?: string } } } } }
    ).response?.data?.extras?.result_codes?.transaction;
    if (resultCode === 'tx_insufficient_fee') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Resubmit a signed transaction that was rejected with tx_insufficient_fee,
 * wrapped in a fee bump paid by `signer` at the 'high' estimate.
 *
 * The rejected transaction never consumed its sequence number, so the original
 * signed envelope is reused unchanged — only the outer fee changes.
 *
 * @throws Error if MAX_FEE_STROOPS leaves no room to outbid the inner fee.
 */
export async function submitFeeBumped(
  innerTx: Transaction,
  signer: Signer,
  networkPassphrase: string
) {
  const operationCount = innerTx.operations.length || 1;
  const innerFeePerOp = Math.ceil(Number(innerTx.fee) / operationCount);
  const feePerOp = Math.min(
    Math.max(Number(await estimateFee({ priority: 'high' })), innerFeePerOp * 2),
    config.MAX_FEE_STROOPS
  );
  if (feePerOp <= innerFeePerOp) {
    throw new Error(
      `tx_insufficient_fee: fee is already at MAX_FEE_STROOPS (${config.MAX_FEE_STROOPS}); cannot fee-bump higher`
    );
  }

  // buildFeeBumpTransaction takes the per-operation rate and charges it for
  // the inner operations plus the bump itself.
  const feeBumpTx: FeeBumpTransaction = TransactionBuilder.buildFeeBumpTransaction(
    signer.publicKey(),
    String(feePerOp),
    innerTx,
    networkPassphrase
  );
  signer.signTransaction(feeBumpTx);

  log.warn(
    { innerTxHash: innerTx.hash().toString('hex'), feePerOp },
    'tx_insufficient_fee: resubmitting inside a fee bump'
  );
  return submitTransaction(feeBumpTx);
}
