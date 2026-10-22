/**
 * backend/tools/AccountInfoTool.ts
 * Fetch agent account balances, sequence number, and trustlines from Horizon.
 */

import { config } from '../config';
import { loadAccount } from '../rpc_client';
import { getTypedBalances } from './balanceHelpers';

export interface AccountInfo {
  publicKey: string;
  balances: { asset: string; balance: string }[];
  sequenceNumber: string;
  subentryCount: number;
  /**
   * Legacy inflation destination, read-only. Inflation is disabled on Stellar;
   * this is kept so the value stays readable after the `inflation` task type
   * is removed (#782).
   */
  inflationDestination: string | null;
}

export class AccountInfoTool {
  async fetch(): Promise<AccountInfo> {
    const account = await loadAccount(config.AGENT_PUBLIC_KEY);

    const balances = getTypedBalances(account).map((b) => ({
      asset: b.assetType === 'native' ? 'XLM' : `${b.assetCode}:${b.assetIssuer}`,
      balance: b.balance,
    }));

    return {
      publicKey: config.AGENT_PUBLIC_KEY,
      balances,
      sequenceNumber: account.sequenceNumber(),
      subentryCount: account.subentry_count,
      inflationDestination: account.inflation_destination ?? null,
    };
  }
}
