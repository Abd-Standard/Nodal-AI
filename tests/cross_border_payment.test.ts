/**
 * tests/cross_border_payment.test.ts
 * SEP-31 cross-border payment tool (#784) against an in-process mock
 * Receiving Anchor serving SEP-12, SEP-31 and SEP-38 over HTTP. The live
 * SDF test anchor run is tests/e2e/cross_border_payment.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { Keypair } from '@stellar/stellar-sdk';
import {
  CrossBorderPaymentTool,
  KycFieldsSchema,
  KycValidationError,
} from '../backend/tools/CrossBorderPaymentTool';
import type { StellarTomlTool } from '../backend/tools/StellarTomlTool';
import type { StellarIdentityTool } from '../backend/tools/StellarIdentityTool';
import type { StellarPaymentTool } from '../backend/tools/StellarPaymentTool';

vi.mock('../backend/rpc_client', () => ({
  withRetry: (fn: () => unknown) => fn(),
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  horizonServer: {},
  sorobanServer: {},
  resolveNetworkPassphrase: vi.fn(() => 'Test SDF Network ; September 2015'),
}));

vi.mock('../backend/config', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Keypair } = require('@stellar/stellar-sdk'); // eslint-disable-line @typescript-eslint/no-var-requires
  const secret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
  return {
    config: {
      STELLAR_NETWORK: 'testnet',
      MAX_RETRIES: 1,
      RETRY_DELAY_MS: 1,
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      agentKeypair: () => Keypair.fromSecret(secret),
    },
  };
});

const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const ANCHOR_ACCOUNT = Keypair.random().publicKey();
const JWT = 'jwt-token';

const SENDER_KYC = {
  first_name: 'Ada',
  last_name: 'Lovelace',
  email_address: 'ada@example.com',
  address_country_code: 'GBR',
};
const RECEIVER_KYC = {
  first_name: 'Grace',
  last_name: 'Hopper',
  bank_account_number: '123456789',
  bank_number: '021000021',
};

interface AnchorState {
  requests: Array<{
    method: string;
    path: string;
    body?: Record<string, unknown> | undefined;
    auth?: string | undefined;
  }>;
  info: Record<string, unknown>;
  requiredFields: Record<string, { optional?: boolean; choices?: string[] }>;
  postTransaction: Record<string, unknown>;
  getTransaction: Array<Record<string, unknown>>;
}

function defaultState(): AnchorState {
  return {
    requests: [],
    info: {
      receive: {
        USDC: {
          quotes_supported: true,
          quotes_required: false,
          min_amount: 1,
          max_amount: 10_000,
          funding_methods: ['SWIFT'],
          sep12: {
            sender: { types: { 'sep31-sender': { description: 'sender' } } },
            receiver: { types: { 'sep31-receiver': { description: 'receiver' } } },
          },
        },
      },
    },
    requiredFields: {
      first_name: { optional: false },
      last_name: { optional: false },
      email_address: { optional: true },
    },
    postTransaction: {
      id: 'tx-1',
      stellar_account_id: ANCHOR_ACCOUNT,
      stellar_memo_type: 'id',
      stellar_memo: '4242',
    },
    getTransaction: [],
  };
}

async function startAnchor(state: AnchorState) {
  let customers = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://anchor');
      const body = raw ? JSON.parse(raw) : undefined;
      state.requests.push({
        method: req.method ?? '',
        path: url.pathname + url.search,
        body,
        auth: req.headers.authorization,
      });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (req.headers.authorization !== `Bearer ${JWT}`) return send(403, { error: 'forbidden' });

      const route = `${req.method} ${url.pathname}`;
      if (route === 'GET /sep31/info') return send(200, state.info);
      if (route === 'GET /sep12/customer') {
        return send(200, { status: 'NEEDS_INFO', fields: state.requiredFields });
      }
      if (route === 'PUT /sep12/customer') return send(202, { id: `customer-${++customers}` });
      if (route === 'POST /sep38/quote') {
        return send(201, {
          id: 'quote-1',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          price: '5.2',
          sell_amount: body.sell_amount,
          buy_amount: '520.00',
        });
      }
      if (route === 'POST /sep31/transactions') return send(201, state.postTransaction);
      if (route === 'GET /sep31/transactions/tx-1') {
        return send(200, { transaction: state.getTransaction.shift() ?? state.postTransaction });
      }
      send(404, { error: `no route ${route}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    toml: {
      DIRECT_PAYMENT_SERVER: `${base}/sep31`,
      KYC_SERVER: `${base}/sep12`,
      ANCHOR_QUOTE_SERVER: `${base}/sep38/`,
      WEB_AUTH_ENDPOINT: `${base}/auth`,
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('KycFieldsSchema (SEP-9)', () => {
  it('accepts well-formed fields', () => {
    expect(
      KycFieldsSchema.safeParse({
        ...SENDER_KYC,
        mobile_number: '+14155550123',
        birth_date: '1990-12-10',
        sex: 'female',
        ip_address: '203.0.113.7',
      }).success
    ).toBe(true);
  });

  it.each([
    [{ email_address: 'not-an-email' }, 'email_address'],
    [{ mobile_number: '4155550123' }, 'mobile_number'],
    [{ address_country_code: 'GB' }, 'address_country_code'],
    [{ birth_date: '1990-13-40' }, 'birth_date'],
    [{ birth_date: '2999-01-01' }, 'birth_date'],
    [{ bank_account_type: 'brokerage' }, 'bank_account_type'],
    [{ first_name: '   ' }, 'first_name'],
    [{ frist_name: 'Ada' }, 'unrecognized'],
    [{}, 'at least one'],
  ])('rejects %o', (fields, expected) => {
    const result = KycFieldsSchema.safeParse(fields);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error!.issues)).toContain(expected);
  });
});

describe('CrossBorderPaymentTool', () => {
  let state: AnchorState;
  let anchor: Awaited<ReturnType<typeof startAnchor>>;
  let pay: ReturnType<typeof vi.fn>;
  let identity: { execute: ReturnType<typeof vi.fn> };
  let tool: CrossBorderPaymentTool;

  const baseInput = {
    anchorDomain: 'anchor.example.com',
    amount: '100',
    assetCode: 'USDC',
    assetIssuer: ISSUER,
    sender: { kyc: SENDER_KYC },
    receiver: { kyc: RECEIVER_KYC },
    jwt: JWT,
  };

  beforeEach(async () => {
    state = defaultState();
    anchor = await startAnchor(state);
    pay = vi.fn().mockResolvedValue({ txHash: 'stellar-tx', ledger: 77 });
    identity = { execute: vi.fn().mockResolvedValue({ token: JWT }) };
    tool = new CrossBorderPaymentTool(undefined, {
      tomlTool: { fetchToml: vi.fn().mockResolvedValue(anchor.toml) } as unknown as StellarTomlTool,
      identityTool: identity as unknown as StellarIdentityTool,
      paymentTool: { execute: pay } as unknown as StellarPaymentTool,
      pollIntervalMs: 1,
    });
  });

  afterEach(async () => {
    await anchor.close();
  });

  const routes = () => state.requests.map((r) => `${r.method} ${r.path.split('?')[0]}`);

  it('runs KYC, creates the SEP-31 transaction and pays with the anchor memo', async () => {
    const result = await tool.execute(baseInput);

    expect(routes()).toEqual([
      'GET /sep31/info',
      'GET /sep12/customer',
      'PUT /sep12/customer',
      'GET /sep12/customer',
      'PUT /sep12/customer',
      'POST /sep31/transactions',
    ]);
    // KYC submitted per party with its SEP-12 type and a distinct memo
    const puts = state.requests.filter((r) => r.method === 'PUT');
    expect(puts[0]!.body).toMatchObject({ type: 'sep31-sender', memo_type: 'id', ...SENDER_KYC });
    expect(puts[1]!.body).toMatchObject({ type: 'sep31-receiver', ...RECEIVER_KYC });
    expect(puts[0]!.body!.memo).not.toBe(puts[1]!.body!.memo);

    const created = state.requests.find((r) => r.path === '/sep31/transactions')!;
    expect(created.body).toEqual({
      amount: '100',
      asset_code: 'USDC',
      asset_issuer: ISSUER,
      sender_id: 'customer-1',
      receiver_id: 'customer-2',
      funding_method: 'SWIFT',
    });

    expect(pay).toHaveBeenCalledWith({
      destination: ANCHOR_ACCOUNT,
      amount: '100',
      assetCode: 'USDC',
      assetIssuer: ISSUER,
      memoType: 'id',
      memo: 4242,
    });
    expect(result).toEqual({
      transactionId: 'tx-1',
      senderId: 'customer-1',
      receiverId: 'customer-2',
      stellarAccountId: ANCHOR_ACCOUNT,
      memoType: 'id',
      memo: '4242',
      txHash: 'stellar-tx',
      ledger: 77,
    });
    expect(identity.execute).not.toHaveBeenCalled();
  });

  it('requests a SEP-38 firm quote and attaches it to the transaction', async () => {
    const result = await tool.execute({ ...baseInput, destinationAsset: 'iso4217:BRL' });

    const quoteReq = state.requests.find((r) => r.path === '/sep38/quote')!;
    expect(quoteReq.body).toEqual({
      sell_asset: `stellar:USDC:${ISSUER}`,
      buy_asset: 'iso4217:BRL',
      sell_amount: '100',
      context: 'sep31',
    });
    const created = state.requests.find((r) => r.path === '/sep31/transactions')!;
    expect(created.body).toMatchObject({ quote_id: 'quote-1', destination_asset: 'iso4217:BRL' });
    expect(result.quote).toMatchObject({ id: 'quote-1', buyAmount: '520.00' });
  });

  it('reuses existing customer ids without KYC calls', async () => {
    await tool.execute({
      ...baseInput,
      sender: { customerId: 's-9' },
      receiver: { customerId: 'r-9' },
    });
    expect(routes()).not.toContain('PUT /sep12/customer');
    const created = state.requests.find((r) => r.path === '/sep31/transactions')!;
    expect(created.body).toMatchObject({ sender_id: 's-9', receiver_id: 'r-9' });
  });

  it('rejects KYC missing fields the anchor requires, before submitting any', async () => {
    state.requiredFields = { ...state.requiredFields, birth_date: { optional: false } };

    const err = await tool.execute(baseInput).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(KycValidationError);
    expect((err as KycValidationError).party).toBe('sender');
    expect((err as KycValidationError).missingFields).toEqual(['birth_date']);
    expect(routes()).not.toContain('PUT /sep12/customer');
    expect(pay).not.toHaveBeenCalled();
  });

  it('rejects a KYC value outside the anchor choices', async () => {
    state.requiredFields = { address_country_code: { optional: false, choices: ['USA', 'CAN'] } };
    await expect(tool.execute(baseInput)).rejects.toThrow(
      /not an accepted value: address_country_code/
    );
  });

  it('polls GET /transactions/:id until the anchor provides payment details', async () => {
    state.postTransaction = { id: 'tx-1' };
    state.getTransaction = [
      { id: 'tx-1', status: 'pending_receiver' },
      {
        id: 'tx-1',
        status: 'pending_sender',
        stellar_account_id: ANCHOR_ACCOUNT,
        stellar_memo_type: 'hash',
        stellar_memo: Buffer.alloc(32, 1).toString('base64'),
      },
    ];

    await tool.execute(baseInput);

    expect(routes().filter((r) => r === 'GET /sep31/transactions/tx-1')).toHaveLength(2);
    expect(pay).toHaveBeenCalledWith(
      expect.objectContaining({ memoType: 'hash', memo: '01'.repeat(32) })
    );
  });

  it('does not pay a transaction the anchor has ended', async () => {
    state.postTransaction = { id: 'tx-1' };
    state.getTransaction = [{ id: 'tx-1', status: 'error' }];
    await expect(tool.execute(baseInput)).rejects.toThrow(/ended as error/);
    expect(pay).not.toHaveBeenCalled();
  });

  it.each([
    ['an unsupported asset', { assetCode: 'EURC' }, /does not receive EURC/],
    ['an amount below the minimum', { amount: '0.5' }, /below the anchor minimum/],
    [
      'a funding method the anchor does not offer',
      { fundingMethod: 'ACH' },
      /funding method "ACH"/,
    ],
  ])('rejects %s before any KYC', async (_label, override, error) => {
    await expect(tool.execute({ ...baseInput, ...override })).rejects.toThrow(error);
    expect(routes()).toEqual(['GET /sep31/info']);
  });

  it('requires destinationAsset when the anchor requires quotes', async () => {
    (state.info.receive as any).USDC.quotes_required = true;
    await expect(tool.execute(baseInput)).rejects.toThrow(/requires a quote/);
  });

  it('rejects a memo id that cannot be represented exactly', async () => {
    state.postTransaction = { ...state.postTransaction, stellar_memo: '18446744073709551615' };
    await expect(tool.execute(baseInput)).rejects.toThrow(/cannot be represented exactly/);
    expect(pay).not.toHaveBeenCalled();
  });

  it('authenticates with SEP-10 when no JWT is given', async () => {
    const { jwt: _jwt, ...withoutJwt } = baseInput;
    await tool.execute(withoutJwt);
    expect(identity.execute).toHaveBeenCalledWith({
      anchorUrl: anchor.toml.WEB_AUTH_ENDPOINT.replace(/\/auth$/, ''),
    });
  });

  it('rejects sender input with both customerId and kyc', async () => {
    await expect(
      tool.execute({ ...baseInput, sender: { customerId: 'x', kyc: SENDER_KYC } })
    ).rejects.toThrow(/exactly one of customerId or kyc/);
  });
});
