/**
 * tests/integration.test.ts
 *
 * Integration smoke tests for PayFiAgent — exercises the full task dispatch chain
 * with mocked RPC layer only (not individual tools).
 *
 * Issue #441: Added runSequence() integration tests:
 *   - 3-task happy path: account_info → balance_check (stellar_payment) → stellar_payment
 *   - Failure-at-step-2: sequence stops and returns exactly 2 results
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PayFiAgent } from "../backend/agent";

// Mock only the RPC layer to test the full tool chain
vi.mock("../backend/rpc_client", () => ({
  loadAccount: vi.fn().mockResolvedValue({
    id: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    accountId: () => "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
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
  // prepareSorobanTx must return a tx-like object with sign() + signatures[] + timeBounds
  prepareSorobanTx: vi.fn().mockImplementation(() => {
    const obj: any = {
      signatures: [],
      timeBounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 300 },
      fee: "100",
    };
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
    const obj: any = {
      signatures: [],
      timeBounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 300 },
      fee: "100",
    };
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
});

// ─── runSequence() integration tests (Issue #441) ─────────────────────────────

/**
 * Full runSequence() integration tests.
 *
 * Sequence used for the happy path mirrors a realistic PayFi workflow:
 *   Step 1 — account_info:      verify the agent account exists on-chain
 *   Step 2 — stellar_payment:   send a balance-check micro-payment (0.0000001 XLM)
 *   Step 3 — stellar_payment:   execute the main payment
 *
 * The AccountInfoTool.fetch() reads the agent's own account, so loadAccount is
 * the single Horizon call it makes. All three tasks are therefore covered by the
 * same mocked loadAccount + submitTransaction pair already set up above.
 */
