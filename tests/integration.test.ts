import { describe, it, expect, vi } from 'vitest';
import { PayFiAgent } from '../backend/agent';

vi.mock('../backend/rpc_client', () => ({
  loadAccount: vi.fn().mockResolvedValue({
    id: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    accountId: () => 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    sequenceNumber: () => '100',
    incrementSequenceNumber: vi.fn(),
    sequence: '100',
    incrementedSequenceNumber: () => '101',
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
    balances: [{ asset_type: 'native', balance: '10000.0000000' }],
    signers: [],
    data_attr: {},
    subentry_count: 0,
    home_domain: '',
    inflation_dest: null,
  }),
  resolveNetworkPassphrase: (_network: string) => {
    const { Networks } = require('@stellar/stellar-sdk');
    return Networks.TESTNET;
  },
  // StellarPaymentTool expects result.hash (Horizon SubmitTransactionResponse)
  submitTransaction: vi.fn().mockResolvedValue({
    hash: 'test_tx_hash_123456789',
    ledger: 1000,
  }),
  // prepareSorobanTx must return a tx-like object with sign() + signatures[] + timeBounds
  prepareSorobanTx: vi.fn().mockImplementation(() => {
    const obj: any = {
      signatures: [],
      timeBounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 300 },
      fee: '100',
    };
    obj.sign = () => {
      obj.signatures.push({ hint: () => Buffer.alloc(4), signature: () => Buffer.alloc(64) });
    };
    return Promise.resolve(obj);
  }),
  horizonServer: {},
  sorobanServer: {
    sendTransaction: vi.fn(),
    getTransaction: vi.fn(),
  },
}));

vi.mock('../backend/config', () => ({
  config: {
    STELLAR_NETWORK: 'testnet',
    HORIZON_URL: 'https://horizon-testnet.stellar.org',
    SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
    AGENT_PUBLIC_KEY: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    X402_ASSET_CODE: 'USDC',
    X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    AGENT_SPENDING_LIMIT: '1000',
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 100,
    agentKeypair: () => ({
      publicKey: () => 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      secret: () => 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X',
    }),
  },
}));

describe('PayFiAgent integration', () => {
  it('constructs PayFiAgent successfully', () => {
    const agent = new PayFiAgent();
    expect(agent).toBeDefined();
  });
});
