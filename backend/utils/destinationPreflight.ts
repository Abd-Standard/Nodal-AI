/**
 * Destination pre-flight checks (Issue #788).
 *
 * A payment to an account that does not exist, that has no trustline for the
 * asset, or that requires a memo the sender left off either fails on-chain
 * (costing the fee) or — for exchanges that credit deposits by memo — succeeds
 * and loses the funds. These checks run before signing so each case surfaces
 * as a typed error instead.
 */

import { Asset, NotFoundError } from '@stellar/stellar-sdk';
import { loadAccount } from '../rpc_client';
import { DestinationNotFoundError, MemoRequiredError, MissingTrustlineError } from '../errors';

/** Minimum balance of a new account: 2 × the 0.5 XLM base reserve. */
export const MIN_ACCOUNT_BALANCE_XLM = 1;

/** SEP-29: an account sets this data entry to "1" when incoming payments must carry a memo. */
export const MEMO_REQUIRED_DATA_KEY = 'config.memo_required';
// Horizon returns data entry values base64-encoded.
const MEMO_REQUIRED_DATA_VALUE = Buffer.from('1').toString('base64');

export interface DestinationPreflight {
  destination: string;
  /** Asset the destination will receive. */
  asset: Asset;
  /** Whether the transaction carries a memo. */
  hasMemo: boolean;
  /** Amount the destination will receive; only used to word the createAccount suggestion. */
  amount?: string;
}

/** Whether an error (or one it wraps) is Horizon's 404 for a missing account. */
function isAccountNotFound(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 3; depth++) {
    if (e instanceof NotFoundError) return true;
    const status = (e as { response?: { status?: number } }).response?.status;
    if (status === 404) return true;
    // rpc_client's retry wrapper keeps the underlying message but not the class.
    if (e instanceof Error && /\bnot found\b/i.test(e.message)) return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

function notFoundMessage({ destination, asset, amount }: DestinationPreflight): string {
  const base = `Destination account ${destination} does not exist`;
  if (!asset.isNative()) {
    return `${base}; it must be created and add a trustline for ${asset.getCode()} before it can receive it`;
  }
  if (amount !== undefined && parseFloat(amount) < MIN_ACCOUNT_BALANCE_XLM) {
    return (
      `${base}. Creating it requires a createAccount operation with a starting balance ` +
      `of at least ${MIN_ACCOUNT_BALANCE_XLM} XLM (2 × base reserve); ${amount} XLM is not enough`
    );
  }
  return `${base}. Use a createAccount operation (starting balance ≥ ${MIN_ACCOUNT_BALANCE_XLM} XLM) instead of a payment`;
}

/**
 * Check that `destination` can receive this payment.
 *
 * @throws DestinationNotFoundError if the account does not exist.
 * @throws MemoRequiredError if the account sets SEP-29 `config.memo_required` and no memo is attached.
 * @throws MissingTrustlineError if the asset is non-native and the account has no trustline for it.
 */
export async function assertDestinationReady(check: DestinationPreflight): Promise<void> {
  const { destination, asset, hasMemo } = check;

  let account: Awaited<ReturnType<typeof loadAccount>>;
  try {
    account = await loadAccount(destination);
  } catch (err) {
    if (!isAccountNotFound(err)) throw err;
    throw new DestinationNotFoundError(notFoundMessage(check), destination, err);
  }

  if (!hasMemo && account.data_attr?.[MEMO_REQUIRED_DATA_KEY] === MEMO_REQUIRED_DATA_VALUE) {
    throw new MemoRequiredError(
      `Destination ${destination} requires a memo (SEP-29 ${MEMO_REQUIRED_DATA_KEY}); add the memo the recipient gave you`,
      destination
    );
  }

  // An issuer receives its own asset without a trustline.
  if (!asset.isNative() && asset.getIssuer() !== destination) {
    const trusted = account.balances.some(
      (b) =>
        'asset_code' in b &&
        b.asset_code === asset.getCode() &&
        'asset_issuer' in b &&
        b.asset_issuer === asset.getIssuer()
    );
    if (!trusted) {
      throw new MissingTrustlineError(
        `Destination ${destination} has no trustline for ${asset.getCode()}:${asset.getIssuer()}`,
        destination,
        `${asset.getCode()}:${asset.getIssuer()}`
      );
    }
  }
}
