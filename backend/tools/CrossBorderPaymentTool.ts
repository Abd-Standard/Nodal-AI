/**
 * backend/tools/CrossBorderPaymentTool.ts
 * SEP-31 cross-border payment as the Sending Anchor (Issue #784).
 *
 * Flow against the Receiving Anchor named by `anchorDomain`:
 *   1. SEP-1   read its stellar.toml (DIRECT_PAYMENT_SERVER, KYC_SERVER, …).
 *   2. SEP-10  authenticate the agent (unless a JWT is supplied).
 *   3. SEP-31  GET /info — check the asset, amount limits, quote and funding rules.
 *   4. SEP-12  register sender and receiver: the KYC fields are format-validated
 *              locally (SEP-9) and checked against what the anchor requires
 *              before anything is sent; an existing customer id skips this.
 *   5. SEP-38  request a firm quote when `destinationAsset` is set.
 *   6. SEP-31  POST /transactions, then read the anchor's Stellar account and
 *              memo (polling GET /transactions/:id until `pending_sender`).
 *   7. Pay the anchor on-chain with the anchor-provided memo.
 *
 * Writes (PUT /customer, POST /quote, POST /transactions) are never retried:
 * a retried POST /transactions could create a second transaction.
 */

import { randomBytes } from 'crypto';
import { StrKey } from '@stellar/stellar-sdk';
import { z } from 'zod';
import { config } from '../config';
import { ValidationError } from '../errors';
import { withBackoffGuard } from '../network';
import { withRetry } from '../rpc_client';
import { createAgentSigner, Signer } from '../signer';
import { createLogger } from '../utils/logger';
import { stellarPublicKeySchema } from '../utils/stellarSchemas';
import { StellarIdentityTool } from './StellarIdentityTool';
import { StellarPaymentTool } from './StellarPaymentTool';
import { StellarTomlTool } from './StellarTomlTool';

const log = createLogger('cross-border-payment');

// ─── KYC fields (SEP-9) ──────────────────────────────────────────────────────

const iso3Country = z
  .string()
  .regex(/^[A-Z]{3}$/, 'must be an ISO 3166-1 alpha-3 country code (e.g. "USA")');

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date in YYYY-MM-DD format')
  .refine((v) => !isNaN(Date.parse(`${v}T00:00:00Z`)), 'must be a valid calendar date');

const e164Phone = z
  .string()
  .regex(/^\+[1-9]\d{6,14}$/, 'must be an E.164 phone number (e.g. "+14155550123")');

const text = z.string().trim().min(1, 'must not be empty');

/**
 * SEP-9 natural-person and financial-account fields this tool can submit.
 * Every field is optional here — which ones are required is decided by the
 * anchor's SEP-12 `GET /customer` response — but each is format-checked, and
 * an unknown (e.g. misspelled) field is rejected rather than silently sent.
 */
export const KycFieldsSchema = z
  .object({
    first_name: text,
    last_name: text,
    additional_name: text,
    address_country_code: iso3Country,
    state_or_province: text,
    city: text,
    postal_code: text,
    address: text,
    mobile_number: e164Phone,
    email_address: z.string().email('must be a valid email address'),
    birth_date: isoDate.refine(
      (v) => Date.parse(`${v}T00:00:00Z`) < Date.now(),
      'must be in the past'
    ),
    birth_place: text,
    birth_country_code: iso3Country,
    bank_name: text,
    bank_account_type: z.enum(['checking', 'savings']),
    bank_account_number: text,
    bank_number: text,
    bank_phone_number: e164Phone,
    bank_branch_number: text,
    clabe_number: z.string().regex(/^\d{18}$/, 'must be an 18-digit CLABE'),
    cbu_number: z.string().regex(/^\d{22}$/, 'must be a 22-digit CBU'),
    cbu_alias: text,
    tax_id: text,
    tax_id_name: text,
    occupation: text,
    employer_name: text,
    employer_address: text,
    language_code: z.string().regex(/^[a-z]{2}$/, 'must be an ISO 639-1 language code'),
    id_type: text,
    id_country_code: iso3Country,
    id_issue_date: isoDate,
    id_expiration_date: isoDate,
    id_number: text,
    ip_address: z.string().ip('must be a valid IP address'),
    sex: z.enum(['male', 'female', 'other']),
    referral_id: text,
  })
  .partial()
  .strict()
  .refine((fields) => Object.keys(fields).length > 0, 'at least one KYC field is required');

export type KycFields = z.infer<typeof KycFieldsSchema>;

