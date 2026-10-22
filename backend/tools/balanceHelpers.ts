/**
 * backend/tools/balanceHelpers.ts
 * Shared typed helpers for Horizon account balances.
 */

import type { Horizon } from '@stellar/stellar-sdk';

/**
 * Properly typed balance entry from Horizon account.
 */
export interface TypedBalance {
  assetType: 'native' | 'credit4' | 'credit12';
  assetCode?: string;
  assetIssuer?: string;
  balance: string;
  limit?: string;
  isAuthorized?: boolean;
  isAuthorizedToMaintainLiabilities?: boolean;
}

/**
 * Convert Horizon's balance lines to properly typed entries.
 *
 * Uses the SDK's `HorizonApi.BalanceLine` union directly so no cast is needed:
 * native lines carry no asset code/issuer/limit, and liquidity-pool share lines
 * carry no asset code/issuer, so those fields are only read when present.
 */
export function getTypedBalances(
  account: Pick<Horizon.AccountResponse, 'balances'>
): TypedBalance[] {
  return account.balances.map((b: Horizon.HorizonApi.BalanceLine) => ({
    assetType: b.asset_type as TypedBalance['assetType'],
    assetCode: 'asset_code' in b ? b.asset_code : undefined,
    assetIssuer: 'asset_issuer' in b ? b.asset_issuer : undefined,
    balance: b.balance,
    limit: 'limit' in b ? b.limit : undefined,
    isAuthorized: 'is_authorized' in b ? b.is_authorized : undefined,
    isAuthorizedToMaintainLiabilities:
      'is_authorized_to_maintain_liabilities' in b
        ? b.is_authorized_to_maintain_liabilities
        : undefined,
  }));
}

/**
 * Find a balance entry by asset code and issuer.
 */
export function findBalance(
  account: Pick<Horizon.AccountResponse, 'balances'>,
  assetCode: string,
  assetIssuer?: string
): TypedBalance | undefined {
  const balances = getTypedBalances(account);
  return balances.find((b) => {
    if (assetCode === 'XLM' || assetCode === 'native') {
      return b.assetType === 'native';
    }
    return b.assetCode === assetCode && b.assetIssuer === assetIssuer;
  });
}