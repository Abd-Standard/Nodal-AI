/**
 * backend/tools/X402PaymentTool.ts
 * x402 machine-to-machine PayFi payment tool.
 */

import { Horizon } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { config } from '../config';
import { createAgentSigner, Signer } from '../signer';
import { horizonServer, withRetry } from '../rpc_client';
import { withBackoffGuard } from '../network';
import { StellarPaymentTool } from './StellarPaymentTool';
import { buildMemo } from './MemoAttachmentTool';
import { logger } from '../logger';
import { INonceStore, SqliteNonceStore, MAX_NONCE_TTL_MS } from '../nonce_store';
import { getStorage } from '../db/storage';
import { TransactionFailureError } from '../errors';
import { stellarPublicKeySchema } from '../utils/stellarSchemas';

/**
 * Best-effort recovery of a transaction hash from a submission error.
 *
 * A hash is only present when the transaction actually reached Horizon and was
 * rejected — a failure during building, signing, or a network timeout has none.
 * `TransactionFailureError.txHash` is therefore optional, and this returns
 * `undefined` rather than inventing a value.
 */
function extractTxHash(err: unknown): string | undefined {
  if (err === null || typeof err !== 'object') return undefined;

  const candidate = err as {
    txHash?: unknown;
    hash?: unknown;
    response?: { data?: { hash?: unknown } };
  };

  for (const value of [candidate.txHash, candidate.hash, candidate.response?.data?.hash]) {
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

// ─── x402 schemas ────────────────────────────────────────────────────────────

export const X402ChallengeSchema = z
  .object({
    resource: z.string().url('Must be a valid resource URL'),
    amount: z.string(),
    assetCode: z.string().default(config.X402_ASSET_CODE),
    assetIssuer: z.string().default(config.X402_ASSET_ISSUER),
    payTo: stellarPublicKeySchema('payTo'),
    nonce: z.string().uuid('Nonce must be a UUID v4'),
    expiresAt: z.string().datetime(),
  })
  .refine((data) => data.assetCode === 'XLM' || !!data.assetIssuer, {
    message: 'assetIssuer is required for non-XLM payments',
    path: ['assetIssuer'],
  });

export type X402Challenge = z.infer<typeof X402ChallengeSchema>;

export interface X402PaymentProof {
  protocol: 'x402';
  network: string;
  txHash: string;
  nonce: string;
  payer: string;
  signedAt: string;
}

// ─── Challenge terms validation ──────────────────────────────────────────────

function parseAllowedAssets(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Rejects challenges that request an unexpected asset, a spoofed issuer for a
 * known asset code (e.g. a fake `USDC`), or more than `X402_MAX_PRICE`.
 */
function assertAcceptableChallengeTerms(challenge: X402Challenge): void {
  const allowed = config.X402_ALLOWED_ASSETS
    ? parseAllowedAssets(config.X402_ALLOWED_ASSETS)
    : undefined;

  if (challenge.assetCode !== 'XLM') {
    // Known codes: the configured x402 asset plus every code in the allow-list.
    const trustedIssuers = new Map<string, Set<string>>();
    const trust = (code: string, issuer: string) => {
      const issuers = trustedIssuers.get(code) ?? new Set<string>();
      issuers.add(issuer);
      trustedIssuers.set(code, issuers);
    };
    trust(config.X402_ASSET_CODE, config.X402_ASSET_ISSUER);
    for (const entry of allowed ?? []) {
      const [code, issuer] = entry.split(':');
      if (code && issuer) trust(code, issuer);
    }

    const issuers = trustedIssuers.get(challenge.assetCode);
    if (issuers && !issuers.has(challenge.assetIssuer)) {
      throw new Error(
        `x402: assetIssuer ${challenge.assetIssuer} is not a trusted issuer for ${challenge.assetCode}`
      );
    }
  }

  if (allowed) {
    const asset =
      challenge.assetCode === 'XLM' ? 'XLM' : `${challenge.assetCode}:${challenge.assetIssuer}`;
    if (!allowed.includes(asset)) {
      throw new Error(`x402: asset ${asset} is not in X402_ALLOWED_ASSETS`);
    }
  }

  if (config.X402_MAX_PRICE && parseFloat(challenge.amount) > parseFloat(config.X402_MAX_PRICE)) {
    throw new Error(
      `x402: challenge amount ${challenge.amount} exceeds X402_MAX_PRICE of ${config.X402_MAX_PRICE}`
    );
  }
}

// ─── Tool implementation ──────────────────────────────────────────────────────

const RATE_LIMIT_WINDOW_MS = 60_000;

export class X402PaymentTool {
  private nonceStore: INonceStore;
  private paymentTool: StellarPaymentTool;
  private signer: Signer;
  private horizonServer: Horizon.Server;
  private paymentCount = 0;
  private windowStart = Date.now();

  /**
   * @param signer      - Signs payments; defaults to the agent signer.
   * @param nonceStore  - Pluggable nonce store.  Defaults to SqliteNonceStore
   *                      backed by the shared agent.db file, or to the shared
   *                      Postgres store when STORAGE_BACKEND=postgres.  Inject
   *                      an InMemoryNonceStore (or a custom implementation of
   *                      INonceStore) in tests.
   */
  constructor(signer: Signer = createAgentSigner(), nonceStore?: INonceStore) {
    this.signer = signer;
    this.paymentTool = new StellarPaymentTool(signer);
    this.horizonServer = horizonServer;
    this.nonceStore =
      nonceStore ??
      (config.STORAGE_BACKEND === 'postgres'
        ? getStorage().nonceStore()
        : new SqliteNonceStore(new Database(config.DB_PATH)));
  }

  /**
   * Respond to an x402 `402 Payment Required` challenge by executing a
   * Stellar payment and returning a signed proof of payment.
   *
   * ### Processing steps
   * 1. Parse and validate `rawChallenge` against {@link X402ChallengeSchema}.
   * 2. Guard against self-payment (payTo must not equal the agent's public key).
   * 3. Reject unexpected assets (`X402_ALLOWED_ASSETS`), spoofed issuers for
   *    known asset codes, and amounts above `X402_MAX_PRICE`.
   * 4. If `ALLOWED_X402_ORIGINS` is configured, verify the challenge resource
   *    hostname is in the allow-list.
   * 5. Reject expired challenges (`expiresAt` < now).
   * 6. Delegate to {@link StellarPaymentTool.execute} to sign and submit
   *    the payment, using `SHA-256(nonce)[0:28 hex]` as the transaction memo.
   * 7. Return an {@link X402PaymentProof} with the settled `txHash`.
   *
   * @param rawChallenge - Raw (unvalidated) challenge object, typically the
   *   parsed JSON body of a `402 Payment Required` HTTP response.
   * @returns A resolved {@link X402PaymentProof} containing the `txHash`,
   *   original `nonce`, agent `payer` address, and `signedAt` timestamp.
   * @throws {z.ZodError} If `rawChallenge` does not conform to
   *   {@link X402ChallengeSchema} (missing fields, bad UUID, expired datetime, etc.).
   * @throws {Error} If the challenge has expired, the resource origin is not
   *   allowed, the asset/issuer/amount is not acceptable, the destination equals the agent's own address, or the underlying
   *   Stellar payment fails.
   */
  async respond(rawChallenge: unknown): Promise<X402PaymentProof> {
    const now = Date.now();
    if (now - this.windowStart >= RATE_LIMIT_WINDOW_MS) {
      this.paymentCount = 0;
      this.windowStart = now;
    }

    if (this.paymentCount >= config.MAX_X402_PAYMENTS_PER_MINUTE) {
      throw new Error('x402: rate limit exceeded');
    }
    this.paymentCount++;

    const challenge = X402ChallengeSchema.parse(rawChallenge);

    if (challenge.payTo === this.signer.publicKey()) {
      throw new Error("Payment destination cannot be the agent's own address");
    }

    assertAcceptableChallengeTerms(challenge);

    if (config.ALLOWED_X402_ORIGINS) {
      const allowedOrigins = config.ALLOWED_X402_ORIGINS.split(',').map((o) => o.trim());
      const hostname = new URL(challenge.resource).hostname;
      if (!allowedOrigins.includes(hostname)) {
        throw new Error('x402: untrusted resource origin');
      }
    } else {
      logger.warn('ALLOWED_X402_ORIGINS is not set. All origins accepted.');
    }

    if (new Date(challenge.expiresAt) < new Date()) {
      throw new Error(`x402 challenge expired at ${challenge.expiresAt}`);
    }

    if (await this.nonceStore.has(challenge.nonce)) {
      throw new Error('x402: nonce already used');
    }

    let txHash: string;
    let ledger: number;
    try {
      ({ txHash, ledger } = await this.paymentTool.execute({
        destination: challenge.payTo,
        amount: challenge.amount,
        assetCode: challenge.assetCode,
        assetIssuer: challenge.assetCode === 'XLM' ? undefined : challenge.assetIssuer,
        // SPEC: memo = SHA-256(nonce)[0:28 hex chars]; resource server must apply the same derivation to verify.
        memo: buildMemo({
          type: 'MEMO_TEXT',
          value: createHash('sha256').update(challenge.nonce).digest('hex').slice(0, 28),
        }).value as string,
      }));
    } catch (err) {
      // #371: preserve the Horizon result code (e.g. op_underfunded, op_no_trust)
      // and the tx hash (when the failure happened after submission) as a
      // structured error, instead of losing that detail to a generic rejection.
      const message = err instanceof Error ? err.message : String(err);
      throw new TransactionFailureError(message, extractTxHash(err), err);
    }

    await this.nonceStore.add(challenge.nonce);
    // Opportunistic pruning: evict nonces older than the max challenge TTL.
    // Fire-and-forget — a pruning failure must not abort a successful payment.
    this.nonceStore
      .prune(MAX_NONCE_TTL_MS)
      .catch((err) =>
        logger.warn({ error: String(err) }, 'x402: nonce pruning failed (non-fatal)')
      );

    let signedAt: string;
    try {
      const ledgerRecord: any = await withBackoffGuard(() =>
        withRetry(
          () => this.horizonServer.ledgers().ledger(ledger).call(),
          config.MAX_RETRIES,
          config.RETRY_DELAY_MS,
        ),
      );
      signedAt = ledgerRecord.closed_at;
    } catch {
      signedAt = new Date().toISOString();
    }

    return {
      protocol: 'x402',
      network: config.STELLAR_NETWORK,
      txHash,
      nonce: challenge.nonce,
      payer: this.signer.publicKey(),
      signedAt,
    };
  }

  /**
   * Verify that an {@link X402PaymentProof} corresponds to a settled Stellar
   * transaction that satisfies the original challenge's requirements.
   *
   * Fetches the transaction and its first operation from Horizon and checks:
   * - destination matches `originalChallenge.payTo`
   * - amount matches `originalChallenge.amount`
   * - asset code matches `originalChallenge.assetCode`
   * - transaction memo equals `originalChallenge.nonce.slice(0, 28)`
   * - source account matches `proof.payer`
   *
   * @param proof - The {@link X402PaymentProof} returned by {@link respond}.
   * @param originalChallenge - The parsed {@link X402Challenge} that was used
   *   to produce `proof`. Must be the same challenge passed to {@link respond}.
   * @returns Resolves with `void` when all checks pass.
   * @throws {Error} If the transaction cannot be found on Horizon, if the
   *   transaction has no payment operation, or if any of the verification
   *   checks (destination, amount, asset, memo, payer) fail.
   */
  async verify(proof: X402PaymentProof, originalChallenge: X402Challenge): Promise<void> {
    const tx = await withBackoffGuard(() =>
      withRetry(
        () => this.horizonServer.transactions().transaction(proof.txHash).call(),
        config.MAX_RETRIES,
        config.RETRY_DELAY_MS,
      ),
    );

    const ops = await withBackoffGuard(() =>
      withRetry(
        () => this.horizonServer.operations().forTransaction(proof.txHash).call(),
        config.MAX_RETRIES,
        config.RETRY_DELAY_MS,
      ),
    );

    const op = ops.records?.[0];

    if (!op) {
      throw new Error('x402 verification failed: missing operation');
    }

    const parsed = this.extractOp(op);

    if (parsed.to !== originalChallenge.payTo) {
      throw new Error('x402 verification failed: destination mismatch');
    }

    if (parsed.amount !== originalChallenge.amount) {
      throw new Error('x402 verification failed: amount mismatch');
    }

    if (parsed.assetCode !== originalChallenge.assetCode) {
      throw new Error('x402 verification failed: asset mismatch');
    }

    const expectedMemo = createHash('sha256')
      .update(originalChallenge.nonce)
      .digest('hex')
      .slice(0, 28);

    if (tx.memo !== expectedMemo) {
      throw new Error('x402 verification failed: nonce mismatch');
    }

    if (parsed.from !== proof.payer) {
      throw new Error('x402 verification failed: payer mismatch');
    }
  }

  private extractOp(op: any) {
    return {
      to: op.to || op.destination,
      amount: op.amount,
      // Horizon payment ops for native XLM carry `asset_type: "native"` and no
      // asset_code field at all — without this, every legitimate XLM payment
      // would fail verification with a spurious asset mismatch.
      assetCode: op.asset_type === 'native' ? 'XLM' : op.asset_code || op.asset?.code,
      from: op.from || op.source_account,
    };
  }
}