/** A SEP-31 party: an existing SEP-12 customer id, or KYC fields to register. */
const PartySchema = z
  .object({
    /** Existing SEP-12 customer id; skips KYC submission. */
    customerId: z.string().min(1).optional(),
    /** SEP-12 customer type (e.g. "sep31-sender"); defaults to the anchor's only type. */
    type: z.string().min(1).optional(),
    kyc: KycFieldsSchema.optional(),
  })
  .refine((p) => (p.customerId === undefined) !== (p.kyc === undefined), {
    message: 'provide exactly one of customerId or kyc',
  });

export const CrossBorderPaymentInputSchema = z.object({
  /** Home domain of the Receiving Anchor, e.g. "anchor.example.com". */
  anchorDomain: z.string().min(1),
  amount: z
    .string()
    .regex(/^(?!0(\.0+)?$)\d+(\.\d{1,7})?$/, 'Amount must be a valid Stellar decimal'),
  assetCode: z.string().min(1).max(12),
  assetIssuer: stellarPublicKeySchema('Asset issuer'),
  sender: PartySchema,
  receiver: PartySchema,
  /** SEP-38 asset the receiver gets (e.g. "iso4217:BRL"); requests a firm quote. */
  destinationAsset: z.string().min(1).optional(),
  /** SEP-31 funding method (delivery rail); defaults to the anchor's only method. */
  fundingMethod: z.string().min(1).optional(),
  /** SEP-10 JWT for the anchor; obtained automatically when omitted. */
  jwt: z.string().min(1).optional(),
});

export type CrossBorderPaymentInput = z.infer<typeof CrossBorderPaymentInputSchema>;

/** KYC fields are missing, or not among the values the anchor accepts. */
export class KycValidationError extends ValidationError {
  readonly party: 'sender' | 'receiver';
  readonly missingFields: string[];
  readonly invalidFields: string[];

  constructor(party: 'sender' | 'receiver', missingFields: string[], invalidFields: string[]) {
    const parts = [
      missingFields.length > 0 ? `missing ${missingFields.join(', ')}` : '',
      invalidFields.length > 0 ? `not an accepted value: ${invalidFields.join(', ')}` : '',
    ].filter(Boolean);
    super(`SEP-12 ${party} KYC rejected before submission: ${parts.join('; ')}`);
    this.party = party;
    this.missingFields = missingFields;
    this.invalidFields = invalidFields;
    Object.setPrototypeOf(this, KycValidationError.prototype);
  }
}

// ─── Anchor responses ────────────────────────────────────────────────────────

const Sep12TypesSchema = z.object({ types: z.record(z.unknown()).optional() }).optional();

const Sep31InfoSchema = z.object({
  receive: z.record(
    z
      .object({
        quotes_supported: z.boolean().optional(),
        quotes_required: z.boolean().optional(),
        min_amount: z.number().optional(),
        max_amount: z.number().optional(),
        funding_methods: z.array(z.string()).optional(),
        sep12: z.object({ sender: Sep12TypesSchema, receiver: Sep12TypesSchema }).optional(),
      })
      .passthrough()
  ),
});

const Sep12CustomerSchema = z
  .object({
    id: z.string().optional(),
    status: z.string(),
    fields: z
      .record(
        z
          .object({
            optional: z.boolean().optional(),
            choices: z.array(z.string()).optional(),
          })
          .passthrough()
      )
      .optional(),
  })
  .passthrough();

const Sep12PutResponseSchema = z.object({ id: z.string().min(1) });

const Sep38QuoteSchema = z
  .object({
    id: z.string().min(1),
    expires_at: z.string(),
    price: z.string(),
    sell_amount: z.string(),
    buy_amount: z.string(),
  })
  .passthrough();

const Sep31TransactionFields = {
  id: z.string().min(1),
  status: z.string().optional(),
  stellar_account_id: z.string().optional(),
  stellar_memo_type: z.enum(['text', 'id', 'hash']).optional(),
  stellar_memo: z.string().optional(),
};
const Sep31PostResponseSchema = z.object(Sep31TransactionFields).passthrough();
const Sep31GetResponseSchema = z.object({
  transaction: z.object(Sep31TransactionFields).passthrough(),
});

type Sep31Transaction = z.infer<typeof Sep31PostResponseSchema>;

/** Statuses after which the anchor will never ask for this payment. */
const SEP31_TERMINAL_STATUSES = new Set(['completed', 'refunded', 'expired', 'error']);

