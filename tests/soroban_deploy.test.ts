/**
 * tests/soroban_deploy.test.ts
 *
 * Tests for SorobanDeployTool and soroban_deploy agent task.
 * Covers: upload, instantiate, deploy flow, schema validation, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SorobanDeployTool, SorobanDeployInputSchema } from "../backend/tools/SorobanDeployTool";
import * as rpcClient from "../backend/rpc_client";
import { ValidationError } from "../backend/errors";
import { PayFiAgent } from "../backend/agent";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockUploadContractWasm = vi.fn();
const mockCreateContractFromWasm = vi.fn();

vi.mock("../backend/rpc_client", () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  horizonServer: {},
  sorobanServer: {
    uploadContractWasm: (...args: any[]) => mockUploadContractWasm(...args),
    createContractFromWasm: (...args: any[]) => mockCreateContractFromWasm(...args),
  },
  simulateSorobanTx: vi.fn(),
  prepareSorobanTx: vi.fn(),
  resolveNetworkPassphrase: vi.fn(() => "Test SDF Network ; September 2015"),
}));

vi.mock("../backend/persistence", () => ({
  saveResult: vi.fn(),
  loadRecentSpend: vi.fn().mockReturnValue(0),
}));

vi.mock("../backend/webhook", () => ({
  dispatchWebhook: vi.fn(),
}));

vi.mock("../backend/config", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Keypair } = require("@stellar/stellar-sdk");
  const secret = Keypair.random().secret();
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
      QUEUE_CAPACITY: 10,
      MAX_CONCURRENT_TASKS: 5,
      agentKeypair: () => Keypair.fromSecret(secret),
    },
  };
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const MOCK_WASM_BUFFER = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const MOCK_WASM_HASH = "a1b2c3d4e5f67890123456789abcdef0123456789abcdef0123456789abcdef0";
const MOCK_CONTRACT_ID = "CDPVBHPSVYKWSI5ECEA4DASBG3RBNU5EHEE3DHNFX7RMBCZV66CSC7NH";

describe("SorobanDeployTool", () => {
  let tool: SorobanDeployTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new SorobanDeployTool();
    mockUploadContractWasm.mockResolvedValue(MOCK_WASM_HASH);
    mockCreateContractFromWasm.mockResolvedValue(MOCK_CONTRACT_ID);
  });

  // ── Upload ──────────────────────────────────────────────────────────────────

  describe("upload action", () => {
    it("uploads WASM buffer and returns the WASM hash", async () => {
      const result = await tool.execute({
        action: "upload",
        wasm: MOCK_WASM_BUFFER,
      });

      expect(mockUploadContractWasm).toHaveBeenCalledWith(MOCK_WASM_BUFFER);
      expect(result.action).toBe("upload");
      expect(result.wasmHash).toBe(MOCK_WASM_HASH);
    });

    it("accepts wasmBuffer field as alternative to wasm", async () => {
      const result = await tool.execute({
        action: "upload",
        wasmBuffer: MOCK_WASM_BUFFER,
      });

      expect(mockUploadContractWasm).toHaveBeenCalledWith(MOCK_WASM_BUFFER);
      expect(result.wasmHash).toBe(MOCK_WASM_HASH);
    });

    it("accepts hex string for WASM bytecode", async () => {
      const hex = MOCK_WASM_BUFFER.toString("hex");
      const result = await tool.execute({
        action: "upload",
        wasm: hex,
      });

      expect(mockUploadContractWasm).toHaveBeenCalledWith(MOCK_WASM_BUFFER);
      expect(result.wasmHash).toBe(MOCK_WASM_HASH);
    });

    it("handles uploadContractWasm returning an object { wasmHash }", async () => {
      mockUploadContractWasm.mockResolvedValueOnce({ wasmHash: MOCK_WASM_HASH });
      const result = await tool.execute({
        action: "upload",
        wasm: MOCK_WASM_BUFFER,
      });

      expect(result.wasmHash).toBe(MOCK_WASM_HASH);
    });

    it("throws ValidationError when wasm bytecode is missing", async () => {
      await expect(
        tool.execute({
          action: "upload",
        })
      ).rejects.toThrow(ValidationError);
    });
  });

  // ── Instantiate ─────────────────────────────────────────────────────────────

  describe("instantiate action", () => {
    it("instantiates a contract from WASM hash and returns contract ID", async () => {
      const result = await tool.execute({
        action: "instantiate",
        wasmHash: MOCK_WASM_HASH,
      });

      expect(mockCreateContractFromWasm).toHaveBeenCalledWith(MOCK_WASM_HASH);
      expect(result.action).toBe("instantiate");
      expect(result.contractId).toBe(MOCK_CONTRACT_ID);
    });

    it("handles createContractFromWasm returning an object { contractId }", async () => {
      mockCreateContractFromWasm.mockResolvedValueOnce({ contractId: MOCK_CONTRACT_ID });
      const result = await tool.execute({
        action: "instantiate",
        wasmHash: MOCK_WASM_HASH,
      });

      expect(result.contractId).toBe(MOCK_CONTRACT_ID);
    });

    it("throws ValidationError when wasmHash is missing", async () => {
      await expect(
        tool.execute({
          action: "instantiate",
        })
      ).rejects.toThrow(ValidationError);
    });
  });

  // ── Deploy ──────────────────────────────────────────────────────────────────

  describe("deploy action", () => {
    it("chains upload and instantiate in sequence and returns both wasmHash and contractId", async () => {
      const result = await tool.execute({
        action: "deploy",
        wasm: MOCK_WASM_BUFFER,
      });

      expect(mockUploadContractWasm).toHaveBeenCalledWith(MOCK_WASM_BUFFER);
      expect(mockCreateContractFromWasm).toHaveBeenCalledWith(MOCK_WASM_HASH);
      expect(result.action).toBe("deploy");
      expect(result.wasmHash).toBe(MOCK_WASM_HASH);
      expect(result.contractId).toBe(MOCK_CONTRACT_ID);
    });

    it("propagates error if upload step fails during deploy", async () => {
      mockUploadContractWasm.mockRejectedValueOnce(new Error("Soroban RPC upload error"));

      await expect(
        tool.execute({
          action: "deploy",
          wasm: MOCK_WASM_BUFFER,
        })
      ).rejects.toThrow("Soroban RPC upload error");

      expect(mockCreateContractFromWasm).not.toHaveBeenCalled();
    });

    it("propagates error if instantiate step fails during deploy", async () => {
      mockCreateContractFromWasm.mockRejectedValueOnce(new Error("Soroban RPC instantiate error"));

      await expect(
        tool.execute({
          action: "deploy",
          wasm: MOCK_WASM_BUFFER,
        })
      ).rejects.toThrow("Soroban RPC instantiate error");
    });
  });

  // ── Schema validation ───────────────────────────────────────────────────────

  describe("schema validation", () => {
    it("rejects unknown action", () => {
      const parsed = SorobanDeployInputSchema.safeParse({
        action: "invalid_action",
      });
      expect(parsed.success).toBe(false);
    });
  });

  // ── PayFiAgent Integration ──────────────────────────────────────────────────

  describe("PayFiAgent integration", () => {
    it("executes soroban_deploy task through agent.run()", async () => {
      const agent = new PayFiAgent();
      const result = await agent.run({
        type: "soroban_deploy",
        payload: {
          action: "deploy",
          wasm: MOCK_WASM_BUFFER,
        },
      });

      expect(result.success).toBe(true);
      expect(result.taskType).toBe("soroban_deploy");
      expect(result.data).toMatchObject({
        action: "deploy",
        wasmHash: MOCK_WASM_HASH,
        contractId: MOCK_CONTRACT_ID,
      });

      agent.destroy();
    });
  });
});