describe("PayFiAgent — runSequence() integration (issue #441)", () => {
  let agent: PayFiAgent;

  const DEST   = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

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
    const obj: any = {
      signatures: [],
      timeBounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 300 },
      fee: "100",
    };
    obj.sign = () => {
      obj.signatures.push({ hint: () => Buffer.alloc(4), signature: () => Buffer.alloc(64) });
    };
    return obj;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    const rpc = await import("../backend/rpc_client");
    vi.mocked(rpc.loadAccount).mockResolvedValue(MOCK_ACCOUNT as any);
    vi.mocked(rpc.submitTransaction).mockResolvedValue({
      hash: "test_tx_hash_123456789",
      ledger: 1000,
    } as any);
    vi.mocked(rpc.prepareSorobanTx).mockResolvedValue(makeMockPreparedTx());
    vi.mocked(rpc.sorobanServer.sendTransaction as any).mockResolvedValue({
      hash: "soroban_tx_hash_123456789",
      status: "PENDING",
    });
    vi.mocked(rpc.sorobanServer.getTransaction as any).mockResolvedValue({
      status: "SUCCESS",
      returnValue: null,
    });
    agent = new PayFiAgent();
  });

  // ── Happy path ────────────────────────────────────────────────────────────

  it("happy path: account_info → stellar_payment → stellar_payment — all 3 results success:true", async () => {
    const tasks = [
      // Step 1 — account_info: reads agent account, no on-chain write
      { type: "account_info" as const, payload: {} },
      // Step 2 — micro-payment (simulates a balance-check send)
      {
        type: "stellar_payment" as const,
        payload: {
          destination: DEST,
          amount: "0.0000001",
          assetCode: "XLM",
        },
      },
      // Step 3 — main payment
      {
        type: "stellar_payment" as const,
        payload: {
          destination: DEST,
          amount: "50",
          assetCode: "USDC",
          assetIssuer: ISSUER,
        },
      },
    ];

    const results = await agent.runSequence(tasks);

    // All three tasks must succeed
    expect(results).toHaveLength(3);
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(true);
    expect(results[2]!.success).toBe(true);

    // Task types are preserved on each result
    expect(results[0]!.taskType).toBe("account_info");
    expect(results[1]!.taskType).toBe("stellar_payment");
    expect(results[2]!.taskType).toBe("stellar_payment");
  });

  it("happy path: all 3 AgentResult objects have success:true and no error field", async () => {
    const paymentTask = {
      type: "stellar_payment" as const,
      payload: { destination: DEST, amount: "10", assetCode: "USDC", assetIssuer: ISSUER },
    };
    const results = await agent.runSequence([
      { type: "account_info" as const, payload: {} },
      paymentTask,
      paymentTask,
    ]);

    for (const r of results) {
      expect(r.success).toBe(true);
      expect(r.error).toBeUndefined();
    }
  });

  it("happy path: loadAccount and submitTransaction are called — no real network calls", async () => {
    const rpc = await import("../backend/rpc_client");

    const tasks = [
      { type: "account_info" as const, payload: {} },
      {
        type: "stellar_payment" as const,
        payload: { destination: DEST, amount: "1", assetCode: "XLM" },
      },
      {
        type: "stellar_payment" as const,
        payload: { destination: DEST, amount: "2", assetCode: "XLM" },
      },
    ];

    await agent.runSequence(tasks);

    // loadAccount is called by account_info (step 1) and each stellar_payment (steps 2 & 3)
    expect(rpc.loadAccount).toHaveBeenCalled();
    // submitTransaction is called for each stellar_payment (steps 2 & 3)
    expect(rpc.submitTransaction).toHaveBeenCalledTimes(2);
  });

  it("happy path: payment results carry txHash from mocked Horizon response", async () => {
    const tasks = [
      { type: "account_info" as const, payload: {} },
      {
        type: "stellar_payment" as const,
        payload: { destination: DEST, amount: "5", assetCode: "XLM" },
      },
      {
        type: "stellar_payment" as const,
        payload: { destination: DEST, amount: "5", assetCode: "XLM" },
      },
    ];

    const results = await agent.runSequence(tasks);

    expect(results[1]!.data).toHaveProperty("txHash", "test_tx_hash_123456789");
    expect(results[2]!.data).toHaveProperty("txHash", "test_tx_hash_123456789");
  });

  // ── Failure-at-step-2 ─────────────────────────────────────────────────────

  it("failure at step 2: sequence stops and returns exactly 2 results", async () => {
    const rpc = await import("../backend/rpc_client");

    // Step 1 succeeds (account_info — no submitTransaction needed)
    // Step 2 fails — Horizon rejects the transaction
    vi.mocked(rpc.submitTransaction)
      .mockRejectedValueOnce(new Error("Horizon: op_underfunded — insufficient balance"));

    const tasks = [
      // Step 1 — succeeds
      { type: "account_info" as const, payload: {} },
      // Step 2 — fails
      {
        type: "stellar_payment" as const,
        payload: { destination: DEST, amount: "1", assetCode: "XLM" },
      },
      // Step 3 — must never execute
      {
        type: "stellar_payment" as const,
        payload: { destination: DEST, amount: "2", assetCode: "XLM" },
      },
    ];

    const results = await agent.runSequence(tasks);

    // Sequence must stop after step 2 — only 2 results returned
    expect(results).toHaveLength(2);
    expect(results[0]!.success).toBe(true);
    expect(results[0]!.taskType).toBe("account_info");
    expect(results[1]!.success).toBe(false);
    expect(results[1]!.taskType).toBe("stellar_payment");
    expect(results[1]!.error).toMatch(/underfunded/);

    // Step 3 was never dispatched — submitTransaction called exactly once
    expect(rpc.submitTransaction).toHaveBeenCalledTimes(1);
  });

  it("failure at step 2: the failed result carries the error message", async () => {
    const rpc = await import("../backend/rpc_client");

    vi.mocked(rpc.submitTransaction)
      .mockRejectedValueOnce(new Error("Horizon: tx_bad_auth — unauthorized signer"));

    const tasks = [
      { type: "account_info" as const, payload: {} },
      {
        type: "stellar_payment" as const,
        payload: { destination: DEST, amount: "1", assetCode: "XLM" },
      },
      {
        type: "stellar_payment" as const,
        payload: { destination: DEST, amount: "1", assetCode: "XLM" },
      },
    ];

    const results = await agent.runSequence(tasks);

    expect(results).toHaveLength(2);
    expect(results[1]!.success).toBe(false);
    expect(results[1]!.error).toMatch(/tx_bad_auth/);
  });

  it("failure at step 1: returns 1 result and skips steps 2 and 3", async () => {
    const rpc = await import("../backend/rpc_client");

    // account_info calls loadAccount — make it fail
    vi.mocked(rpc.loadAccount)
      .mockRejectedValueOnce(new Error("Horizon: account not found (404)"));

    const tasks = [
      // Step 1 — fails
      { type: "account_info" as const, payload: {} },
      // Steps 2 & 3 — must never execute
      {
        type: "stellar_payment" as const,
        payload: { destination: DEST, amount: "1", assetCode: "XLM" },
      },
      {
        type: "stellar_payment" as const,
        payload: { destination: DEST, amount: "1", assetCode: "XLM" },
      },
    ];

    const results = await agent.runSequence(tasks);

    expect(results).toHaveLength(1);
    expect(results[0]!.success).toBe(false);
    expect(results[0]!.error).toMatch(/account not found/);
    // No payments were ever attempted
    expect(rpc.submitTransaction).not.toHaveBeenCalled();
  });

  it("empty sequence returns an empty array", async () => {
    const results = await agent.runSequence([]);
    expect(results).toHaveLength(0);
    expect(Array.isArray(results)).toBe(true);
  });

  it("single-task sequence: success returns 1 result with success:true", async () => {
    const results = await agent.runSequence([
      { type: "account_info" as const, payload: {} },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]!.success).toBe(true);
  });

  it("single-task sequence: failure returns 1 result with success:false", async () => {
    const rpc = await import("../backend/rpc_client");
    vi.mocked(rpc.loadAccount).mockRejectedValueOnce(new Error("connection refused"));

    const results = await agent.runSequence([
      { type: "account_info" as const, payload: {} },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]!.success).toBe(false);
  });
});
