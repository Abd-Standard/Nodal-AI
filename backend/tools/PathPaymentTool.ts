/**
 * backend/tools/PathPaymentTool.ts
 * Cross-asset path payment via Stellar's pathPaymentStrictSend operation.
 * Enables sending one asset and having the recipient receive a different asset
 * through the Stellar DEX (e.g., send XLM, recipient receives USDC).
 *
 * When no `path` or `destMinAmount` is supplied, the best path is discovered
 * via Horizon's strict-send endpoint and `destMinAmount` is derived from its
 * quote less `maxSlippageBps` (Issue #789).
 */

import { TransactionBuilder, Operation, Asset } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config } from '../config';
import { createAgentSigner, Signer } from '../signer';
import { logger } from '../logger';
import {
  horizonServer,
  loadAccount,
  resolveNetworkPassphrase,
  submitTransaction,
} from '../rpc_client';
import { ValidationError } from '../errors';
import { createLogger } from '../utils/logger';
import { SubmitResultSchema, buildMemo } from './StellarPaymentTool';
import { SOROBAN_TX_TIMEOUT } from './SorobanInvokeTool';
import { stellarPublicKeySchema } from '../utils/stellarSchemas';
import { assertDestinationReady } from '../utils/destinationPreflight';

const log = createLogger('path-payment');

// ─── Input schema ─────────────────────────────────────────────────────────────

const AssetSchema = z.object({
  code: z.string(),
  issuer: z.string().optional(),
});

/** Default tolerance below the quoted destination amount: 0.5%. */
export const DEFAULT_MAX_SLIPPAGE_BPS = 50;
/** Largest accepted slippage tolerance: 10%. */
export const MAX_SLIPPAGE_BPS = 1000;

export const PathPaymentInputSchema = z.object({
  destination: paymentDestinationSchema('destination'),
  sendAsset: AssetSchema,
  sendAmount: z
    .string()
    .regex(/^(?!0(\.0+)?$)\d+(\.\d{1,7})?$/, 'sendAmount must be a valid Stellar decimal')
    .refine((v) => parseFloat(v) > 0, 'sendAmount must be greater than zero'),
  destAsset: AssetSchema,
  /** Minimum the destination must receive. Omit to derive it from the best path's quote. */
  destMinAmount: z
    .string()
    .regex(/^(?!0(\.0+)?$)\d+(\.\d{1,7})?$/, 'destMinAmount must be a valid Stellar decimal')
    .refine((v) => parseFloat(v) > 0, 'destMinAmount must be greater than zero')
    .optional(),
  /** Tolerance below the quoted amount, in basis points, used when destMinAmount is omitted. */
  maxSlippageBps: z
    .number()
    .int('maxSlippageBps must be an integer')
    .min(0, 'maxSlippageBps must be at least 0')
    .max(MAX_SLIPPAGE_BPS, `maxSlippageBps must be at most ${MAX_SLIPPAGE_BPS}`)
    .optional()
    .default(DEFAULT_MAX_SLIPPAGE_BPS),
  /** Intermediate assets. Omit (or leave empty) to use the best path Horizon finds. */
  path: z.array(AssetSchema).optional().default([]),
  allowSelfPayment: z.boolean().optional().default(false),
  memoType: z.enum(['text', 'id', 'hash', 'return']).optional().default('text'),
  memo: z.union([z.string(), z.number()]).optional(),
});

export type PathPaymentInput = z.infer<typeof PathPaymentInputSchema>;

// ─── Helper ───────────────────────────────────────────────────────────────────

function toAsset(a: { code: string; issuer?: string | undefined }): Asset {
  if (a.code === 'XLM') return Asset.native();
  if (!a.issuer) {
    throw new Error(`Asset issuer is required for non-native asset ${a.code}`);
  }
  return new Asset(a.code, a.issuer);
}

const STROOP_SCALE = 10_000_000n;

function toStroops(decimal: string): bigint {
  const [whole, fraction = ''] = decimal.split('.');
  return BigInt(whole!) * STROOP_SCALE + BigInt(fraction.slice(0, 7).padEnd(7, '0'));
}

function fromStroops(stroops: bigint): string {
  return `${stroops / STROOP_SCALE}.${(stroops % STROOP_SCALE).toString().padStart(7, '0')}`;
}

/**
 * The least a quoted `amount` may fall to under `bps` basis points of
 * slippage, rounded down to the stroop. Integer math, so no float error.
 */
export function applySlippage(amount: string, bps: number): string {
  return fromStroops((toStroops(amount) * BigInt(10_000 - bps)) / 10_000n);
}

