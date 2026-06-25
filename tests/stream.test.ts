/**
 * tests/stream.test.ts
 * Tests for PayFiAgent startListening / stopListening (#107)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Hoist mocks so factory closures can reference them ──────────────────────
const { mockStopStream, mockStream, mockForAccount, mockPayments } = vi.hoisted(() => {
  const mockStopStream = vi.fn();
  const mockStream = vi.fn(() => mockStopStream);
  const mockForAccount = vi.fn(() => ({ stream: mockStream }));
  const mockPayments = vi.fn(() => ({ forAccount: mockForAccount }));
  return { mockStopStream, mockStream, mockForAccount, mockPayments };
});

// ─── Mock tools ───────────────────────────────────────────────────────────────
vi.mock("../backend/tools/StellarPaymentTool", () => ({
  StellarPaymentTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock("../backend/tools/SorobanInvokeTool", () => ({
  SorobanInvokeTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));
vi.mock("../backend/tools/X402PaymentTool", () => ({
  X402PaymentTool: vi.fn().mockImplementation(() => ({ respond: vi.fn() })),
}));
vi.mock("../backend/tools/AccountInfoTool", () => ({
  AccountInfoTool: vi.fn().mockImplementation(() => ({ fetch: vi.fn() })),
}));
vi.mock("../backend/tools/TrustlineTool", () => ({
  TrustlineTool: vi.fn().mockImplementation(() => ({ execute: vi.fn(), checkTrustline: vi.fn() })),
}));
vi.mock("../backend/tools/MultiSigPaymentTool", () => ({
  MultiSigPaymentTool: vi.fn().mockImplementation(() => ({ execute: vi.fn() })),
}));

vi.mock("../backend/rpc_client", () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  simulateSorobanTx: vi.fn(),
  prepareSorobanTx: vi.fn(),
  horizonServer: { payments: mockPayments },
  sorobanServer: {},
  resolveNetworkPassphrase: vi.fn(() => "Test SDF Network ; September 2015"),
}));

vi.mock("../backend/config", () => ({
  config: {
    STELLAR_NETWORK: "testnet",
    HORIZON_URL: "https://horizon-testnet.stellar.org",
    SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    AGENT_PUBLIC_KEY: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    X402_ASSET_CODE: "USDC",
    X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 100,
    AGENT_SPENDING_LIMIT: "100",
    agentKeypair: () => ({ secret: () => "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73" }),
  },
  MAINNET_SPENDING_CAP: 10_000,
}));

import { PayFiAgent } from "../backend/agent";

describe("PayFiAgent — stream (issue #107)", () => {
  let agent: PayFiAgent;

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-setup default return since clearAllMocks resets implementations
    mockStream.mockReturnValue(mockStopStream);
    mockForAccount.mockReturnValue({ stream: mockStream });
    mockPayments.mockReturnValue({ forAccount: mockForAccount });
    agent = new PayFiAgent();
  });

  it("startListening calls horizonServer.payments().forAccount().stream()", () => {
    agent.startListening("https://example.com/resource", vi.fn());
    expect(mockPayments).toHaveBeenCalledOnce();
    expect(mockForAccount).toHaveBeenCalledWith("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
    expect(mockStream).toHaveBeenCalledOnce();
  });

  it("onChallenge is invoked when stream emits a valid x402 memo", () => {
    const onChallenge = vi.fn();

    // Override stream to simulate an incoming payment with a valid x402 memo
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (mockStream as any).mockImplementationOnce((opts: any) => {
      const challenge = {
        resource: "https://example.com/resource",
        amount: "1",
        assetCode: "USDC",
        assetIssuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        payTo: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        nonce: "550e8400-e29b-41d4-a716-446655440000",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      const encoded = Buffer.from(JSON.stringify(challenge)).toString("base64");
      opts.onmessage({ memo: `x402:${encoded}` });
      return mockStopStream;
    });

    agent.startListening("https://example.com/resource", onChallenge);
    expect(onChallenge).toHaveBeenCalledOnce();
    expect(onChallenge.mock.calls[0][0]).toMatchObject({ resource: "https://example.com/resource" });
  });

  it("stopListening calls the stream close function", () => {
    agent.startListening("https://example.com/resource", vi.fn());
    agent.stopListening();
    expect(mockStopStream).toHaveBeenCalledOnce();
  });

  it("stopListening inside destroy cleans up the stream", () => {
    agent.startListening("https://example.com/resource", vi.fn());
    expect(() => agent.destroy()).not.toThrow();
    expect(mockStopStream).toHaveBeenCalledOnce();
  });

  it("calling startListening twice does not open a second stream", () => {
    agent.startListening("https://example.com/resource", vi.fn());
    agent.startListening("https://example.com/resource", vi.fn());
    expect(mockStream).toHaveBeenCalledOnce(); // only one stream opened
  });
});
