import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { SorobanQueryTool, SorobanQueryInputSchema } from "../backend/tools/SorobanQueryTool";
import * as rpcClient from "../backend/rpc_client";

vi.mock("../backend/rpc_client", () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  simulateSorobanTx: vi.fn(),
  prepareSorobanTx: vi.fn(),
  resolveNetworkPassphrase: vi.fn(() => "Test SDF Network ; September 2015"),
  horizonServer: {},
  sorobanServer: {
    sendTransaction: vi.fn(),
    getTransaction: vi.fn(),
  },
}));

vi.mock("../backend/config", () => {
  const { Keypair } = require("@stellar/stellar-sdk");
  const secret = "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73";
  return {
    config: {
      STELLAR_NETWORK: "testnet",
      HORIZON_URL: "https://horizon-testnet.stellar.org",
      SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
      AGENT_SECRET_KEY: secret,
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      agentKeypair: () => Keypair.fromSecret(secret),
      X402_ASSET_CODE: "USDC",
      X402_ASSET_ISSUER:
        "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      MAX_RETRIES: 3,
      RETRY_DELAY_MS: 100,
    },
  };
});

const VALID_CONTRACT = "CDPVBHPSVYKWSI5ECEA4DASBG3RBNU5EHEE3DHNFX7RMBCZV66CSC7NH";

function makeMockAccount(publicKey: string) {
  return {
    id: publicKey,
    accountId: () => publicKey,
    sequenceNumber: () => "100",
    incrementSequenceNumber: vi.fn(),
    sequence: "100",
    incrementedSequenceNumber: () => "101",
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: {
      auth_required: false,
      auth_revocable: false,
      auth_immutable: false,
    },
    balances: [],
    signers: [],
    data_attr: {},
    subentry_count: 0,
  };
}

describe("SorobanQueryTool", () => {
  let tool: SorobanQueryTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new SorobanQueryTool();
  });

  describe("Successful query", () => {
    it("returns parsed ScVal from simulation result", async () => {
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(
        makeMockAccount("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5") as any,
      );

      const expectedScVal = nativeToScVal(42, { type: "u32" });

      vi.mocked(rpcClient.prepareSorobanTx as any).mockResolvedValue(expectedScVal);

      const result = await tool.query({
        contractId: VALID_CONTRACT,
        method: "balance",
        args: [],
      });

      expect(result.simulationResult).toBe(expectedScVal);
    });
  });

  describe("Simulation failure", () => {
    it("propagates simulation error", async () => {
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(
        makeMockAccount("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5") as any,
      );

      vi.mocked(rpcClient.prepareSorobanTx as any).mockRejectedValue(
        new Error("Soroban query failed: Contract error: insufficient balance"),
      );

      await expect(
        tool.query({
          contractId: VALID_CONTRACT,
          method: "balance",
          args: [],
        }),
      ).rejects.toThrow(/Soroban query failed/);
    });
  });
});
