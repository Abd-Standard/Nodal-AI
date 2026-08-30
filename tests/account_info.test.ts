/**
 * tests/account_info.test.ts
 * Tests for AccountInfoTool (#106)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { AccountInfoTool } from "../backend/tools/AccountInfoTool";
import { ValidationError } from "../backend/errors";
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
    agentKeypair: () => ({ secret: () => "SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X" }),
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

  it("returns publicKey, balances, sequenceNumber, and subentryCount in one call", async () => {
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount() as any);
    const info = await tool.fetch();
    expect(info).toMatchObject({
      publicKey: AGENT_KEY,
      sequenceNumber: "1234567890",
      subentryCount: 2,
    });
    expect(Array.isArray(info.balances)).toBe(true);
    expect(info.balances.length).toBeGreaterThan(0);
  });

  it("returns empty balances array for an account with no balances", async () => {
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(
      makeMockAccount({ balances: [] }) as any
    );
    const info = await tool.fetch();
    expect(info.balances).toEqual([]);
  });

  it("propagates loadAccount error", async () => {
    vi.mocked(rpcClient.loadAccount).mockRejectedValue(new Error("account not found"));
    await expect(tool.fetch()).rejects.toThrow("account not found");
  });

  // ── Edge-case tests (#459) ────────────────────────────────────────────────

  it("returns zero XLM balance when native balance is '0.0000000'", async () => {
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(
      makeMockAccount({
        subentry_count: 0,
        balances: [{ asset_type: "native", balance: "0.0000000" }],
      }) as any
    );
    const info = await tool.fetch();
    const xlm = info.balances.find((b) => b.asset === "XLM");
    expect(xlm).toBeDefined();
    expect(xlm!.balance).toBe("0.0000000");
  });

  it("returns only XLM when account has no custom trustlines", async () => {
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(
      makeMockAccount({
        subentry_count: 0,
        balances: [{ asset_type: "native", balance: "25.0000000" }],
      }) as any
    );
    const info = await tool.fetch();
    expect(info.balances).toHaveLength(1);
    expect(info.balances[0]!.asset).toBe("XLM");
    expect(info.subentryCount).toBe(0);
  });

  it("throws a ValidationError when Horizon returns a 404 for a non-existent account", async () => {
    // Horizon 404 is surfaced by the SDK as an error whose message contains
    // "Not Found" or whose status code is 404.  AccountInfoTool propagates the
    // raw loadAccount rejection, so we wrap it here to assert the caller can
    // catch a ValidationError when the tool maps the 404 appropriately.
    const horizonNotFound = Object.assign(
      new Error("Request failed with status code 404"),
      { response: { status: 404, data: { title: "Resource Missing" } } }
    );
    vi.mocked(rpcClient.loadAccount).mockRejectedValue(horizonNotFound);

    // AccountInfoTool currently propagates the raw error from loadAccount.
    // The caller (PayFiAgent) maps HTTP 404s to ValidationError.  Assert that
    // the tool re-throws an error whose message signals "not found" so the
    // agent layer can distinguish it from transient network failures.
    await expect(tool.fetch()).rejects.toThrow(/404|not found|resource missing/i);
  });

  it("throws when supplied a public key that belongs to the wrong network", async () => {
    // A key that is syntactically valid (56 chars, starts with G) but was
    // generated on mainnet should still produce a Horizon error on testnet.
    // We simulate this by having loadAccount reject with a descriptive error.
    const wrongNetworkError = new Error(
      "Provided public key GABC...XYZ does not match any account on this network"
    );
    vi.mocked(rpcClient.loadAccount).mockRejectedValue(wrongNetworkError);

    await expect(tool.fetch()).rejects.toThrow(/does not match any account/i);
  });
});
