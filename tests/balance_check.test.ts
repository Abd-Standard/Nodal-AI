/**
 * tests/balance_check.test.ts
 *
 * Tests for BalanceCheckTool — covers input validation, balance filtering,
 * and network error propagation.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { BalanceCheckTool } from "../backend/tools/BalanceCheckTool";
import * as rpcClient from "../backend/rpc_client";

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock("../backend/rpc_client", () => ({
  loadAccount: vi.fn(),
  horizonServer: {},
  submitTransaction: vi.fn(),
  sorobanServer: {},
  simulateSorobanTx: vi.fn(),
  prepareSorobanTx: vi.fn(),
}));

vi.mock("../backend/config", () => ({
  config: {
    STELLAR_NETWORK: "testnet",
    HORIZON_URL: "https://horizon-testnet.stellar.org",
    SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    X402_ASSET_CODE: "USDC",
    X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 100,
    agentKeypair: () => ({ secret: () => "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73" }),
  },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const VALID_KEY    = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const VALID_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

const MOCK_BALANCES = [
  { asset_type: "native", balance: "100.0000000" },
  {
    asset_type: "credit_alphanum4",
    asset_code: "USDC",
    asset_issuer: VALID_ISSUER,
    balance: "50.0000000",
  },
  {
    asset_type: "credit_alphanum4",
    asset_code: "EURC",
    asset_issuer: VALID_ISSUER,
    balance: "25.0000000",
  },
];

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("BalanceCheckTool", () => {
  let tool: BalanceCheckTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new BalanceCheckTool();
    vi.mocked(rpcClient.loadAccount).mockResolvedValue({ balances: MOCK_BALANCES } as any);
  });

  // ── Input validation ────────────────────────────────────────────────────────

  describe("Input validation", () => {
    it("rejects a public key that is too short", async () => {
      await expect(tool.getBalance({ publicKey: "GABC123" })).rejects.toThrow(
        /Invalid Stellar public key/
      );
    });

    it("rejects a public key that is too long", async () => {
      await expect(
        tool.getBalance({ publicKey: "G".padEnd(57, "A") })
      ).rejects.toThrow(/Invalid Stellar public key/);
    });

    it("rejects an assetIssuer that is not 56 chars", async () => {
      await expect(
        tool.getBalance({ publicKey: VALID_KEY, assetCode: "USDC", assetIssuer: "TOOSHORT" })
      ).rejects.toThrow(/Invalid asset issuer address/);
    });

    it("accepts a valid public key with no optional fields", async () => {
      await expect(tool.getBalance({ publicKey: VALID_KEY })).resolves.toBeDefined();
    });
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  describe("Happy path", () => {
    it("returns the publicKey in the result", async () => {
      const result = await tool.getBalance({ publicKey: VALID_KEY });
      expect(result.publicKey).toBe(VALID_KEY);
    });

    it("returns all balances when no assetCode filter is given", async () => {
      const result = await tool.getBalance({ publicKey: VALID_KEY });
      expect(result.balances).toHaveLength(3);
    });

    it("filters to XLM only when assetCode is XLM", async () => {
      const result = await tool.getBalance({ publicKey: VALID_KEY, assetCode: "XLM" });
      expect(result.balances).toHaveLength(1);
      expect(result.balances[0]!).toBeDefined();
      expect(result.balances[0]!.assetType).toBe("native");
    });

    it("filters to a specific non-native asset by assetCode", async () => {
      const result = await tool.getBalance({ publicKey: VALID_KEY, assetCode: "USDC" });
      expect(result.balances).toHaveLength(1);
      expect(result.balances[0]!).toBeDefined();
      expect(result.balances[0]!.assetCode).toBe("USDC");
    });

    it("further filters by assetIssuer when provided", async () => {
      const result = await tool.getBalance({
        publicKey: VALID_KEY,
        assetCode: "USDC",
        assetIssuer: VALID_ISSUER,
      });
      expect(result.balances).toHaveLength(1);
      expect(result.balances[0]!).toBeDefined();
      expect(result.balances[0]!.assetIssuer).toBe(VALID_ISSUER);
    });

    it("returns an empty array when filtered asset is not held", async () => {
      const result = await tool.getBalance({ publicKey: VALID_KEY, assetCode: "BTC" });
      expect(result.balances).toHaveLength(0);
    });

    it("maps assetCode and assetIssuer as undefined for native balance", async () => {
      const result = await tool.getBalance({ publicKey: VALID_KEY, assetCode: "XLM" });
      expect(result.balances[0]!).toBeDefined();
      expect(result.balances[0]!.assetCode).toBeUndefined();
      expect(result.balances[0]!.assetIssuer).toBeUndefined();
    });

    it("calls loadAccount with the provided public key", async () => {
      await tool.getBalance({ publicKey: VALID_KEY });
      expect(rpcClient.loadAccount).toHaveBeenCalledOnce();
      expect(rpcClient.loadAccount).toHaveBeenCalledWith(VALID_KEY);
    });
  });

  // ── Network error handling ──────────────────────────────────────────────────

  describe("Network error handling", () => {
    it("propagates account not found error", async () => {
      vi.mocked(rpcClient.loadAccount).mockRejectedValue(
        new Error("Horizon: account not found (404)")
      );
      await expect(tool.getBalance({ publicKey: VALID_KEY })).rejects.toThrow(
        /account not found/
      );
    });

    it("propagates a generic network error", async () => {
      vi.mocked(rpcClient.loadAccount).mockRejectedValue(
        new Error("503 Service Unavailable")
      );
      await expect(tool.getBalance({ publicKey: VALID_KEY })).rejects.toThrow(/503/);
    });
  });
});
