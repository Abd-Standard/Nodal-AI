/**
 * backend/tools/AccountHistoryTool.ts
 * Fetch paginated payment operations for an account from Horizon.
 *
 * `limit` caps the number of *matching* records returned, not the size of the
 * raw Horizon page. Horizon's /payments endpoint also returns non-`payment`
 * operations (create_account, path payments, account_merge, ...) and the
 * optional `assetCode` filter drops more, so a single raw page can yield far
 * fewer than `limit` matches. The tool therefore keeps fetching subsequent
 * pages until it has `limit` matches or history is exhausted — bounded by
 * {@link MAX_HISTORY_PAGES} so a rare asset on a high-activity account can't
 * trigger unbounded Horizon calls. When that cap stops the scan early,
 * `pageLimitReached` is true and `nextCursor` resumes where the scan stopped.
 */

import { z } from 'zod';
import { config } from '../config';
import { horizonServer, withRetry } from '../rpc_client';
import { withBackoffGuard } from '../network';
import { stellarPublicKeySchema } from '../utils/stellarSchemas';

export interface PaymentRecord {
  id: string;
  type: string;
  from: string;
  to: string;
  amount: string;
  asset: string;
  createdAt: string;
  pagingToken: string;
}

/**
 * Maximum number of raw Horizon pages fetched by a single `fetch()` call while
 * trying to collect `limit` matching records.
 */
export const MAX_HISTORY_PAGES = 5;

export interface AccountHistoryResult {
  /** Matching payment records, newest first; at most `limit` entries. */
  records: PaymentRecord[];
  /**
   * Cursor to pass back as `cursor` to continue after the last record scanned,
   * or `null` when Horizon's history for the account is exhausted.
   */
  nextCursor: string | null;
  /** Number of raw Horizon pages fetched to build this result. */
  pagesFetched: number;
  /**
   * True when the scan stopped because it hit {@link MAX_HISTORY_PAGES} before
   * collecting `limit` matches. Fewer than `limit` records then does NOT mean
   * there is no more history; continue from `nextCursor`.
   */
  pageLimitReached: boolean;
}

type HorizonPaymentRecord = {
  id: string;
  type: string;
  from?: string;
  to?: string;
  amount?: string;
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  created_at: string;
  paging_token: string;
};

export const AccountHistoryInputSchema = z.object({
  publicKey: stellarPublicKeySchema('publicKey').optional(),
  limit: z.number().int().min(1).max(200).optional().default(10),
  cursor: z.string().optional(),
  assetCode: z.string().optional(),
});

export type AccountHistoryInput = z.infer<typeof AccountHistoryInputSchema>;

function formatAsset(assetType: string, assetCode?: string, assetIssuer?: string): string {
  if (assetType === 'native') return 'XLM';
  return `${assetCode}:${assetIssuer}`;
}

function matchesAssetCode(asset: string, filterCode: string): boolean {
  if (filterCode === 'XLM') {
    return asset === 'XLM';
  }
  return asset.startsWith(`${filterCode}:`);
}

function toPaymentRecord(record: HorizonPaymentRecord): PaymentRecord | null {
  if (record.type !== 'payment') {
    return null;
  }

  return {
    id: record.id,
    type: record.type,
    from: record.from ?? '',
    to: record.to ?? '',
    amount: record.amount ?? '0',
    asset: formatAsset(record.asset_type, record.asset_code, record.asset_issuer),
    createdAt: record.created_at,
    pagingToken: record.paging_token,
  };
}

export class AccountHistoryTool {
  async fetch(rawInput: unknown): Promise<AccountHistoryResult> {
    const input = AccountHistoryInputSchema.parse(rawInput);
    const publicKey = input.publicKey ?? config.AGENT_PUBLIC_KEY;

    const records: PaymentRecord[] = [];
    let cursor = input.cursor;
    let pagesFetched = 0;
    let exhausted = false;

    while (records.length < input.limit && pagesFetched < MAX_HISTORY_PAGES) {
      let query = horizonServer.payments().forAccount(publicKey).order('desc').limit(input.limit);
      if (cursor) {
        query = query.cursor(cursor);
      }

      const response = await withBackoffGuard(() =>
        withRetry(() => query.call(), config.MAX_RETRIES, config.RETRY_DELAY_MS)
      );
      pagesFetched++;

      const page = response.records as unknown as HorizonPaymentRecord[];
      let consumed = 0;
      for (const raw of page) {
        // Advance the cursor past every raw record consumed, matching or not,
        // so a follow-up call never re-scans records already skipped here.
        cursor = raw.paging_token;
        consumed++;
        const record = toPaymentRecord(raw);
        if (record && (!input.assetCode || matchesAssetCode(record.asset, input.assetCode))) {
          records.push(record);
          if (records.length === input.limit) break;
        }
      }

      // A short page means Horizon has no older records for this account;
      // history is exhausted once every record on it has been consumed.
      if (page.length < input.limit) {
        exhausted = consumed === page.length;
        break;
      }
    }

    const nextCursor = exhausted ? null : (cursor ?? null);
    const pageLimitReached = !exhausted && records.length < input.limit;

    return { records, nextCursor, pagesFetched, pageLimitReached };
  }
}
