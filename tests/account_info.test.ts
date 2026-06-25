/**
 * tests/account_info.test.ts
 * Tests for AccountInfoTool (#106)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AccountInfoTool } from "../backend/tools/AccountInfoTool";
import * as rpcClient from "../backend/rpc_client";

vi.mock("../backend/rpc_client", () => ({
  loadAccount: vi.fn(),
  horizonServer: {},
  sorobanServer: {},
  submitTransaction: vi.fn(),
  simulateSorobanTx: vi.fn(),
  prepareSorobanTx: vi.fn(),
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
}));

const AGENT_KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function makeMockAccount(overrides: Partial<any> = {}) {
  return {
    accountId: () => AGENT_KEY,
    sequenceNumber: () => "1234567890",
    subentry_count: 2,
    balances: [
      { asset_type: "native", balance: "100.0000000" },
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        balance: "50.0000000",
      },
    ],
    ...overrides,
  };
}

describe("AccountInfoTool", () => {
  let tool: AccountInfoTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new AccountInfoTool();
  });

  it("returns AccountInfo with correct publicKey", async () => {
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount() as any);
    const info = await tool.fetch();
    expect(info.publicKey).toBe(AGENT_KEY);
  });

  it("maps native balance to 'XLM'", async () => {
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount() as any);
    const info = await tool.fetch();
    const xlm = info.balances.find((b) => b.asset === "XLM");
    expect(xlm).toBeDefined();
    expect(xlm!.balance).toBe("100.0000000");
  });

  it("maps non-native balance to 'CODE:ISSUER' format", async () => {
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount() as any);
    const info = await tool.fetch();
    const usdc = info.balances.find((b) => b.asset.startsWith("USDC:"));
    expect(usdc).toBeDefined();
    expect(usdc!.balance).toBe("50.0000000");
  });

  it("returns correct sequenceNumber", async () => {
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount() as any);
    const info = await tool.fetch();
    expect(info.sequenceNumber).toBe("1234567890");
  });

  it("returns correct subentryCount", async () => {
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount() as any);
    const info = await tool.fetch();
    expect(info.subentryCount).toBe(2);
  });

  it("propagates loadAccount error", async () => {
    vi.mocked(rpcClient.loadAccount).mockRejectedValue(new Error("account not found"));
    await expect(tool.fetch()).rejects.toThrow("account not found");
  });
});
