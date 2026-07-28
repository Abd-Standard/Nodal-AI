/**
 * tests/soroban_query.test.ts
 *
 * Test suite for SorobanQueryTool.
 *
 * Covers: simulation gate, never-broadcast invariant, success path,
 * invalid contractId, empty method string, and simulation error propagation.
 *
 * ## Mock Architecture
 * Follows tests/soroban_invoke.test.ts:
 * - ../backend/rpc_client is fully mocked — no network calls.
 * - ../backend/config is mocked with predictable test credentials.
 * - sorobanServer.sendTransaction is asserted to NEVER be called.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SorobanQueryTool } from "../backend/tools/SorobanQueryTool";
import * as rpcClient from "../backend/rpc_client";

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("../backend/rpc_client", () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  simulateSorobanTx: vi.fn(),
  prepareSorobanTx: vi.fn(),
  horizonServer: {},
  sorobanServer: {
    sendTransaction: vi.fn(),
    getTransaction: vi.fn(),
  },
  resolveNetworkPassphrase: vi.fn(() => "Test SDF Network ; September 2015"),
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
      X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      MAX_RETRIES: 3,
      RETRY_DELAY_MS: 100,
      RPC_TIMEOUT_MS: 5000,
    },
  };
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

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
    flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
    balances: [],
    signers: [],
    data_attr: {},
    subentry_count: 0,
  };
}

const MOCK_SIMULATION_RESULT = { sign: vi.fn(), toEnvelope: vi.fn() };

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SorobanQueryTool", () => {
  let tool: SorobanQueryTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new SorobanQueryTool();
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(
      makeMockAccount("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5") as any
    );
  });

  it("calls prepareSorobanTx (simulation gate is respected)", async () => {
    vi.mocked(rpcClient.prepareSorobanTx).mockResolvedValue(MOCK_SIMULATION_RESULT as any);

    await tool.query({ contractId: VALID_CONTRACT, method: "get_state", args: [] });

    expect(rpcClient.prepareSorobanTx).toHaveBeenCalledOnce();
  });

  it("never calls sorobanServer.sendTransaction", async () => {
    vi.mocked(rpcClient.prepareSorobanTx).mockResolvedValue(MOCK_SIMULATION_RESULT as any);

    await tool.query({ contractId: VALID_CONTRACT, method: "get_state", args: [] });

    expect(rpcClient.sorobanServer.sendTransaction).not.toHaveBeenCalled();
  });

  it("returns simulationResult on success", async () => {
    vi.mocked(rpcClient.prepareSorobanTx).mockResolvedValue(MOCK_SIMULATION_RESULT as any);

    const result = await tool.query({ contractId: VALID_CONTRACT, method: "get_state", args: [] });

    expect(result).toHaveProperty("simulationResult");
    expect(result.simulationResult).toBe(MOCK_SIMULATION_RESULT);
  });

  it("throws on invalid contractId (not 56 chars)", async () => {
    await expect(
      tool.query({ contractId: "BAD_CONTRACT_ID", method: "get_state", args: [] })
    ).rejects.toThrow(/Invalid Stellar contract ID/);

    // Simulation should never be reached for invalid input
    expect(rpcClient.prepareSorobanTx).not.toHaveBeenCalled();
  });

  it("throws on empty method string", async () => {
    await expect(
      tool.query({ contractId: VALID_CONTRACT, method: "", args: [] })
    ).rejects.toThrow();

    // Simulation should never be reached for invalid input
    expect(rpcClient.prepareSorobanTx).not.toHaveBeenCalled();
  });

  it("propagates simulation errors", async () => {
    vi.mocked(rpcClient.prepareSorobanTx).mockRejectedValue(
      new Error("Soroban simulation failed: contract error #5")
    );

    await expect(
      tool.query({ contractId: VALID_CONTRACT, method: "get_state", args: [] })
    ).rejects.toThrow(/simulation failed/);

    // sendTransaction must still never be called even when simulation throws
    expect(rpcClient.sorobanServer.sendTransaction).not.toHaveBeenCalled();
  });
});
