/**
 * tests/dex_offer.test.ts
 * Tests for DexOfferTool: create, update, delete, and input validation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, xdr, Asset } from '@stellar/stellar-sdk';
import { DexOfferTool, DexOfferInputSchema } from '../backend/tools/DexOfferTool';
import { ValidationError } from '../backend/errors';
import * as rpcClient from '../backend/rpc_client';
import { NotFoundError } from '@stellar/stellar-sdk';

const { mockOfferCall } = vi.hoisted(() => ({
  mockOfferCall: vi.fn(),
}));

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../backend/rpc_client', () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  horizonServer: {
    offers: () => ({
      offer: () => ({
        call: mockOfferCall,
      }),
    }),
  },
  sorobanServer: {},
  simulateSorobanTx: vi.fn(),
  prepareSorobanTx: vi.fn(),
  resolveNetworkPassphrase: (network: string) =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@stellar/stellar-sdk').Networks[
      network === 'mainnet' ? 'PUBLIC' : network === 'futurenet' ? 'FUTURENET' : 'TESTNET'
    ],
}));

vi.mock('../backend/config', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Keypair } = require('@stellar/stellar-sdk');
  const secret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
  return {
    config: {
      STELLAR_NETWORK: 'testnet',
      HORIZON_URL: 'https://horizon-testnet.stellar.org',
      SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      X402_ASSET_CODE: 'USDC',
      X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      AGENT_SPENDING_LIMIT: '1000',
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      agentKeypair: () => Keypair.fromSecret(secret),
    },
  };
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_SECRET = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

function makeMockAccount(publicKey: string) {
  return {
    id: publicKey,
    accountId: () => publicKey,
    sequenceNumber: () => '100',
    incrementSequenceNumber: vi.fn(),
    sequence: '100',
    incrementedSequenceNumber: () => '101',
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
    balances: [],
    signers: [],
    data_attr: {},
    subentry_count: 0,
    home_domain: '',
    inflation_dest: null,
  };
}

/**
 * Create a mock transaction result XDR with a manageSellOffer result containing the given offer ID.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeMockTxResultXdr(offerId: string): string {
  const kp = Keypair.fromSecret(TEST_SECRET);
  const issuerKp = Keypair.random();
  const issuer = issuerKp.publicKey();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const OfferEntryExtCtor = (xdr as any).OfferEntryExt;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const TransactionResultExtCtor = (xdr as any).TransactionResultExt;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Int64Ctor = (xdr as any).Int64;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const OfferEntryCtor = (xdr as any).OfferEntry;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const TransactionResultCtor = (xdr as any).TransactionResult;

  const offer = new OfferEntryCtor({
    sellerId: kp.xdrAccountId(),
    offerId: BigInt(offerId),
    selling: Asset.native().toXDRObject(),
    buying: new Asset('USDC', issuer).toXDRObject(),
    amount: BigInt(1000000000),
    price: new xdr.Price({ n: 1, d: 1 }),
    flags: 0,
    ext: new OfferEntryExtCtor(0),
  });

  const offerUnion = xdr.ManageOfferSuccessResultOffer.manageOfferCreated(offer);
  const successResult = new xdr.ManageOfferSuccessResult({
    offersClaimed: [],
    offer: offerUnion,
  });

  const msor = xdr.ManageSellOfferResult.manageSellOfferSuccess(successResult);
  const tr = xdr.OperationResultTr.manageSellOffer(msor);
  const opResult = xdr.OperationResult.opInner(tr);
  const txResultResult = xdr.TransactionResultResult.txSuccess([opResult]);
  const txResult = new TransactionResultCtor({
    feeCharged: new Int64Ctor(BigInt(100)),
    result: txResultResult,
    ext: new TransactionResultExtCtor(0),
  });

  return txResult.toXDR('base64');
}

const BASE_OFFER = {
  selling: { code: 'XLM' },
  buying: { code: 'USDC', issuer: USDC_ISSUER },
  amount: '100',
  price: '0.25',
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('DexOfferTool', () => {
  let tool: DexOfferTool;

  beforeEach(() => {
    vi.clearAllMocks();
    mockOfferCall.mockReset();
    mockOfferCall.mockResolvedValue({ id: '42' });
    tool = new DexOfferTool(TEST_SECRET);
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount(tool.publicKey) as any);
    vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
      hash: 'offer_tx_hash',
      ledger: 10,
    } as any);
  });

  // ── Create offer ────────────────────────────────────────────────────────────

  it('creates an offer and returns txHash + ledger', async () => {
    const result = await tool.execute({ action: 'create', ...BASE_OFFER });

    expect(result.txHash).toBe('offer_tx_hash');
    expect(result.ledger).toBe(10);
    expect(rpcClient.submitTransaction).toHaveBeenCalledOnce();
  });

  it('returns offerId from transaction result metadata for create action', async () => {
    const networkAssignedOfferId = '12345678';
    vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
      hash: 'offer_tx_hash',
      ledger: 10,
      result_xdr: makeMockTxResultXdr(networkAssignedOfferId),
    } as any);

    const result = await tool.execute({ action: 'create', ...BASE_OFFER });

    expect(result.txHash).toBe('offer_tx_hash');
    expect(result.ledger).toBe(10);
    expect(result.offerId).toBe(networkAssignedOfferId);
  });

  // ── Delete offer ────────────────────────────────────────────────────────────

  it('deletes an offer by submitting amount=0 with the offerId', async () => {
    const result = await tool.execute({
      action: 'delete',
      ...BASE_OFFER,
      offerId: '42',
    });

    expect(result.txHash).toBe('offer_tx_hash');
    expect(result.offerId).toBe('42');
    // Verify submitTransaction was called (amount=0 is set internally for delete)
    expect(rpcClient.submitTransaction).toHaveBeenCalledOnce();
  });

  // ── Update offer amount ─────────────────────────────────────────────────────

  it('throws ValidationError when updating a non-existent offer', async () => {
    mockOfferCall.mockRejectedValueOnce(new NotFoundError('Offer not found', {}));

    const promise = tool.execute({
      action: 'update',
      ...BASE_OFFER,
      offerId: '999',
    });

    await expect(promise).rejects.toThrow('Offer 999 not found on Stellar network');
    expect(rpcClient.submitTransaction).not.toHaveBeenCalled();
  });

  it('throws ValidationError when deleting a non-existent offer', async () => {
    mockOfferCall.mockRejectedValueOnce(new NotFoundError('Offer not found', {}));

    await expect(
      tool.execute({
        action: 'delete',
        ...BASE_OFFER,
        offerId: '404',
      })
    ).rejects.toThrow(ValidationError);

    expect(rpcClient.submitTransaction).not.toHaveBeenCalled();
  });

  it('does not verify offer existence for create action', async () => {
    await tool.execute({ action: 'create', ...BASE_OFFER });

    expect(mockOfferCall).not.toHaveBeenCalled();
    expect(rpcClient.submitTransaction).toHaveBeenCalledOnce();
  });

  it('updates an existing offer amount', async () => {
    vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
      hash: 'update_tx_hash',
      ledger: 20,
    } as any);

    const result = await tool.execute({
      action: 'update',
      ...BASE_OFFER,
      amount: '200',
      offerId: '99',
    });

    expect(result.txHash).toBe('update_tx_hash');
    expect(result.offerId).toBe('99');
  });

  // ── Input validation ────────────────────────────────────────────────────────

  it('rejects update action without offerId', async () => {
    await expect(tool.execute({ action: 'update', ...BASE_OFFER })).rejects.toThrow(
      /offerId is required/
    );
  });

  it('rejects delete action without offerId', async () => {
    await expect(tool.execute({ action: 'delete', ...BASE_OFFER })).rejects.toThrow(
      /offerId is required/
    );
  });

  it('rejects invalid amount (zero)', async () => {
    await expect(tool.execute({ action: 'create', ...BASE_OFFER, amount: '0' })).rejects.toThrow(
      /Amount must be/
    );
  });

  it('rejects invalid price format', async () => {
    await expect(tool.execute({ action: 'create', ...BASE_OFFER, price: 'abc' })).rejects.toThrow(
      /Price must be/
    );
  });

  it('rejects unknown action', async () => {
    await expect(tool.execute({ action: 'buy', ...BASE_OFFER })).rejects.toThrow();
  });

  it('propagates network errors from submitTransaction', async () => {
    vi.mocked(rpcClient.submitTransaction).mockRejectedValueOnce(new Error('Network Error'));
    await expect(tool.execute({ action: 'create', ...BASE_OFFER })).rejects.toThrow(
      'Network Error'
    );
  });
});

// ─── Schema unit tests ────────────────────────────────────────────────────────

describe('DexOfferInputSchema', () => {
  it('parses a valid create payload', () => {
    const result = DexOfferInputSchema.parse({
      action: 'create',
      selling: { code: 'XLM' },
      buying: { code: 'USDC', issuer: USDC_ISSUER },
      amount: '50',
      price: '0.5',
    });
    expect(result.action).toBe('create');
  });

  it('parses a valid delete payload with offerId as number', () => {
    const result = DexOfferInputSchema.parse({
      action: 'delete',
      selling: { code: 'XLM' },
      buying: { code: 'USDC', issuer: USDC_ISSUER },
      amount: '1',
      price: '0.1',
      offerId: 7,
    });
    expect(result.offerId).toBe(7);
  });
});
