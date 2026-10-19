/**
 * backend/payments/mpp.ts
 * MPP Charge client: facilitator-free per-request payments (Issue #777).
 *
 * MPP (Machine Payments Protocol) Charge settles each paid HTTP request with
 * an on-chain SEP-41 `transfer` on Stellar — typically through a Stellar Asset
 * Contract (SAC) such as USDC — with no facilitator in between. This is the
 * client half, selected with `protocol: 'mpp-charge'` (see {@link MppChargeClient}):
 *
 *   1. The request is sent; a paid route answers `402` with
 *      `WWW-Authenticate: Payment id="…", realm="…", method="stellar",
 *      intent="charge", request="<base64url JSON>"[, expires="…"]`.
 *      The request carries `amount` (base units), `currency` (SEP-41 contract
 *      `C…`), `recipient` and `methodDetails.network` (CAIP-2).
 *   2. The agent's spending policy is applied (kill switch, AGENT_SPENDING_LIMIT,
 *      the mainnet cap, and a reservation in the rolling spending window).
 *   3. A `transfer(payer, recipient, amount)` invocation is built, simulated,
 *      checked to authorize exactly that transfer and nothing else, and signed
 *      with the agent signer.
 *   4. The request is retried with `Authorization: Payment <base64url JSON>`
 *      carrying the echoed challenge and `{ type: "transaction", transaction:
 *      <signed XDR> }`. The server broadcasts it ("pull" mode) and answers with
 *      the resource plus an optional `Payment-Receipt` header.
 *
 * Wire format: https://paymentauth.org/draft-stellar-charge-00, matching
 * `@stellar/mpp`'s client. Server-sponsored (`feePayer`) challenges are not
 * supported: the agent pays its own network fee.
 */

import {
  Address,
  BASE_FEE,
  Contract,
  StrKey,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  scValToBigInt,
  xdr,
} from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config, MAINNET_SPENDING_CAP } from '../config';
import { AgentPausedError, PolicyViolationError, ValidationError } from '../errors';
import { isPaused } from '../kill_switch';
import { loadAccount, prepareSorobanTx, resolveNetworkPassphrase } from '../rpc_client';
import { createAgentSigner, Signer } from '../signer';
import { spendingTracker } from '../spending_tracker';
import { SOROBAN_TX_TIMEOUT } from '../tools/SorobanInvokeTool';
import { createLogger } from '../utils/logger';
import { caip2Network } from '../x402/middleware';

const log = createLogger('mpp-charge');

export const MPP_CHARGE_PROTOCOL = 'mpp-charge';

/** SACs and the assets the agent pays with use 7 decimal places. */
const DECIMALS = 7;

// ─── Challenge parsing ───────────────────────────────────────────────────────

/**
 * Parse the auth-params of every `Payment` challenge in a `WWW-Authenticate`
 * header. Other schemes in the same header are skipped.
 */
export function parsePaymentChallenges(header: string): Record<string, string>[] {
  const challenges: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;
  let i = 0;

  while (i < header.length) {
    while (i < header.length && /[\s,]/.test(header[i]!)) i++;
    const start = i;
    while (i < header.length && /[A-Za-z0-9_-]/.test(header[i]!)) i++;
    const token = header.slice(start, i);
    if (!token) {
      i++; // skip a stray character rather than loop forever
      continue;
    }
    while (i < header.length && header[i] === ' ') i++;

    if (header[i] !== '=') {
      // A bare token starts a new challenge (auth scheme).
      current = token.toLowerCase() === 'payment' ? {} : null;
      if (current) challenges.push(current);
      continue;
    }

    i++; // '='
    while (i < header.length && header[i] === ' ') i++;
    let value = '';
    if (header[i] === '"') {
      i++;
      while (i < header.length && header[i] !== '"') {
        if (header[i] === '\\') i++;
        value += header[i] ?? '';
        i++;
      }
      i++; // closing quote
    } else {
      const valueStart = i;
      while (i < header.length && header[i] !== ',') i++;
      value = header.slice(valueStart, i).trim();
    }
    if (current) current[token] = value;
  }

  return challenges;
}

const ChargeRequestSchema = z.object({
  /** Amount in base units (stroops). */
  amount: z.string().regex(/^[1-9]\d*$/, 'amount must be a positive integer in base units'),
  /** SEP-41 token contract (C…). */
  currency: z.string().refine(StrKey.isValidContract, 'currency must be a contract address'),
  /** Recipient account (G…) or contract (C…). */
  recipient: z
    .string()
    .refine(
      (v) => StrKey.isValidEd25519PublicKey(v) || StrKey.isValidContract(v),
      'recipient must be a Stellar account or contract address'
    ),
  description: z.string().optional(),
  methodDetails: z
    .object({
      network: z.string(),
      feePayer: z.boolean().optional(),
      credentialTypes: z.array(z.string()).optional(),
    })
    .optional(),
});

export type MppChargeRequest = z.infer<typeof ChargeRequestSchema>;

