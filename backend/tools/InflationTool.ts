/**
 * backend/tools/InflationTool.ts
 * Configure and query the account inflation destination via SET_OPTIONS.
 *
 * @deprecated Since this release; the `inflation` task type will be removed in
 * the next minor release (#782; removal tracked in #874). Inflation has been disabled on Stellar since
 * protocol 12. To read an account's legacy inflation destination, use
 * `account_info` (`inflationDestination`). Every execution logs a deprecation
 * warning.
 *
 * DEPRECATED ON-NETWORK: Stellar's inflation mechanism is deprecated and
 * inactive — no inflation pool payouts have been distributed for years.
 * `SET_OPTIONS`'s `inflationDest` field is still accepted by the protocol and
 * still tracked by Horizon, but setting it has no economic effect: it does not
 * earn the account any inflation income. This tool is retained only for
 * completeness and for inspecting/updating legacy account state; do not build
 * workflows that expect real inflation payouts from it.
 *
 * The destination can only be set or changed — it cannot be cleared — so the
 * mutation surface is a single `set` action backed by an `Operation.setOptions`
 * wrapper, plus a read-only `get` action backed by a Horizon account lookup.
 */

import { TransactionBuilder, Operation, BASE_FEE } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config } from '../config';
import { createAgentSigner, Signer } from '../signer';
import { loadAccount, submitTransaction, resolveNetworkPassphrase } from '../rpc_client';
import { SubmitResultSchema } from './StellarPaymentTool';
import { SOROBAN_TX_TIMEOUT } from './SorobanInvokeTool';
import { stellarPublicKeySchema } from '../utils/stellarSchemas';
import { createLogger } from '../utils/logger';

const log = createLogger('inflation');

export const INFLATION_DEPRECATION_WARNING =
  'The inflation task type is deprecated and will be removed in the next minor release: ' +
  'inflation has been disabled on Stellar since protocol 12, so it has no effect. ' +
  'Use account_info to read an inflation destination.';

export const InflationInputSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('set'),
    inflationDestination: stellarPublicKeySchema('Inflation destination'),
  }),
  z.object({
    action: z.literal('get'),
    accountId: stellarPublicKeySchema('accountId').optional(),
  }),
]);

export type InflationInput = z.infer<typeof InflationInputSchema>;

/**
 * Result of setting an inflation destination.
 *
 * NOTE: Stellar's inflation mechanism is deprecated/inactive. The
 * `inflationDest` field is still settable and Horizon still records it, but it
 * has no economic effect — no inflation payouts are distributed.
 */
export interface InflationSetResult {
  action: 'set';
  txHash: string;
  ledger: number;
  inflationDestination: string;
}

/**
 * Result of reading an account's inflation destination.
 *
 * NOTE: Stellar's inflation mechanism is deprecated/inactive. A non-null
 * `inflationDestination` reflects legacy account state only; it does not
 * indicate the account receives (or will receive) any inflation payouts.
 */
export interface InflationGetResult {
  action: 'get';
  accountId: string;
  /** The account's inflation destination, or null when none is set. */
  inflationDestination: string | null;
  isSet: boolean;
}

export type InflationResult = InflationSetResult | InflationGetResult;

/** @deprecated Inflation is disabled on Stellar; removed in the next minor release (#782). */
export class InflationTool {
  private signer: Signer;
  private networkPassphrase: string;

  constructor(signer: Signer = createAgentSigner()) {
    this.signer = signer;
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  /** Read the inflation destination for an account (defaults to the agent's own). */
  async get(accountId?: string): Promise<InflationGetResult> {
    const targetAccount = accountId ?? this.signer.publicKey();
    const account = await loadAccount(targetAccount);
    const inflationDestination = account.inflation_destination ?? null;

    return {
      action: 'get',
      accountId: targetAccount,
      inflationDestination,
      isSet: inflationDestination !== null,
    };
  }

  /**
   * Nominate an inflation destination for the agent account via SET_OPTIONS.
   *
   * Deprecated/inactive: the field is still settable but has no economic
   * effect on-network.
   */
  async set(inflationDestination: string): Promise<InflationSetResult> {
    const account = await loadAccount(this.signer.publicKey());

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.setOptions({
          inflationDest: inflationDestination,
        })
      )
      .setTimeout(SOROBAN_TX_TIMEOUT)
      .build();

    this.signer.signTransaction(tx);
    const result = SubmitResultSchema.parse(await submitTransaction(tx));

    return {
      action: 'set',
      txHash: result.hash,
      ledger: result.ledger,
      inflationDestination,
    };
  }

  async execute(rawInput: unknown): Promise<InflationResult> {
    log.warn(INFLATION_DEPRECATION_WARNING);
    const input = InflationInputSchema.parse(rawInput);

    if (input.action === 'get') {
      return this.get(input.accountId);
    }

    return this.set(input.inflationDestination);
  }
}
