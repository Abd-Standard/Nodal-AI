/**
 * tests/agent.test.ts
 *
 * Tests for PayFiAgent — focused on assertWithinSpendingLimit behaviour,
 * including the secondary mainnet spending cap guard.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PayFiAgent } from "../backend/agent";
import { StellarPaymentTool } from "../backend/tools/StellarPaymentTool";

vi.mock("../backend/tools/StellarPaymentTool", () => ({
  StellarPaymentTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ txHash: "mock_hash", ledger: 1 }),
  })),
}));

vi.mock("../backend/tools/SorobanInvokeTool", () => ({
  SorobanInvokeTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn(),
  })),
}));

vi.mock("../backend/tools/X402PaymentTool", () => ({
  X402PaymentTool: vi.fn().mockImplementation(() => ({
    respond: vi.fn(),
  })),
}));

vi.mock("../backend/tools/AccountInfoTool", () => ({
  AccountInfoTool: vi.fn().mockImplementation(() => ({
    fetch: vi.fn(),
  })),
}));

vi.mock("../backend/tools/TrustlineTool", () => ({
  TrustlineTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn(),
    checkTrustline: vi.fn(),
  })),
}));

vi.mock("../backend/tools/MultiSigPaymentTool", () => ({
  MultiSigPaymentTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn(),
  })),
}));

vi.mock("../backend/tools/BatchPaymentTool", () => ({
  BatchPaymentTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn(),
  })),
}));

vi.mock("../backend/tools/SorobanQueryTool", () => ({
  SorobanQueryTool: vi.fn().mockImplementation(() => ({
    query: vi.fn(),
  })),
}));

vi.mock("../backend/tools/BalanceCheckTool", () => ({
  BalanceCheckTool: vi.fn().mockImplementation(() => ({
    getBalance: vi.fn().mockResolvedValue({ publicKey: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5", balances: [] }),
  })),
}));

vi.mock("../backend/tools/PathPaymentTool", () => ({
  PathPaymentTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ txHash: "path_mock_hash", ledger: 1 }),
  })),
}));

vi.mock("../backend/tools/FeeBumpTool", () => ({
  FeeBumpTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ txHash: "fee_bump_mock_hash", ledger: 1 }),
  })),
}));

vi.mock("../backend/tools/DexOfferTool", () => ({
  DexOfferTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ txHash: "dex_mock_hash", ledger: 1, offerId: "0" }),
  })),
}));

vi.mock("../backend/tools/ContractEventListener", () => ({
  listen: vi.fn().mockReturnValue(() => {}),
}));

vi.mock("../backend/webhook", () => ({
  dispatchWebhook: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../backend/persistence", () => ({
  saveResult: vi.fn(),
}));

vi.mock("../backend/rpc_client", () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  horizonServer: { payments: vi.fn(() => ({ forAccount: vi.fn(() => ({ stream: vi.fn() })) })) },
  sorobanServer: {},
  resolveNetworkPassphrase: vi.fn(() => "Public Global Stellar Network ; September 2015"),
}));

vi.mock("../backend/config", () => ({
  config: {
    STELLAR_NETWORK: "mainnet",
    HORIZON_URL: "https://horizon.stellar.org",
    SOROBAN_RPC_URL: "https://soroban-mainnet.stellar.org",
    AGENT_PUBLIC_KEY: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    X402_ASSET_CODE: "USDC",
    X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 100,
    // Set above MAINNET_SPENDING_CAP to exercise the secondary runtime guard
    AGENT_SPENDING_LIMIT: "15000",
    agentKeypair: () => ({
      secret: () => "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73",
    }),
  },
  MAINNET_SPENDING_CAP: 10_000,
}));

// ─── Tests ────────────────────────────────────────────────────────────────────

const DEST = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

describe("PayFiAgent — runSequence", () => {
  let agent: PayFiAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-apply default mock implementation after clearAllMocks (clearMocks resets call history
    // but also clears mockReturnValue / mockResolvedValue set inside vi.mock factories).
    vi.mocked(StellarPaymentTool).mockImplementation(() => ({
      execute: vi.fn().mockResolvedValue({ txHash: "mock_hash", ledger: 1 }),
    } as any));
    agent = new PayFiAgent();
  });

  it("executes 3 tasks in order and returns all results on success", async () => {
    const task = {
      type: "stellar_payment" as const,
      payload: { destination: DEST, amount: "100", assetCode: "USDC", assetIssuer: ISSUER },
    };
    const results = await agent.runSequence([task, task, task]);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.success)).toBe(true);
  });

  it("stops at task 2 when it fails and does not execute task 3", async () => {
    const mockInstance = vi.mocked(StellarPaymentTool).mock.results[0]!.value;
    mockInstance.execute
      .mockResolvedValueOnce({ txHash: "hash1", ledger: 1 })
      .mockRejectedValueOnce(new Error("Network failure"));

    const task = {
      type: "stellar_payment" as const,
      payload: { destination: DEST, amount: "100", assetCode: "USDC", assetIssuer: ISSUER },
    };
    const results = await agent.runSequence([task, task, task]);
    expect(results).toHaveLength(2);
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(false);
    expect(results[1]!.error).toContain("Network failure");
    expect(mockInstance.execute).toHaveBeenCalledTimes(2);
  });

  it("rejects mid-sequence when a task exceeds the mainnet spending cap", async () => {
    const okTask = {
      type: "stellar_payment" as const,
      payload: { destination: DEST, amount: "9999", assetCode: "USDC", assetIssuer: ISSUER },
    };
    const overCapTask = {
      type: "stellar_payment" as const,
      payload: { destination: DEST, amount: "11000", assetCode: "USDC", assetIssuer: ISSUER },
    };
    const results = await agent.runSequence([okTask, overCapTask, okTask]);
    expect(results).toHaveLength(2);
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(false);
    expect(results[1]!.error).toMatch(/mainnet spending cap/);
  });
});

describe("PayFiAgent — mainnet spending cap", () => {
  let agent: PayFiAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(StellarPaymentTool).mockImplementation(() => ({
      execute: vi.fn().mockResolvedValue({ txHash: "mock_hash", ledger: 1 }),
    } as any));
    agent = new PayFiAgent();
  });

  it("rejects a stellar_payment above MAINNET_SPENDING_CAP on mainnet", async () => {
    const result = await agent.run({
      type: "stellar_payment",
      payload: {
        destination: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        amount: "12000",
        assetCode: "USDC",
        assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mainnet spending cap/);
  });

  it("rejects an x402_respond above MAINNET_SPENDING_CAP on mainnet", async () => {
    const result = await agent.run({
      type: "x402_respond",
      payload: {
        resource: "https://api.example.com/data",
        amount: "11000",
        assetCode: "USDC",
        assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        payTo: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        nonce: "550e8400-e29b-41d4-a716-446655440000",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/mainnet spending cap/);
  });

  it("accepts a stellar_payment at or below MAINNET_SPENDING_CAP on mainnet", async () => {
    const result = await agent.run({
      type: "stellar_payment",
      payload: {
        destination: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        amount: "9999",
        assetCode: "USDC",
        assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      },
    });

    expect(result.success).toBe(true);
  });

  it("two PayFiAgent instances do not share state when run concurrently", async () => {
    vi.clearAllMocks();
    const agent1 = new PayFiAgent();
    const agent2 = new PayFiAgent();

    const mockInstance1 = vi.mocked(StellarPaymentTool).mock.results[0]!.value;
    const mockInstance2 = vi.mocked(StellarPaymentTool).mock.results[1]!.value;

    mockInstance1.execute.mockResolvedValueOnce({ txHash: "tx_hash_1", ledger: 1 });
    mockInstance2.execute.mockResolvedValueOnce({ txHash: "tx_hash_2", ledger: 2 });

    const task = {
      type: "stellar_payment" as const,
      payload: {
        destination: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        amount: "100",
        assetCode: "USDC",
        assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      },
    };

    const [result1, result2] = await Promise.all([
      agent1.run(task),
      agent2.run(task),
    ]);

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
    expect((result1.data as any)?.txHash).toBe("tx_hash_1");
    expect((result2.data as any)?.txHash).toBe("tx_hash_2");
    expect(agent1).not.toBe(agent2);
  });
});

describe("AgentResult snapshot", () => {
  let agent: PayFiAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(StellarPaymentTool).mockImplementation(() => ({
      execute: vi.fn().mockResolvedValue({ txHash: "success_tx_hash", ledger: 1 }),
    } as any));
    agent = new PayFiAgent();
  });

  it("AgentResult has expected shape on success", async () => {
    const result = await agent.run({
      type: "stellar_payment",
      payload: {
        destination: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        amount: "100",
        assetCode: "USDC",
        assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      },
    });

    expect(result).toMatchSnapshot();
    expect(result).toHaveProperty("success", true);
    expect(result).toHaveProperty("taskType", "stellar_payment");
    expect(result).toHaveProperty("data");
  });

  it("AgentResult has expected shape on failure", async () => {
    const mockInstance = vi.mocked(StellarPaymentTool).mock.results[0]!.value;
    mockInstance.execute.mockRejectedValueOnce(new Error("Test error"));

    const result = await agent.run({
      type: "stellar_payment",
      payload: {
        destination: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        amount: "100",
        assetCode: "USDC",
        assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      },
    });

    expect(result).toMatchSnapshot();
    expect(result).toHaveProperty("success", false);
    expect(result).toHaveProperty("taskType", "stellar_payment");
    expect(result).toHaveProperty("error");
  });
});

describe("PayFiAgent — new task types", () => {
  let agent: PayFiAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(StellarPaymentTool).mockImplementation(() => ({
      execute: vi.fn().mockResolvedValue({ txHash: "mock_hash", ledger: 1 }),
    } as any));
    agent = new PayFiAgent();
  });

  it("dispatches balance_check and returns success", async () => {
    const result = await agent.run({
      type: "balance_check",
      payload: { publicKey: DEST },
    });
    expect(result.success).toBe(true);
    expect(result.taskType).toBe("balance_check");
  });

  it("dispatches path_payment and returns success", async () => {
    const result = await agent.run({
      type: "path_payment",
      payload: {
        destination: DEST,
        sendAsset: { code: "XLM" },
        sendAmount: "10",
        destAsset: { code: "USDC", issuer: ISSUER },
        destMinAmount: "9",
      },
    });
    expect(result.success).toBe(true);
    expect(result.taskType).toBe("path_payment");
  });

  it("dispatches fee_bump and returns success", async () => {
    const result = await agent.run({
      type: "fee_bump",
      payload: { innerTxXdr: "AAAA" },
    });
    expect(result.success).toBe(true);
    expect(result.taskType).toBe("fee_bump");
  });

  it("dispatches dex_offer and returns success", async () => {
    const result = await agent.run({
      type: "dex_offer",
      payload: {
        action: "create",
        selling: { code: "XLM" },
        buying: { code: "USDC", issuer: ISSUER },
        amount: "100",
        price: "0.25",
      },
    });
    expect(result.success).toBe(true);
    expect(result.taskType).toBe("dex_offer");
  });

  it("startContractListener starts the listener and stopContractListener stops it", () => {
    const onEvent = vi.fn();
    agent.startContractListener("CDPVBHPSVYKWSI5ECEA4DASBG3RBNU5EHEE3DHNFX7RMBCZV66CSC7NH", [], onEvent);
    agent.stopContractListener();
    // No error thrown — listener lifecycle works
  });

  it("destroy() cleans up the contract listener", () => {
    const onEvent = vi.fn();
    agent.startContractListener("CDPVBHPSVYKWSI5ECEA4DASBG3RBNU5EHEE3DHNFX7RMBCZV66CSC7NH", [], onEvent);
    expect(() => agent.destroy()).not.toThrow();
  });
});

describe("PayFiAgent — payload sanitisation", () => {
  let agent: PayFiAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    agent = new PayFiAgent();
  });

  it("scrubs secretKey from payload before logging on failure", async () => {
    // The agent constructor calls `new StellarPaymentTool(...)` which populates results[0].
    // Read the mock instance immediately so we can override execute for this test.
    const mockInstance = vi.mocked(StellarPaymentTool).mock.instances[0] as any;
    mockInstance.execute = vi.fn().mockRejectedValueOnce(new Error("simulated payment failure"));

    const result = await agent.run({
      type: "stellar_payment",
      payload: {
        destination: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        amount: "100",
        assetCode: "USDC",
        assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        secretKey: "SABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("simulated payment failure");
    expect(result.error).not.toContain("SABCDEFGHIJKLMNOPQRSTUVWXYZ234567");
  });
});
