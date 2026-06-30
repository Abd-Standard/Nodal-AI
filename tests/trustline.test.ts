/**
 * tests/trustline.test.ts
 * Tests for TrustlineTool (#105)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { TrustlineTool } from "../backend/tools/TrustlineTool";
import * as rpcClient from "../backend/rpc_client";

vi.mock("../backend/rpc_client", () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  horizonServer: {},
  sorobanServer: {},
  simulateSorobanTx: vi.fn(),
  prepareSorobanTx: vi.fn(),
  resolveNetworkPassphrase: vi.fn(() => "Test SDF Network ; September 2015"),
}));

vi.mock("../backend/config", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Keypair } = require("@stellar/stellar-sdk");
  const secret = "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73";
  return {
    config: {
      STELLAR_NETWORK: "testnet",
      HORIZON_URL: "https://horizon-testnet.stellar.org",
      SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      X402_ASSET_CODE: "USDC",
      X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      MAX_RETRIES: 3,
      RETRY_DELAY_MS: 100,
      AGENT_SPENDING_LIMIT: "100",
      agentKeypair: () => Keypair.fromSecret(secret),
    },
  };
});

const TEST_SECRET = "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73";
const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function makeMockAccount(hasUsdc = false) {
  const { Keypair } = require("@stellar/stellar-sdk");
  const publicKey = Keypair.fromSecret(TEST_SECRET).publicKey();
  return {
    accountId: () => publicKey,
    sequenceNumber: () => "100",
    incrementSequenceNumber: vi.fn(),
    sequence: "100",
    incrementedSequenceNumber: () => "101",
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
    balances: [
      { asset_type: "native", balance: "100.0000000" },
      ...(hasUsdc
        ? [{ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: "0.0000000" }]
        : []),
    ],
    signers: [],
    data_attr: {},
    subentry_count: hasUsdc ? 1 : 0,
    home_domain: "",
    inflation_dest: null,
  };
}

describe("TrustlineTool", () => {
  let tool: TrustlineTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new TrustlineTool(TEST_SECRET);
    vi.mocked(rpcClient.submitTransaction).mockResolvedValue({ hash: "trust_hash", ledger: 5 } as any);
  });

  it("add trustline submits changeTrust operation and returns txHash", async () => {
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount() as any);
    const result = await tool.execute({ assetCode: "USDC", assetIssuer: ISSUER, action: "add" });
    expect(result.txHash).toBe("trust_hash");
    expect(rpcClient.submitTransaction).toHaveBeenCalledOnce();
  });

  it("remove trustline submits changeTrust with limit '0'", async () => {
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount(true) as any);
    const result = await tool.execute({ assetCode: "USDC", assetIssuer: ISSUER, action: "remove" });
    expect(result.txHash).toBe("trust_hash");
  });

  it("add trustline with custom limit", async () => {
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount() as any);
    const result = await tool.execute({
      assetCode: "USDC",
      assetIssuer: ISSUER,
      action: "add",
      limit: "1000",
    });
    expect(result.txHash).toBe("trust_hash");
  });

  it("checkTrustline returns true when trustline exists", async () => {
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount(true) as any);
    const exists = await tool.checkTrustline("USDC", ISSUER);
    expect(exists).toBe(true);
  });

  it("checkTrustline returns false when trustline does not exist", async () => {
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount(false) as any);
    const exists = await tool.checkTrustline("USDC", ISSUER);
    expect(exists).toBe(false);
  });

  it("rejects invalid assetIssuer length", async () => {
    await expect(
      tool.execute({ assetCode: "USDC", assetIssuer: "SHORT", action: "add" })
    ).rejects.toThrow(/Invalid asset issuer/);
  });

  it("propagates submission error", async () => {
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount() as any);
    vi.mocked(rpcClient.submitTransaction).mockRejectedValue(new Error("op_low_reserve"));
    await expect(
      tool.execute({ assetCode: "USDC", assetIssuer: ISSUER, action: "add" })
    ).rejects.toThrow("op_low_reserve");
  });
});