export interface CrossBorderPaymentResult {
  /** SEP-31 transaction id at the Receiving Anchor. */
  transactionId: string;
  senderId: string;
  receiverId: string;
  stellarAccountId: string;
  memoType: 'text' | 'id' | 'hash';
  memo: string;
  txHash: string;
  ledger: number;
  quote?: { id: string; price: string; sellAmount: string; buyAmount: string; expiresAt: string };
}

/** Convert the anchor's memo into the form StellarPaymentTool takes. */
function toPaymentMemo(
  type: 'text' | 'id' | 'hash',
  memo: string
): { memoType: 'text' | 'id' | 'hash'; memo: string | number } {
  if (type === 'text') return { memoType: 'text', memo };
  if (type === 'id') {
    const id = Number(memo);
    // A memo id that does not survive the round trip through a JS number would
    // be sent wrong, and the anchor could not match the payment.
    if (!/^\d+$/.test(memo) || !Number.isSafeInteger(id)) {
      throw new ValidationError(`Anchor memo id ${memo} cannot be represented exactly`);
    }
    return { memoType: 'id', memo: id };
  }
  // SEP-31 hash memos are base64; accept hex as well.
  const hex = /^[0-9a-f]{64}$/i.test(memo) ? memo : Buffer.from(memo, 'base64').toString('hex');
  if (hex.length !== 64) {
    throw new ValidationError('Anchor hash memo is not 32 bytes');
  }
  return { memoType: 'hash', memo: hex };
}

/** The single entry of `values`, or `chosen` if it is one of them. */
function pickOption(
  label: string,
  chosen: string | undefined,
  values: string[] | undefined
): string | undefined {
  if (!values || values.length === 0) return chosen;
  if (chosen !== undefined) {
    if (!values.includes(chosen)) {
      throw new ValidationError(`${label} "${chosen}" is not offered (${values.join(', ')})`);
    }
    return chosen;
  }
  if (values.length === 1) return values[0];
  throw new ValidationError(`Anchor offers several ${label}s (${values.join(', ')}); choose one`);
}

export interface CrossBorderPaymentDeps {
  tomlTool?: StellarTomlTool;
  identityTool?: StellarIdentityTool;
  paymentTool?: StellarPaymentTool;
  /** Delay between GET /transactions/:id polls. */
  pollIntervalMs?: number;
}

/** Polls of GET /transactions/:id while waiting for the anchor's payment details. */
const MAX_TRANSACTION_POLLS = 10;

export class CrossBorderPaymentTool {
  private tomlTool: StellarTomlTool;
  private identityTool: StellarIdentityTool;
  private paymentTool: StellarPaymentTool;
  private pollIntervalMs: number;

  constructor(signer: Signer = createAgentSigner(), deps: CrossBorderPaymentDeps = {}) {
    this.tomlTool = deps.tomlTool ?? new StellarTomlTool();
    this.identityTool = deps.identityTool ?? new StellarIdentityTool(signer, this.tomlTool);
    this.paymentTool = deps.paymentTool ?? new StellarPaymentTool(signer);
    this.pollIntervalMs = deps.pollIntervalMs ?? 1_000;
  }

