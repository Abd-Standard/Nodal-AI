/**
 * tests/inflation.test.ts
 * Tests for InflationTool — SET_OPTIONS wrapper for the inflation destination.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { InflationTool } from "../backend/tools/InflationTool";
import * as rpcClient from "../backend/rpc_client";

vi.mock("../backend/rpc_client", () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  horizonServer: {},
  sorobanServer: {},
  resolveNetworkPassphrase: vi.fn(() => "Test SDF Network ; September 2015"),
}));

vi.mock("../backend/config", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Keypair } = require("@stellar/stellar-sdk");
  const secret = "SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X";
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

const TEST_SECRET = "SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X";
const INFLATION_DEST = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function makeMockAccount(inflationDestination: string | null = null) {
  const publicKey = Keypair.fromSecret(TEST_SECRET).publicKey();
  return {
    accountId: () => publicKey,
    sequenceNumber: () => "100",
    incrementSequenceNumber: vi.fn(),
    sequence: "100",
    incrementedSequenceNumber: () => "101",
    thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
    flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
    balances: [{ asset_type: "native", balance: "100.0000000" }],
    signers: [],
    data_attr: {},
    subentry_count: 0,
    inflation_destination: inflationDestination,
  };
}

describe("InflationTool", () => {
  let tool: InflationTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new InflationTool(TEST_SECRET);
    vi.mocked(rpcClient.submitTransaction).mockResolvedValue({ hash: "inflation_hash", ledger: 7 } as any);
  });

  describe("set", () => {
    it("submits a setOptions operation with the inflation destination", async () => {
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount() as any);
      const result = await tool.execute({ action: "set", inflationDestination: INFLATION_DEST });

      expect(result).toEqual({
        action: "set",
        txHash: "inflation_hash",
        ledger: 7,
        inflationDestination: INFLATION_DEST,
      });
      expect(rpcClient.submitTransaction).toHaveBeenCalledOnce();

      const submittedTx = vi.mocked(rpcClient.submitTransaction).mock.calls[0]![0];
      const op = submittedTx.operations[0] as any;
      expect(op.type).toBe("setOptions");
      expect(op.inflationDest).toBe(INFLATION_DEST);
    });

    it("rejects an invalid inflation destination", async () => {
      await expect(
        tool.execute({ action: "set", inflationDestination: "SHORT" })
      ).rejects.toThrow(/Invalid inflation destination/);
      expect(rpcClient.submitTransaction).not.toHaveBeenCalled();
    });

    it("rejects a syntactically invalid 56-character inflation destination", async () => {
      await expect(
        tool.execute({ action: "set", inflationDestination: "G" + "A".repeat(55) })
      ).rejects.toThrow(/valid Stellar public key/i);
    });

    it("propagates submission errors", async () => {
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount() as any);
      vi.mocked(rpcClient.submitTransaction).mockRejectedValue(new Error("op_not_supported"));
      await expect(
        tool.execute({ action: "set", inflationDestination: INFLATION_DEST })
      ).rejects.toThrow("op_not_supported");
    });
  });

  describe("get", () => {
    it("returns the inflation destination when set", async () => {
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount(INFLATION_DEST) as any);
      const result = await tool.execute({ action: "get" });

      expect(result).toEqual({
        action: "get",
        accountId: Keypair.fromSecret(TEST_SECRET).publicKey(),
        inflationDestination: INFLATION_DEST,
        isSet: true,
      });
      expect(rpcClient.submitTransaction).not.toHaveBeenCalled();
    });

    it("returns null when no inflation destination is set", async () => {
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount(null) as any);
      const result = await tool.execute({ action: "get" });

      expect(result).toMatchObject({ action: "get", isSet: false, inflationDestination: null });
    });

    it("queries a custom accountId when provided", async () => {
      const customKey = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount(INFLATION_DEST) as any);

      const result = await tool.execute({ action: "get", accountId: customKey });

      expect(rpcClient.loadAccount).toHaveBeenCalledWith(customKey);
      expect(result).toMatchObject({ action: "get", accountId: customKey });
    });

    it("rejects an invalid accountId", async () => {
      await expect(tool.execute({ action: "get", accountId: "SHORT" })).rejects.toThrow(
        /Invalid Stellar public key/
      );
    });
  });
});