export interface MppChargeChallenge {
  id: string;
  realm: string;
  method: 'stellar';
  intent: 'charge';
  /** The `request` auth-param exactly as received; echoed back unmodified. */
  rawRequest: string;
  request: MppChargeRequest;
  expires?: string;
  description?: string;
  digest?: string;
  opaque?: string;
}

/** Pick and decode the Stellar charge challenge from a 402 response, if it offers one. */
export function parseChargeChallenge(header: string): MppChargeChallenge | undefined {
  const params = parsePaymentChallenges(header).find(
    (c) => c.method === 'stellar' && c.intent === 'charge'
  );
  if (!params) return undefined;
  if (!params.id || !params.realm || !params.request) {
    throw new ValidationError('MPP challenge is missing id, realm or request');
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(params.request, 'base64url').toString('utf8'));
  } catch (err) {
    throw new ValidationError('MPP challenge request is not base64url JSON', err);
  }

  return {
    id: params.id,
    realm: params.realm,
    method: 'stellar',
    intent: 'charge',
    rawRequest: params.request,
    request: ChargeRequestSchema.parse(decoded),
    ...(params.expires !== undefined && { expires: params.expires }),
    ...(params.description !== undefined && { description: params.description }),
    ...(params.digest !== undefined && { digest: params.digest }),
    ...(params.opaque !== undefined && { opaque: params.opaque }),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fromBaseUnits(amount: string): string {
  const value = BigInt(amount);
  const scale = 10n ** BigInt(DECIMALS);
  return `${value / scale}.${(value % scale).toString().padStart(DECIMALS, '0')}`;
}

/**
 * Refuse to sign unless every Soroban authorization in the simulated
 * transaction is exactly the requested `transfer`. A malicious `currency`
 * contract could otherwise plant extra authorized calls (e.g. a transfer of
 * another token) into the tree the agent signs.
 */
function assertAuthorizesOnlyTransfer(
  tx: Transaction,
  expected: { currency: string; from: string; to: string; amount: bigint }
): void {
  for (const op of tx.toEnvelope().v1().tx().operations()) {
    if (op.body().switch().value !== xdr.OperationType.invokeHostFunction().value) {
      throw new ValidationError('Refusing to sign: MPP transaction has a non-Soroban operation');
    }
    for (const entry of op.body().invokeHostFunctionOp().auth()) {
      const invocation = entry.rootInvocation();
      const fn = invocation.function();
      if (
        invocation.subInvocations().length > 0 ||
        fn.switch().value !==
          xdr.SorobanAuthorizedFunctionType.sorobanAuthorizedFunctionTypeContractFn().value
      ) {
        throw new ValidationError('Refusing to sign: unexpected authorization in MPP transaction');
      }
      const call = fn.contractFn();
      const args = call.args();
      if (
        Address.fromScAddress(call.contractAddress()).toString() !== expected.currency ||
        call.functionName().toString() !== 'transfer' ||
        args.length !== 3 ||
        Address.fromScVal(args[0]!).toString() !== expected.from ||
        Address.fromScVal(args[1]!).toString() !== expected.to ||
        scValToBigInt(args[2]!) !== expected.amount
      ) {
        throw new ValidationError(
          'Refusing to sign: authorization does not match the requested transfer'
        );
      }
    }
  }
}

/**
 * The agent's spending policy, as applied to every value-moving task: the kill
 * switch, the single-payment AGENT_SPENDING_LIMIT, the mainnet safety cap, and
 * a reservation against the cumulative rolling window.
 *
 * @returns The reservation id to commit or release.
 */
function reserveSpend(amount: string): string {
  if (isPaused()) {
    throw new AgentPausedError('Agent is paused; MPP charge payments are halted');
  }
  const parsed = parseFloat(amount);
  if (parsed > parseFloat(config.AGENT_SPENDING_LIMIT)) {
    throw new PolicyViolationError(
      `MPP charge of ${amount} exceeds AGENT_SPENDING_LIMIT of ${config.AGENT_SPENDING_LIMIT}`
    );
  }
  if (config.STELLAR_NETWORK === 'mainnet' && parsed > MAINNET_SPENDING_CAP) {
    throw new PolicyViolationError(
      `MPP charge of ${amount} exceeds mainnet spending cap of ${MAINNET_SPENDING_CAP}`
    );
  }
  return spendingTracker.reserve(amount);
}

// ─── Client ──────────────────────────────────────────────────────────────────

/** What was paid for a request, returned alongside the paid response. */
export interface MppChargePayment {
  protocol: typeof MPP_CHARGE_PROTOCOL;
  /** CAIP-2 network, e.g. `stellar:testnet`. */
  network: string;
  challengeId: string;
  payer: string;
  recipient: string;
  /** SEP-41 token contract the transfer was made in. */
  currency: string;
  /** Amount as a 7-decimal string. */
  amount: string;
  /** Transaction hash from the server's `Payment-Receipt`, when it sends one. */
  reference?: string;
}

export interface MppChargeResult {
  response: Response;
  /** Present when the request was paid for. */
  payment?: MppChargePayment;
}

export class MppChargeClient {
  readonly protocol = MPP_CHARGE_PROTOCOL;
  private signer: Signer;
  private network: string;
  private networkPassphrase: string;

  constructor(signer: Signer = createAgentSigner()) {
    this.signer = signer;
    this.network = caip2Network(config.STELLAR_NETWORK);
    this.networkPassphrase = resolveNetworkPassphrase(config.STELLAR_NETWORK);
  }

  /**
   * `fetch` that pays MPP Charge challenges. A response that is not a `402`
   * with a Stellar charge challenge is returned unchanged and unpaid.
   *
   * @throws ValidationError if the challenge is malformed, expired, for another
   *   network, server-sponsored, or its simulation authorizes anything but the
   *   requested transfer.
   * @throws PolicyViolationError | AgentPausedError if the spending policy refuses the charge.
   */
  async fetch(url: string | URL, init: RequestInit = {}): Promise<MppChargeResult> {
    const first = await fetch(url, init);
    const header = first.headers.get('www-authenticate');
    if (first.status !== 402 || !header) return { response: first };

    const challenge = parseChargeChallenge(header);
    if (!challenge) return { response: first };
    const { request } = challenge;

    if (request.methodDetails && request.methodDetails.network !== this.network) {
      throw new ValidationError(
        `MPP challenge is for ${request.methodDetails.network}, but the agent is on ${this.network}`
      );
    }
    if (challenge.expires && new Date(challenge.expires).getTime() <= Date.now()) {
      throw new ValidationError(`MPP challenge expired at ${challenge.expires}`);
    }
    if (request.methodDetails?.feePayer) {
      throw new ValidationError('Server-sponsored (feePayer) MPP charges are not supported');
    }
    const credentialTypes = request.methodDetails?.credentialTypes;
    if (credentialTypes && !credentialTypes.includes('transaction')) {
      throw new ValidationError(
        `MPP server does not accept transaction credentials (accepts: ${credentialTypes.join(', ')})`
      );
    }

    const amount = fromBaseUnits(request.amount);
    const payer = this.signer.publicKey();
    const reservationId = reserveSpend(amount);

    let transaction: string;
    try {
      transaction = await this.buildSignedTransfer(challenge, payer);
    } catch (err) {
      // Nothing was sent, so nothing can have been spent.
      spendingTracker.release(reservationId);
      throw err;
    }

    const credential = Buffer.from(
      JSON.stringify({
        challenge: {
          id: challenge.id,
          realm: challenge.realm,
          method: challenge.method,
          intent: challenge.intent,
          request: challenge.rawRequest,
          ...(challenge.description !== undefined && { description: challenge.description }),
          ...(challenge.digest !== undefined && { digest: challenge.digest }),
          ...(challenge.expires !== undefined && { expires: challenge.expires }),
          ...(challenge.opaque !== undefined && { opaque: challenge.opaque }),
        },
        payload: { type: 'transaction', transaction },
        source: `did:pkh:${this.network}:${payer}`,
      })
    ).toString('base64url');

    const headers = new Headers(init.headers);
    headers.set('Authorization', `Payment ${credential}`);

    let response: Response;
    try {
      response = await fetch(url, { ...init, headers });
    } finally {
      // Once the signed transfer has left the agent the server may broadcast it
      // whatever it answers, so the spend counts against the window.
      spendingTracker.commit(reservationId);
    }

    const reference = readReceiptReference(response);
    log.info(
      { realm: challenge.realm, amount, recipient: request.recipient, status: response.status },
      'MPP charge paid'
    );

    return {
      response,
      payment: {
        protocol: MPP_CHARGE_PROTOCOL,
        network: this.network,
        challengeId: challenge.id,
        payer,
        recipient: request.recipient,
        currency: request.currency,
        amount,
        ...(reference !== undefined && { reference }),
      },
    };
  }

  private async buildSignedTransfer(challenge: MppChargeChallenge, payer: string): Promise<string> {
    const { amount, currency, recipient } = challenge.request;
    const source = await loadAccount(payer);

    const builder = new TransactionBuilder(source, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    }).addOperation(
      new Contract(currency).call(
        'transfer',
        new Address(payer).toScVal(),
        new Address(recipient).toScVal(),
        nativeToScVal(BigInt(amount), { type: 'i128' })
      )
    );
    if (challenge.expires) {
      builder.setTimebounds(0, Math.floor(new Date(challenge.expires).getTime() / 1000));
    } else {
      builder.setTimeout(SOROBAN_TX_TIMEOUT);
    }

    const prepared = await prepareSorobanTx(builder.build());
    assertAuthorizesOnlyTransfer(prepared, {
      currency,
      from: payer,
      to: recipient,
      amount: BigInt(amount),
    });
    this.signer.signTransaction(prepared);
    return prepared.toXDR();
  }
}

/** The settlement reference (tx hash) from a `Payment-Receipt` header, if present and valid. */
function readReceiptReference(response: Response): string | undefined {
  const header = response.headers.get('payment-receipt');
  if (!header) return undefined;
  try {
    const receipt = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as {
      reference?: unknown;
    };
    return typeof receipt.reference === 'string' ? receipt.reference : undefined;
  } catch {
    return undefined;
  }
}