  async execute(rawInput: unknown): Promise<CrossBorderPaymentResult> {
    const input = CrossBorderPaymentInputSchema.parse(rawInput);

    // 1. SEP-1
    const toml = await this.tomlTool.fetchToml({ domain: input.anchorDomain });
    const trim = (url: string | undefined) => url?.replace(/\/+$/, '');
    const directPaymentServer = trim(toml.DIRECT_PAYMENT_SERVER);
    // SEP-12 falls back to TRANSFER_SERVER when KYC_SERVER is not set.
    const kycServer = trim(toml.KYC_SERVER ?? toml.TRANSFER_SERVER);
    const quoteServer = trim(toml.ANCHOR_QUOTE_SERVER);
    if (!directPaymentServer) {
      throw new ValidationError(
        `${input.anchorDomain} does not support SEP-31 (no DIRECT_PAYMENT_SERVER)`
      );
    }

    // 2. SEP-10
    const jwt = input.jwt ?? (await this.authenticate(input.anchorDomain, toml.WEB_AUTH_ENDPOINT));

    // 3. SEP-31 /info
    const info = await this.request(Sep31InfoSchema, 'GET', `${directPaymentServer}/info`, jwt);
    const asset = info.receive[input.assetCode];
    if (!asset) {
      throw new ValidationError(
        `${input.anchorDomain} does not receive ${input.assetCode} via SEP-31`
      );
    }
    const amount = parseFloat(input.amount);
    if (asset.min_amount !== undefined && amount < asset.min_amount) {
      throw new ValidationError(
        `Amount ${input.amount} is below the anchor minimum of ${asset.min_amount}`
      );
    }
    if (asset.max_amount !== undefined && amount > asset.max_amount) {
      throw new ValidationError(
        `Amount ${input.amount} is above the anchor maximum of ${asset.max_amount}`
      );
    }
    if (asset.quotes_required && !input.destinationAsset) {
      throw new ValidationError(`${input.anchorDomain} requires a quote; set destinationAsset`);
    }
    if (input.destinationAsset && asset.quotes_supported === false) {
      throw new ValidationError(
        `${input.anchorDomain} does not support quotes for ${input.assetCode}`
      );
    }
    const fundingMethod = pickOption('funding method', input.fundingMethod, asset.funding_methods);

    // 4. SEP-12
    if ((input.sender.kyc || input.receiver.kyc) && !kycServer) {
      throw new ValidationError(`${input.anchorDomain} has no KYC_SERVER for SEP-12`);
    }
    const senderId = await this.registerCustomer(
      'sender',
      input.sender,
      Object.keys(asset.sep12?.sender?.types ?? {}),
      kycServer,
      jwt
    );
    const receiverId = await this.registerCustomer(
      'receiver',
      input.receiver,
      Object.keys(asset.sep12?.receiver?.types ?? {}),
      kycServer,
      jwt
    );

    // 5. SEP-38
    let quote: z.infer<typeof Sep38QuoteSchema> | undefined;
    if (input.destinationAsset) {
      if (!quoteServer) {
        throw new ValidationError(`${input.anchorDomain} has no ANCHOR_QUOTE_SERVER for SEP-38`);
      }
      quote = await this.request(Sep38QuoteSchema, 'POST', `${quoteServer}/quote`, jwt, {
        sell_asset: `stellar:${input.assetCode}:${input.assetIssuer}`,
        buy_asset: input.destinationAsset,
        sell_amount: input.amount,
        context: 'sep31',
      });
      if (parseFloat(quote.sell_amount) !== amount) {
        throw new ValidationError(
          `Quote sells ${quote.sell_amount}, not the requested ${input.amount}`
        );
      }
      if (Date.parse(quote.expires_at) <= Date.now()) {
        throw new ValidationError(`Quote ${quote.id} expired at ${quote.expires_at}`);
      }
    }

    // 6. SEP-31 transaction
    const created = await this.request(
      Sep31PostResponseSchema,
      'POST',
      `${directPaymentServer}/transactions`,
      jwt,
      {
        amount: input.amount,
        asset_code: input.assetCode,
        asset_issuer: input.assetIssuer,
        sender_id: senderId,
        receiver_id: receiverId,
        ...(fundingMethod !== undefined && { funding_method: fundingMethod }),
        ...(quote && { quote_id: quote.id, destination_asset: input.destinationAsset }),
      }
    );
    const tx = await this.awaitPaymentDetails(directPaymentServer, created, jwt);
    const stellarAccountId = tx.stellar_account_id!;
    const memoType = tx.stellar_memo_type!;
    const memo = tx.stellar_memo!;
    if (!StrKey.isValidEd25519PublicKey(stellarAccountId)) {
      throw new ValidationError(
        `Anchor returned an invalid stellar_account_id: ${stellarAccountId}`
      );
    }

    // 7. On-chain payment with the anchor's memo
    log.info(
      {
        anchorDomain: input.anchorDomain,
        transactionId: tx.id,
        stellarAccountId,
        amount: input.amount,
      },
      'Paying SEP-31 transaction'
    );
    const payment = await this.paymentTool.execute({
      destination: stellarAccountId,
      amount: input.amount,
      assetCode: input.assetCode,
      assetIssuer: input.assetIssuer,
      ...toPaymentMemo(memoType, memo),
    });

    return {
      transactionId: tx.id,
      senderId,
      receiverId,
      stellarAccountId,
      memoType,
      memo,
      txHash: payment.txHash,
      ledger: payment.ledger,
      ...(quote && {
        quote: {
          id: quote.id,
          price: quote.price,
          sellAmount: quote.sell_amount,
          buyAmount: quote.buy_amount,
          expiresAt: quote.expires_at,
        },
      }),
    };
  }

