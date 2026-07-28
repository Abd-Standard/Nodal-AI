/**
 * tests/integration.test.ts
 *
 * Integration smoke tests for PayFiAgent — exercises the full task dispatch chain
 * with mocked RPC layer only (not individual tools).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PayFiAgent } from "../backend/agent";

// Mock only the RPC layer to test the full tool chain
vi.mock("../backend/rpc_client", () => ({
  loadAccount: vi.fn().mockResolvedValue({
    id: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    accountId: () => "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    sequenceNumber: () => "100",
    incrementSequenceNumber: vi.fn(),
    incrementSequenceNumber: () => {},
    sequence: "100",
    incrementedSequenceNumber: () => "101",
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
    balances: [{ asset_type: "native", balance: "10000.0000000" }],
    signers: [],
    data_attr: {},
    subentry_count: 0,
  }),
  resolveNetworkPassphrase: vi.fn((network) => {
    return network === "mainnet"
      ? "Public Global Stellar Network ; September 2015"
      : "Test SDF Network ; September 2015";
    home_domain: "",
    inflation_dest: null,
  }),
  resolveNetworkPassphrase: (_network: string) => {
    const { Networks } = require("@stellar/stellar-sdk");
    return Networks.TESTNET;
  },
  // StellarPaymentTool expects result.hash (Horizon SubmitTransactionResponse)
  submitTransaction: vi.fn().mockResolvedValue({
    hash: "test_tx_hash_123456789",
    ledger: 1000,
  }),
  prepareSorobanTx: vi.fn().mockResolvedValue({
    sign: vi.fn(),
    toEnvelope: vi.fn(),
  }),
  horizonServer: {
    transactions: vi.fn(),
    operations: vi.fn(),
  },
  // prepareSorobanTx must return a tx-like object with sign() + signatures[]
  prepareSorobanTx: vi.fn().mockImplementation(() => {
    const obj: any = { signatures: [] };
    obj.sign = () => {
      obj.signatures.push({ hint: () => Buffer.alloc(4), signature: () => Buffer.alloc(64) });
    };
    return Promise.resolve(obj);
  }),
  horizonServer: {},
  sorobanServer: {
    sendTransaction: vi.fn().mockResolvedValue({
      hash: "soroban_tx_hash_123456789",
      status: "PENDING",
    }),
    getTransaction: vi.fn().mockResolvedValue({
      status: "SUCCESS",
      returnValue: null,
    }),
  },
}));

vi.mock("../backend/config", () => ({
  config: {
    STELLAR_NETWORK: "testnet",
    HORIZON_URL: "https://horizon-testnet.stellar.org",
    SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    AGENT_PUBLIC_KEY: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    X402_ASSET_CODE: "USDC",
    X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    AGENT_SPENDING_LIMIT: "1000",
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 100,
    agentKeypair: () => ({
      publicKey: () => "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      secret: () => "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73",
    }),
  },
  MAINNET_SPENDING_CAP: 10000,
}));

vi.mock("../backend/persistence", () => ({
  saveResult: vi.fn(),
}));

describe("PayFiAgent integration", () => {
  let agent: PayFiAgent;
  const DEST = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

  beforeEach(async () => {
    vi.clearAllMocks();

    // Re-apply mock implementations after clearAllMocks resets them
    const { loadAccount, submitTransaction, prepareSorobanTx, resolveNetworkPassphrase } =
      await import("../backend/rpc_client");

    vi.mocked(resolveNetworkPassphrase).mockImplementation((network: string) =>
      network === "mainnet"
        ? "Public Global Stellar Network ; September 2015"
        : "Test SDF Network ; September 2015"
    );

    vi.mocked(loadAccount).mockResolvedValue({
      id: DEST,
      accountId: () => DEST,
      sequenceNumber: () => "100",
      incrementSequenceNumber: vi.fn(),
      sequence: "100",
      incrementedSequenceNumber: () => "101",
      thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
      flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
      balances: [{ asset_type: "native", balance: "10000.0000000" }],
      signers: [],
      data_attr: {},
      subentry_count: 0,
    } as any);

    vi.mocked(submitTransaction).mockResolvedValue({
      hash: "test_tx_hash_123456789",
      ledger: 1000,
    } as any);

    vi.mocked(prepareSorobanTx).mockResolvedValue({
      sign: vi.fn(),
      toEnvelope: vi.fn(),
    } as any);

    const { sorobanServer } = await import("../backend/rpc_client");
    vi.mocked(sorobanServer.sendTransaction as any).mockResolvedValue({
      status: "PENDING",
      hash: "soroban_tx_hash_123456789",
    });
    vi.mocked(sorobanServer.getTransaction as any).mockResolvedValue({
      status: "SUCCESS",
    });

const MOCK_ACCOUNT = {
    id: DEST,
    accountId: () => DEST,
    sequenceNumber: () => "100",
    incrementSequenceNumber: () => {},
    sequence: "100",
    incrementedSequenceNumber: () => "101",
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
    balances: [{ asset_type: "native", balance: "10000.0000000" }],
    signers: [],
    data_attr: {},
    subentry_count: 0,
    home_domain: "",
    inflation_dest: null,
  };

  function makeMockPreparedTx() {
    const obj: any = { signatures: [], fee: 500_000, timeBounds: {} };
    obj.sign = () => {
      obj.signatures.push({ hint: () => Buffer.alloc(4), signature: () => Buffer.alloc(64) });
    };
    return obj;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    // Re-apply mock implementations after clearAllMocks
    const rpc = await import("../backend/rpc_client");
    vi.mocked(rpc.loadAccount).mockResolvedValue(MOCK_ACCOUNT as any);
    vi.mocked(rpc.submitTransaction).mockResolvedValue({ hash: "test_tx_hash_123456789", ledger: 1000 } as any);
    vi.mocked(rpc.prepareSorobanTx).mockResolvedValue(makeMockPreparedTx());
    vi.mocked(rpc.sorobanServer.sendTransaction as any).mockResolvedValue({ hash: "soroban_tx_hash_123456789", status: "PENDING" });
    vi.mocked(rpc.sorobanServer.getTransaction as any).mockResolvedValue({ status: "SUCCESS", returnValue: null });
    agent = new PayFiAgent();
  });

  it("executes stellar_payment task with full tool chain", async () => {
    const { loadAccount, submitTransaction } = await import("../backend/rpc_client");
    const result = await agent.run({
      type: "stellar_payment",
      payload: {
        destination: DEST,
        amount: "100",
        assetCode: "USDC",
        assetIssuer: ISSUER,
      },
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("txHash", "test_tx_hash_123456789");
    expect(loadAccount).toHaveBeenCalled();
    expect(submitTransaction).toHaveBeenCalled();
  });

  it("executes soroban_invoke task with full chain", async () => {
    const { prepareSorobanTx } = await import("../backend/rpc_client");
    const result = await agent.run({
      type: "soroban_invoke",
      payload: {
        contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
        method: "test_method",
        args: [],
      },
    });

    expect(result.success).toBe(true);
    expect(prepareSorobanTx).toHaveBeenCalled();
  });

  it("executes x402_respond task with full chain", async () => {
    const { submitTransaction } = await import("../backend/rpc_client");
    const challenge = {
      resource: "https://example.com/resource",
      amount: "50",
      assetCode: "USDC",
      assetIssuer: ISSUER,
      payTo: DEST,
      nonce: "550e8400-e29b-41d4-a716-446655440000",
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    };

    const result = await agent.run({
      type: "x402_respond",
      payload: challenge,
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("protocol", "x402");
    expect(submitTransaction).toHaveBeenCalled();
  });

  it("executes change_trust task with full tool chain", async () => {
    const { loadAccount, submitTransaction } = await import("../backend/rpc_client");
    const result = await agent.run({
      type: "change_trust",
      payload: {
        assetCode: "USDC",
        assetIssuer: ISSUER,
        action: "add",
        limit: "1000",
      },
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("txHash", "test_tx_hash_123456789");
    expect(loadAccount).toHaveBeenCalled();
    expect(submitTransaction).toHaveBeenCalled();
  });

  it("executes multisig_payment task with full tool chain", async () => {
    const { loadAccount, submitTransaction } = await import("../backend/rpc_client");
    const result = await agent.run({
      type: "multisig_payment",
      payload: {
        destination: DEST,
        amount: "50",
        assetCode: "XLM",
        additionalSigners: [],
        minSignatures: 1,
        signatures: ["dummy-signature"],
      },
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("txHash", "test_tx_hash_123456789");
    expect(loadAccount).toHaveBeenCalled();
    expect(submitTransaction).toHaveBeenCalled();
  });

  it("executes batch_payment task with full tool chain", async () => {
    const { loadAccount, submitTransaction } = await import("../backend/rpc_client");
    const result = await agent.run({
      type: "batch_payment",
      payload: {
        payments: [
          { destination: DEST, amount: "10", assetCode: "USDC", assetIssuer: ISSUER },
          { destination: DEST, amount: "20", assetCode: "USDC", assetIssuer: ISSUER },
        ],
      },
    });

    expect(result.success).toBe(true);
    expect(result.data).toHaveProperty("txHash", "test_tx_hash_123456789");
    expect(loadAccount).toHaveBeenCalled();
    expect(submitTransaction).toHaveBeenCalled();
  });
});
