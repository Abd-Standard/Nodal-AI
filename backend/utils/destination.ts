/**
 * Payment destination resolution (Issue #786).
 *
 * Users and LLMs naturally write `alice*example.com` (a SEP-2 federation
 * address) where the tools expect a `G…`/`M…` account. `resolveDestination()`
 * turns either form into an account the protocol can pay, plus the memo the
 * federation server says payments to that user require — an exchange deposit
 * sent without its memo is a lost deposit, so the memo is part of the result,
 * not an optional extra.
 */

import { Federation, Memo } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { ValidationError } from '../errors';
import { isValidStellarDestination, stellarDestinationSchema } from './stellarSchemas';

/** How long a federation lookup is reused before the server is asked again. */
export const FEDERATION_CACHE_TTL_MS = 5 * 60 * 1_000;

/** Upper bound on a single federation lookup (stellar.toml fetch + query). */
const FEDERATION_TIMEOUT_MS = 10_000;

// SEP-2: `<name>*<domain>`. The name may itself contain `@` (email-style
// names are common) but never `*`; the domain must be a dotted hostname.
const FEDERATION_ADDRESS_REGEX = /^[^*\s]+\*(?:[a-z0-9-]+\.)+[a-z]{2,}$/i;

/** Whether a string is a federation address (`name*domain.com`). */
export function isFederationAddress(value: string): boolean {
  return FEDERATION_ADDRESS_REGEX.test(value);
}

/**
 * A payment destination field: a `G…` account, a muxed `M…` account, or a
 * federation address. Account forms keep the strkey checksum check and its
 * existing error message.
 */
export function paymentDestinationSchema(label = 'Destination') {
  const accountSchema = stellarDestinationSchema(label);
  return z.string().superRefine((value, ctx) => {
    if (isFederationAddress(value)) return;
    const result = accountSchema.safeParse(value);
    if (!result.success) {
      for (const issue of result.error.issues) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue.message });
      }
    }
  });
}

export interface ResolvedDestination {
  /** A `G…` or `M…` account, ready for an operation's `destination`. */
  accountId: string;
  /** Memo the federation server requires on payments to this user, if any. */
  memo?: Memo;
}

type CacheEntry = { value: ResolvedDestination; expiresAt: number };

// Keyed by the lower-cased federation address: SEP-2 names are
// case-insensitive, so `Alice*Example.com` and `alice*example.com` share one
// lookup.
const federationCache = new Map<string, CacheEntry>();

/** Drop every cached federation lookup. Exposed for tests. */
export function clearFederationCache(): void {
  federationCache.clear();
}

function toMemo(memoType: string | undefined, memo: string | undefined): Memo | undefined {
  if (memo === undefined || memo === '') return undefined;
  switch (memoType) {
    case 'id':
      return Memo.id(memo);
    case 'hash':
      // SEP-2 transmits hash memos base64-encoded.
      return Memo.hash(Buffer.from(memo, 'base64').toString('hex'));
    case 'text':
    case undefined:
      return Memo.text(memo);
    default:
      throw new ValidationError(`Federation server returned unsupported memo_type "${memoType}"`);
  }
}

/**
 * Resolve a payment destination to a payable account and any required memo.
 *
 * `G…` and `M…` addresses are returned as-is. Federation addresses are looked
 * up with `Federation.Server.resolve` and cached for FEDERATION_CACHE_TTL_MS.
 *
 * @throws ValidationError if the destination is neither form, the lookup
 *   fails, or the server returns an invalid account or memo.
 */
export async function resolveDestination(destination: string): Promise<ResolvedDestination> {
  if (isValidStellarDestination(destination)) {
    return { accountId: destination };
  }
  if (!isFederationAddress(destination)) {
    throw new ValidationError(`Invalid payment destination: ${destination}`);
  }

  const key = destination.toLowerCase();
  const cached = federationCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  if (cached) federationCache.delete(key);

  let record: Federation.Api.Record;
  try {
    record = await Federation.Server.resolve(destination, { timeout: FEDERATION_TIMEOUT_MS });
  } catch (err) {
    throw new ValidationError(`Federation lookup failed for ${destination}`, err);
  }

  if (!isValidStellarDestination(record.account_id)) {
    throw new ValidationError(
      `Federation server returned an invalid account for ${destination}: ${record.account_id}`
    );
  }

  let memo: Memo | undefined;
  try {
    memo = toMemo(record.memo_type, record.memo);
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError(`Federation server returned an invalid memo for ${destination}`, err);
  }

  const value: ResolvedDestination = memo
    ? { accountId: record.account_id, memo }
    : { accountId: record.account_id };
  federationCache.set(key, { value, expiresAt: Date.now() + FEDERATION_CACHE_TTL_MS });
  return value;
}