  /** SEP-10 against the anchor's WEB_AUTH_ENDPOINT. */
  private async authenticate(
    anchorDomain: string,
    webAuthEndpoint: string | undefined
  ): Promise<string> {
    // StellarIdentityTool's SEP-10 flow appends `/auth` to the URL it is given.
    if (!webAuthEndpoint || !/\/auth\/?$/.test(webAuthEndpoint)) {
      throw new ValidationError(
        `Cannot authenticate with ${anchorDomain}: WEB_AUTH_ENDPOINT must end in /auth; pass jwt instead`
      );
    }
    const { token } = await this.identityTool.execute({
      anchorUrl: webAuthEndpoint.replace(/\/auth\/?$/, ''),
    });
    return token;
  }

  /** The SEP-12 id for a party: the one given, or a newly registered customer. */
  private async registerCustomer(
    party: 'sender' | 'receiver',
    spec: z.infer<typeof PartySchema>,
    anchorTypes: string[],
    kycServer: string | undefined,
    jwt: string
  ): Promise<string> {
    if (spec.customerId) return spec.customerId;
    const fields = spec.kyc!;
    const type = pickOption(`${party} KYC type`, spec.type, anchorTypes);

    // Customers registered by the same account are told apart by memo.
    const memo = BigInt(`0x${randomBytes(8).toString('hex')}`).toString();
    const query = new URLSearchParams({ memo, memo_type: 'id', ...(type && { type }) });

    const requirements = await this.request(
      Sep12CustomerSchema,
      'GET',
      `${kycServer}/customer?${query}`,
      jwt
    );
    const provided = fields as Record<string, string | undefined>;
    const missing: string[] = [];
    const invalid: string[] = [];
    for (const [name, field] of Object.entries(requirements.fields ?? {})) {
      const value = provided[name];
      if (value === undefined) {
        if (field.optional !== true) missing.push(name);
      } else if (field.choices && field.choices.length > 0 && !field.choices.includes(value)) {
        invalid.push(name);
      }
    }
    if (missing.length > 0 || invalid.length > 0) {
      throw new KycValidationError(party, missing, invalid);
    }

    const { id } = await this.request(Sep12PutResponseSchema, 'PUT', `${kycServer}/customer`, jwt, {
      memo,
      memo_type: 'id',
      ...(type && { type }),
      ...fields,
    });
    return id;
  }

  /** The transaction once the anchor has given its Stellar account and memo. */
  private async awaitPaymentDetails(
    server: string,
    created: Sep31Transaction,
    jwt: string
  ): Promise<Sep31Transaction> {
    const ready = (t: Sep31Transaction) =>
      !!t.stellar_account_id && !!t.stellar_memo_type && t.stellar_memo !== undefined;
    let tx = created;
    for (let poll = 0; !ready(tx); poll++) {
      if (tx.status && SEP31_TERMINAL_STATUSES.has(tx.status)) {
        throw new ValidationError(
          `SEP-31 transaction ${tx.id} ended as ${tx.status} before payment`
        );
      }
      if (poll >= MAX_TRANSACTION_POLLS) {
        throw new ValidationError(
          `SEP-31 transaction ${tx.id} has no payment details yet (status ${tx.status ?? 'unknown'})`
        );
      }
      if (poll > 0) await new Promise((r) => setTimeout(r, this.pollIntervalMs));
      ({ transaction: tx } = await this.request(
        Sep31GetResponseSchema,
        'GET',
        `${server}/transactions/${encodeURIComponent(created.id)}`,
        jwt
      ));
    }
    if (tx.status && tx.status !== 'pending_sender') {
      throw new ValidationError(`SEP-31 transaction ${tx.id} is ${tx.status}, not pending_sender`);
    }
    return tx;
  }

  /** Authenticated JSON request. Only GETs are retried. */
  private async request<T>(
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    method: 'GET' | 'POST' | 'PUT',
    url: string,
    jwt: string,
    body?: Record<string, unknown>
  ): Promise<T> {
    const send = () =>
      fetch(url, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${jwt}`,
          ...(body && { 'Content-Type': 'application/json' }),
        },
        ...(body && { body: JSON.stringify(body) }),
      });
    const response = await withBackoffGuard(() =>
      method === 'GET' ? withRetry(send, config.MAX_RETRIES, config.RETRY_DELAY_MS) : send()
    );
    if (!response.ok) {
      let detail = '';
      try {
        const err = (await response.json()) as { error?: unknown };
        if (typeof err.error === 'string') detail = `: ${err.error}`;
      } catch {
        // non-JSON error body
      }
      throw new Error(`${method} ${url} failed: HTTP ${response.status}${detail}`);
    }
    return schema.parse(await response.json());
  }
}
