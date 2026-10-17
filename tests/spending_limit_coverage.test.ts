/**
 * tests/spending_limit_coverage.test.ts
 *
 * Issue #728 — Spending limit is bypassed by path_payment, multisig_payment,
 * batch_payment, dex_offer, and fee_bump task types.
 *
 * Each value-moving task type must be rejected when the payment amount would
 * exceed AGENT_SPENDING_LIMIT, and must record the spend into the rolling
 * window when it succeeds (verified by confirming a follow-up payment that
 * would push the cumulative total over the limit is also rejected).
 *
 * All tool calls are mocked so no real network activity occurs.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PayFiAgent, spendingTracker } from "../backend/agent";
import { StellarPaymentTool } from "../backend/tools/StellarPaymentTool";
import { PathPaymentTool } from "../backend/tools/PathPaymentTool";
import { MultiSigPaymentTool } from "../backend/tools/MultiSigPaymentTool";
import { BatchPaymentTool } from "../backend/tools/BatchPaymentTool";
import { DexOfferTool } from "../backend/tools/DexOfferTool";
import { FeeBumpTool } from "../backend/tools/FeeBumpTool";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../backend/tools/StellarPaymentTool", () => ({
  StellarPaymentTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ txHash: "stellar_hash", ledger: 1 }),
  })),
}));

vi.mock("../backend/tools/SorobanInvokeTool", () => ({
  SorobanInvokeTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock("../backend/tools/X402PaymentTool", () => ({
  X402PaymentTool: vi.fn().mockImplementation(() => ({
    respond: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock("../backend/tools/AccountInfoTool", () => ({
  AccountInfoTool: vi.fn().mockImplementation(() => ({
    fetch: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock("../backend/tools/TrustlineTool", () => ({
  TrustlineTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock("../backend/tools/MultiSigPaymentTool", () => ({
  MultiSigPaymentTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ txHash: "multisig_hash", ledger: 1 }),
  })),
}));

vi.mock("../backend/tools/BatchPaymentTool", () => ({
  BatchPaymentTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ txHash: "batch_hash", ledger: 1 }),
  })),
}));

vi.mock("../backend/tools/SorobanQueryTool", () => ({
  SorobanQueryTool: vi.fn().mockImplementation(() => ({
    query: vi.fn().mockResolvedValue({}),
  })),
}));

vi.mock("../backend/tools/BalanceCheckTool", () => ({
  BalanceCheckTool: vi.fn().mockImplementation(() => ({
    getBalance: vi.fn().mockResolvedValue({ balances: [] }),
  })),
}));

vi.mock("../backend/tools/PathPaymentTool", () => ({
  PathPaymentTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ txHash: "path_hash", ledger: 1 }),
  })),
}));

vi.mock("../backend/tools/FeeBumpTool", () => ({
  FeeBumpTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ txHash: "fee_bump_hash", ledger: 1 }),
  })),
}));

vi.mock("../backend/tools/DexOfferTool", () => ({
  DexOfferTool: vi.fn().mockImplementation(() => ({
    execute: vi.fn().mockResolvedValue({ txHash: "dex_hash", ledger: 1, offerId: "42" }),
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
  horizonServer: {
    payments: vi.fn(() => ({ forAccount: vi.fn(() => ({ stream: vi.fn() })) })),
  },
  sorobanServer: {},
  resolveNetworkPassphrase: vi.fn(() => "Test SDF Network ; September 2015"),
}));

// AGENT_SPENDING_LIMIT is set low (100) so tests can easily breach it.
// STELLAR_NETWORK is testnet so the mainnet cap does not interfere.
vi.mock("../backend/config", () => ({
  config: {
    STELLAR_NETWORK: "testnet",
    HORIZON_URL: "https://horizon-testnet.stellar.org",
    SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    AGENT_PUBLIC_KEY: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    X402_ASSET_CODE: "USDC",
    X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    AGENT_SPENDING_LIMIT: "100",
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 100,
    MAX_CONCURRENT_TASKS: 10,
    SPENDING_WINDOW_MS: 60_000,
    agentKeypair: () => ({
      secret: () => "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73",
    }),
  },
  MAINNET_SPENDING_CAP: 10_000,
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

const DEST   = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

// ─── path_payment ─────────────────────────────────────────────────────────────

describe("Issue #728 — path_payment spending limit", () => {
  let agent: PayFiAgent;

  beforeEach(() => {
    spendingTracker.clear();
    vi.clearAllMocks();
    vi.mocked(PathPaymentTool).mockImplementation(() => ({
      execute: vi.fn().mockResolvedValue({ txHash: "path_hash", ledger: 1 }),
    } as any));
    vi.mocked(StellarPaymentTool).mockImplementation(() => ({
      execute: vi.fn().mockResolvedValue({ txHash: "stellar_hash", ledger: 1 }),
    } as any));
    agent = new PayFiAgent();
  });

  it("rejects path_payment when sendAmount exceeds AGENT_SPENDING_LIMIT", async () => {
    const result = await agent.run({
      type: "path_payment",
      payload: {
        destination: DEST,
        sendAsset: { code: "XLM" },
        sendAmount: "150",          // > limit of 100
        destAsset: { code: "USDC", issuer: ISSUER },
        destMinAmount: "140",
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exceeds AGENT_SPENDING_LIMIT|exceeds limit/i);
    // The tool must NOT have been called
    const pathMock = vi.mocked(PathPaymentTool).mock.results[0]!.value;
    expect(pathMock.execute).not.toHaveBeenCalled();
  });

  it("accepts path_payment within the limit and records into the rolling window", async () => {
    const result = await agent.run({
      type: "path_payment",
      payload: {
        destination: DEST,
        sendAsset: { code: "XLM" },
        sendAmount: "60",
        destAsset: { code: "USDC", issuer: ISSUER },
        destMinAmount: "55",
      },
    });

    expect(result.success).toBe(true);
    // 60 was committed — a follow-up stellar_payment of 50 must push total to 110 and be rejected
    const followUp = await agent.run({
      type: "stellar_payment",
      payload: { destination: DEST, amount: "50", assetCode: "USDC", assetIssuer: ISSUER },
    });
    expect(followUp.success).toBe(false);
    expect(followUp.error).toMatch(/exceeds/i);
  });

  it("does NOT count a failed path_payment toward the rolling window", async () => {
    const pathMock = vi.mocked(PathPaymentTool).mock.results[0]!.value;
    pathMock.execute.mockRejectedValueOnce(new Error("tx_bad_seq"));

    const result = await agent.run({
      type: "path_payment",
      payload: {
        destination: DEST,
        sendAsset: { code: "XLM" },
        sendAmount: "60",
        destAsset: { code: "USDC", issuer: ISSUER },
        destMinAmount: "55",
      },
    });

    expect(result.success).toBe(false);
    // After failure the window total must still be 0
    expect(spendingTracker.total()).toBe(0);
  });
});

// ─── multisig_payment ─────────────────────────────────────────────────────────

describe("Issue #728 — multisig_payment spending limit", () => {
  let agent: PayFiAgent;

  beforeEach(() => {
    spendingTracker.clear();
    vi.clearAllMocks();
    vi.mocked(MultiSigPaymentTool).mockImplementation(() => ({
      execute: vi.fn().mockResolvedValue({ txHash: "multisig_hash", ledger: 1 }),
    } as any));
    vi.mocked(StellarPaymentTool).mockImplementation(() => ({
      execute: vi.fn().mockResolvedValue({ txHash: "stellar_hash", ledger: 1 }),
    } as any));
    agent = new PayFiAgent();
  });

  it("rejects multisig_payment when amount exceeds limit (with enough sigs to submit)", async () => {
    const result = await agent.run({
      type: "multisig_payment",
      payload: {
        destination: DEST,
        amount: "150",        // > 100
        assetCode: "XLM",
        additionalSigners: [DEST],
        minSignatures: 1,
        signatures: ["AAAA=="],  // 1 sig meets minSignatures=1 → willSubmit=true
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exceeds AGENT_SPENDING_LIMIT|exceeds limit/i);
  });

  it("skips spending check when returning unsigned XDR (no signatures provided)", async () => {
    // When signatures are absent the tool returns unsignedXDR — no funds move
    vi.mocked(MultiSigPaymentTool).mock.results[0]!.value.execute
      .mockResolvedValueOnce({ unsignedXDR: "AAAA==" });

    const result = await agent.run({
      type: "multisig_payment",
      payload: {
        destination: DEST,
        amount: "150",           // would exceed limit — but no submission happens
        assetCode: "XLM",
        additionalSigners: [DEST],
        minSignatures: 2,
        // No signatures → willSubmit = false
      },
    });

    // Should succeed because no funds are moved
    expect(result.success).toBe(true);
  });

  it("records multisig spend into the rolling window on success", async () => {
    const result = await agent.run({
      type: "multisig_payment",
      payload: {
        destination: DEST,
        amount: "70",
        assetCode: "XLM",
        additionalSigners: [DEST],
        minSignatures: 1,
        signatures: ["AAAA=="],
      },
    });
    expect(result.success).toBe(true);

    // 70 committed — a follow-up of 40 would put total at 110 > 100
    const followUp = await agent.run({
      type: "stellar_payment",
      payload: { destination: DEST, amount: "40", assetCode: "XLM" },
    });
    expect(followUp.success).toBe(false);
    expect(followUp.error).toMatch(/exceeds/i);
  });
});

// ─── batch_payment ────────────────────────────────────────────────────────────

describe("Issue #728 — batch_payment spending limit (rolling window)", () => {
  let agent: PayFiAgent;

  beforeEach(() => {
    spendingTracker.clear();
    vi.clearAllMocks();
    vi.mocked(BatchPaymentTool).mockImplementation(() => ({
      execute: vi.fn().mockResolvedValue({ txHash: "batch_hash", ledger: 1 }),
    } as any));
    vi.mocked(StellarPaymentTool).mockImplementation(() => ({
      execute: vi.fn().mockResolvedValue({ txHash: "stellar_hash", ledger: 1 }),
    } as any));
    agent = new PayFiAgent();
  });

  it("rejects batch_payment when aggregate total exceeds AGENT_SPENDING_LIMIT", async () => {
    const result = await agent.run({
      type: "batch_payment",
      payload: {
        payments: [
          { destination: DEST, amount: "60", assetCode: "XLM" },
          { destination: DEST, amount: "60", assetCode: "XLM" }, // total 120 > 100
        ],
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exceeds AGENT_SPENDING_LIMIT|exceeds limit/i);
    const batchMock = vi.mocked(BatchPaymentTool).mock.results[0]!.value;
    expect(batchMock.execute).not.toHaveBeenCalled();
  });

  it("records the batch total into the rolling window on success", async () => {
    const result = await agent.run({
      type: "batch_payment",
      payload: {
        payments: [
          { destination: DEST, amount: "40", assetCode: "XLM" },
          { destination: DEST, amount: "30", assetCode: "XLM" }, // total 70
        ],
      },
    });
    expect(result.success).toBe(true);

    // 70 is now committed — a follow-up stellar_payment of 40 would total 110 > 100
    const followUp = await agent.run({
      type: "stellar_payment",
      payload: { destination: DEST, amount: "40", assetCode: "XLM" },
    });
    expect(followUp.success).toBe(false);
    expect(followUp.error).toMatch(/exceeds/i);
  });

  it("does NOT count a failed batch_payment toward the rolling window", async () => {
    vi.mocked(BatchPaymentTool).mock.results[0]!.value.execute
      .mockRejectedValueOnce(new Error("network error"));

    const result = await agent.run({
      type: "batch_payment",
      payload: {
        payments: [
          { destination: DEST, amount: "40", assetCode: "XLM" },
          { destination: DEST, amount: "30", assetCode: "XLM" },
        ],
      },
    });
    expect(result.success).toBe(false);
    expect(spendingTracker.total()).toBe(0);
  });
});

// ─── dex_offer ────────────────────────────────────────────────────────────────

describe("Issue #728 — dex_offer spending limit", () => {
  let agent: PayFiAgent;

  beforeEach(() => {
    spendingTracker.clear();
    vi.clearAllMocks();
    vi.mocked(DexOfferTool).mockImplementation(() => ({
      execute: vi.fn().mockResolvedValue({ txHash: "dex_hash", ledger: 1, offerId: "42" }),
    } as any));
    vi.mocked(StellarPaymentTool).mockImplementation(() => ({
      execute: vi.fn().mockResolvedValue({ txHash: "stellar_hash", ledger: 1 }),
    } as any));
    agent = new PayFiAgent();
  });

  it("rejects dex_offer create when sell amount exceeds AGENT_SPENDING_LIMIT", async () => {
    const result = await agent.run({
      type: "dex_offer",
      payload: {
        action: "create",
        selling: { code: "XLM" },
        buying: { code: "USDC", issuer: ISSUER },
        amount: "150",   // > 100
        price: "0.25",
      },
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/exceeds AGENT_SPENDING_LIMIT|exceeds limit/i);
    const dexMock = vi.mocked(DexOfferTool).mock.results[0]!.value;
    expect(dexMock.execute).not.toHaveBeenCalled();
  });

  it("accepts dex_offer create within limit and records into rolling window", async () => {
    const result = await agent.run({
      type: "dex_offer",
      payload: {
        action: "create",
        selling: { code: "XLM" },
        buying: { code: "USDC", issuer: ISSUER },
        amount: "70",
        price: "0.25",
      },
    });
    expect(result.success).toBe(true);

    // 70 committed — follow-up stellar_payment of 40 should exceed the limit
    const followUp = await agent.run({
      type: "stellar_payment",
      payload: { destination: DEST, amount: "40", assetCode: "XLM" },
    });
    expect(followUp.success).toBe(false);
    expect(followUp.error).toMatch(/exceeds/i);
  });

  it("does NOT count a failed dex_offer toward the rolling window", async () => {
    vi.mocked(DexOfferTool).mock.results[0]!.value.execute
      .mockRejectedValueOnce(new Error("op_underfunded"));

    const result = await agent.run({
      type: "dex_offer",
      payload: {
        action: "create",
        selling: { code: "XLM" },
        buying: { code: "USDC", issuer: ISSUER },
        amount: "70",
        price: "0.25",
      },
    });
    expect(result.success).toBe(false);
    expect(spendingTracker.total()).toBe(0);
  });
});

// ─── stellar_payment — cumulative limit across task types ─────────────────────

describe("Issue #728 — cross-task-type cumulative limit enforcement", () => {
  let agent: PayFiAgent;

  beforeEach(() => {
    spendingTracker.clear();
    vi.clearAllMocks();
    vi.mocked(StellarPaymentTool).mockImplementation(() => ({
      execute: vi.fn().mockResolvedValue({ txHash: "stellar_hash", ledger: 1 }),
    } as any));
    vi.mocked(PathPaymentTool).mockImplementation(() => ({
      execute: vi.fn().mockResolvedValue({ txHash: "path_hash", ledger: 1 }),
    } as any));
    vi.mocked(BatchPaymentTool).mockImplementation(() => ({
      execute: vi.fn().mockResolvedValue({ txHash: "batch_hash", ledger: 1 }),
    } as any));
    vi.mocked(DexOfferTool).mockImplementation(() => ({
      execute: vi.fn().mockResolvedValue({ txHash: "dex_hash", ledger: 1, offerId: "1" }),
    } as any));
    agent = new PayFiAgent();
  });

  it("cumulates spend across path_payment + stellar_payment and blocks when limit reached", async () => {
    // path_payment: 40 (within limit)
    const r1 = await agent.run({
      type: "path_payment",
      payload: {
        destination: DEST,
        sendAsset: { code: "XLM" },
        sendAmount: "40",
        destAsset: { code: "USDC", issuer: ISSUER },
        destMinAmount: "35",
      },
    });
    expect(r1.success).toBe(true);

    // stellar_payment: 70 — cumulative would be 110 > 100
    const r2 = await agent.run({
      type: "stellar_payment",
      payload: { destination: DEST, amount: "70", assetCode: "XLM" },
    });
    expect(r2.success).toBe(false);
    expect(r2.error).toMatch(/exceeds/i);
  });

  it("cumulates spend across batch_payment + dex_offer and blocks when limit reached", async () => {
    // batch_payment: 50 (within limit)
    const r1 = await agent.run({
      type: "batch_payment",
      payload: {
        payments: [{ destination: DEST, amount: "50", assetCode: "XLM" }],
      },
    });
    expect(r1.success).toBe(true);

    // dex_offer: 60 — cumulative would be 110 > 100
    const r2 = await agent.run({
      type: "dex_offer",
      payload: {
        action: "create",
        selling: { code: "XLM" },
        buying: { code: "USDC", issuer: ISSUER },
        amount: "60",
        price: "0.3",
      },
    });
    expect(r2.success).toBe(false);
    expect(r2.error).toMatch(/exceeds/i);
  });
});
