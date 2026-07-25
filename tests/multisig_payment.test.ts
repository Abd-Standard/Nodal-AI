/**
 * tests/multisig_payment.test.ts
 * Tests for MultiSigPaymentTool (#108)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { MultiSigPaymentTool } from "../backend/tools/MultiSigPaymentTool";
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
const DEST = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const SIGNER2 = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZUK9AI4WDCBAHD9HTPFE7";
const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function makeMockAccount() {
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
    balances: [{ asset_type: "native", balance: "10000.0000000" }],
    signers: [],
    data_attr: {},
    subentry_count: 0,
    home_domain: "",
    inflation_dest: null,
  };
}

describe("MultiSigPaymentTool", () => {
  let tool: MultiSigPaymentTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new MultiSigPaymentTool(TEST_SECRET);
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount() as any);
  });

  it("returns unsigned XDR when no signatures provided", async () => {
    const result = await tool.execute({
      destination: DEST,
      amount: "100",
      assetCode: "XLM",
      additionalSigners: [SIGNER2],
      minSignatures: 2,
    });
    expect(result.unsignedXDR).toBeDefined();
    expect(typeof result.unsignedXDR).toBe("string");
    expect(result.txHash).toBeUndefined();
  });

  it("unsigned XDR is valid base64-encoded XDR (non-empty)", async () => {
    const result = await tool.execute({
      destination: DEST,
      amount: "50",
      assetCode: "XLM",
      additionalSigners: [SIGNER2],
      minSignatures: 2,
    });
    // Valid XDR can be decoded from base64
    expect(() => Buffer.from(result.unsignedXDR!, "base64")).not.toThrow();
    expect(result.unsignedXDR!.length).toBeGreaterThan(50);
  });

  it("submits and returns txHash when sufficient signatures provided", async () => {
    vi.mocked(rpcClient.submitTransaction).mockResolvedValue({ hash: "multisig_hash", ledger: 10 } as any);
    const result = await tool.execute({
      destination: DEST,
      amount: "100",
      assetCode: "XLM",
      additionalSigners: [SIGNER2],
      minSignatures: 1,
      signatures: ["sig1"],
    });
    expect(result.txHash).toBe("multisig_hash");
    expect(result.ledger).toBe(10);
  });

  it("throws when minSignatures exceeds total available signers", async () => {
    await expect(
      tool.execute({
        destination: DEST,
        amount: "100",
        assetCode: "XLM",
        additionalSigners: [SIGNER2],
        minSignatures: 5, // only 2 signers (agent + SIGNER2)
      })
    ).rejects.toThrow(/minSignatures.*exceeds total available signers/);
  });

  it("throws when non-XLM asset has no issuer", async () => {
    await expect(
      tool.execute({
        destination: DEST,
        amount: "100",
        assetCode: "USDC",
        additionalSigners: [SIGNER2],
        minSignatures: 1,
      })
    ).rejects.toThrow(/Asset issuer is required/);
  });

  it("accepts custom asset with issuer and returns XDR", async () => {
    const result = await tool.execute({
      destination: DEST,
      amount: "100",
      assetCode: "USDC",
      assetIssuer: ISSUER,
      additionalSigners: [SIGNER2],
      minSignatures: 2,
    });
    expect(result.unsignedXDR).toBeDefined();
  });
});