// ─── Tool implementation ──────────────────────────────────────────────────────

export class PathPaymentTool {
  private signer: Signer;
  private networkPassphrase: string;

  constructor(signer: Signer = createAgentSigner()) {
    this.signer = signer;
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  get publicKey(): string {
    return this.signer.publicKey();
  }

  async execute(rawInput: unknown): Promise<{ txHash: string; ledger: number }> {
    const input = PathPaymentInputSchema.parse(rawInput);

    const { accountId: destination, memo: federationMemo } = await resolveDestination(
      input.destination
    );
    if (federationMemo && input.memo !== undefined) {
      throw new ValidationError(
        `${input.destination} requires a federation memo; do not also supply a memo`
      );
    }

    if (!input.allowSelfPayment && baseAccountId(destination) === this.signer.publicKey()) {
      throw new Error("Payment destination cannot be the agent's own address");
    }

    const sendAsset = toAsset(input.sendAsset);
    const destAsset = toAsset(input.destAsset);

    // Pre-flight: destination exists, trusts destAsset, and gets any SEP-29 required memo
    await assertDestinationReady({
      destination: input.destination,
      asset: destAsset,
      hasMemo: input.memo !== undefined,
    });
    let pathAssets = input.path.map(toAsset);
    let destMin = input.destMinAmount;

    if (pathAssets.length === 0 || destMin === undefined) {
      const paths = await horizonServer
        .strictSendPaths(sendAsset, input.sendAmount, [destAsset])
        .call();
      if (!paths || !paths.records || paths.records.length === 0) {
        throw new ValidationError('No path found between assets');
      }
      // Strict-send: the best path is the one that delivers the most.
      const best = paths.records.reduce((a, b) =>
        toStroops(b.destination_amount) > toStroops(a.destination_amount) ? b : a
      );
      if (pathAssets.length === 0) {
        pathAssets = best.path.map((p) =>
          p.asset_type === 'native' ? Asset.native() : new Asset(p.asset_code, p.asset_issuer)
        );
      }
      if (destMin === undefined) {
        destMin = applySlippage(best.destination_amount, input.maxSlippageBps);
        if (toStroops(destMin) === 0n) {
          throw new ValidationError(
            `Quoted destination amount ${best.destination_amount} is too small to protect with slippage`
          );
        }
      }
    }
    const destMinAmount = destMin;

    let sourceAccount = await loadAccount(this.signer.publicKey());
    const fee = await estimateFee();

    const buildTx = () => {
      const builder = new TransactionBuilder(sourceAccount, {
        fee,
        networkPassphrase: this.networkPassphrase,
      }).addOperation(
        Operation.pathPaymentStrictSend({
          sendAsset,
          sendAmount: input.sendAmount,
          destination,
          destAsset,
          destMin: destMinAmount,
          path: pathAssets,
        })
      );

      if (federationMemo) {
        builder.addMemo(federationMemo);
      } else if (input.memo !== undefined) {
        const memo = buildMemo(input.memoType, input.memo);
        if (memo) {
          builder.addMemo(memo);
        }
      }

      return builder.setTimeout(SOROBAN_TX_TIMEOUT).build();
    };

    logger.info(
      {
        source: this.signer.publicKey(),
        destination: input.destination,
        sendAmount: input.sendAmount,
        sendAsset: input.sendAsset.code,
        destAsset: input.destAsset.code,
        destMinAmount: input.destMinAmount,
      },
      'Executing path payment'
    );

    let tx = buildTx();
    this.signer.signTransaction(tx);

    try {
      const result = SubmitResultSchema.parse(await submitTransaction(tx));
      return { txHash: result.hash, ledger: result.ledger };
    } catch (err: unknown) {
      if (isInsufficientFeeError(err)) {
        const result = SubmitResultSchema.parse(
          await submitFeeBumped(tx, this.signer, this.networkPassphrase)
        );
        return { txHash: result.hash, ledger: result.ledger };
      }
      if (err instanceof Error && err.message.includes('tx_bad_seq')) {
        logger.warn(
          {
            source: this.signer.publicKey(),
          },
          'tx_bad_seq detected, reloading account and retrying once'
        );
        // Bypass the account cache: the whole point of this retry is that the
        // sequence we used was wrong, so a cached record must not be reused.
        sourceAccount = await loadAccount(this.signer.publicKey(), { forceRefresh: true });
        tx = buildTx();
        this.signer.signTransaction(tx);
        const result = SubmitResultSchema.parse(await submitTransaction(tx));
        return { txHash: result.hash, ledger: result.ledger };
      }
      throw err;
    }
  }
}
