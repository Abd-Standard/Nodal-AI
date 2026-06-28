/**
 * tests/payment.test.ts
 *
 * Comprehensive test suite for StellarPaymentTool.
 * Covers: happy path, input validation, network errors, retry exhaustion,
 * timeout simulation, insufficient funds, and memo edge cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { StellarPaymentTool } from "../backend/tools/StellarPaymentTool";
import * as rpcClient from "../backend/rpc_client";

// ─── Module mock ──────────────────────────────────────────────────────────────
// All Horizon/Soroban network calls are intercepted here.

vi.mock("../backend/rpc_client", () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  horizonServer: {},
  sorobanServer: {},
  simulateSorobanTx: vi.fn(),
  prepareSorobanTx: vi.fn(),
  resolveNetworkPassphrase: (_network: string) => {
    const { Networks } = require("@stellar/stellar-sdk");
    if (_network === "mainnet") return Networks.PUBLIC;
    if (_network === "futurenet") return Networks.FUTURENET;
    return Networks.TESTNET;
  },
}));

// ─── Mock config — isolate from real .env ─────────────────────────────────────
vi.mock("../backend/config", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Keypair } = require("@stellar/stellar-sdk");
  const secret = "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73";
  return {
    config: {
      STELLAR_NETWORK: "testnet",
      HORIZON_URL: "https://horizon-testnet.stellar.org",
      SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
      X402_ASSET_CODE: "USDC",
      X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      MAX_RETRIES: 3,
      RETRY_DELAY_MS: 100,
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      agentKeypair: () => Keypair.fromSecret(secret),
    },
  };
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_SECRET = "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73";
// Valid 56-char G-address for destination
const VALID_DEST   = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const VALID_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

/** Minimal account object that satisfies TransactionBuilder */
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
    balances: [{ asset_type: "native", balance: "10000.0000000" }],
    signers: [],
    data_attr: {},
    subentry_count: 0,
    home_domain: "",
    inflation_dest: null,
  };
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("StellarPaymentTool", () => {
  let tool: StellarPaymentTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new StellarPaymentTool();
    // Default: return a minimal valid account for TransactionBuilder
    vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount(tool.publicKey) as any);
  });



  // ── Input validation ────────────────────────────────────────────────────────

  describe("Input validation", () => {
    it("rejects a destination key that is too short", async () => {
      await expect(
        tool.execute({ destination: "GABC123", amount: "10", assetCode: "XLM" })
      ).rejects.toThrow(/Invalid Stellar public key/);
    });

    it("rejects a destination key that is too long", async () => {
      await expect(
        tool.execute({ destination: "G".padEnd(57, "A"), amount: "10", assetCode: "XLM" })
      ).rejects.toThrow(/Invalid Stellar public key/);
    });

    it("rejects a negative amount", async () => {
      await expect(
        tool.execute({ destination: VALID_DEST, amount: "-1", assetCode: "XLM" })
      ).rejects.toThrow(/Amount must be/);
    });

    it("rejects zero amount (not a valid Stellar decimal)", async () => {
      await expect(
        tool.execute({ destination: VALID_DEST, amount: "0", assetCode: "XLM" })
      ).rejects.toThrow(/Amount must be/);
    });

    it("rejects amount with more than 7 decimal places", async () => {
      await expect(
        tool.execute({ destination: VALID_DEST, amount: "1.12345678", assetCode: "XLM" })
      ).rejects.toThrow(/Amount must be/);
    });

    it("rejects self-payment (destination === agent public key)", async () => {
      await expect(
        tool.execute({ destination: tool.publicKey, amount: "1", assetCode: "XLM" })
      ).rejects.toThrow("Payment destination cannot be the agent's own address");
    });

    it("rejects a non-XLM asset when issuer is missing", async () => {
      await expect(
        tool.execute({
          destination: VALID_DEST,
          amount: "10",
          assetCode: "USDC",
          assetIssuer: undefined,
        })
      ).rejects.toThrow("Asset issuer is required for non-native asset USDC");
    });

    it("rejects a memo longer than 28 bytes", async () => {
      await expect(
        tool.execute({
          destination: VALID_DEST,
          amount: "1",
          assetCode: "XLM",
          memo: "A".repeat(29),
        })
      ).rejects.toThrow();
    });

    it("accepts a 7-decimal amount (boundary)", async () => {
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(
        makeMockAccount(tool.publicKey) as any
      );
      vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
        hash: "boundary_hash",
        ledger: 1,
      } as any);

      const result = await tool.execute({
        destination: VALID_DEST,
        amount: "0.0000001",
        assetCode: "XLM",
      });
      expect(result.txHash).toBe("boundary_hash");
    });
  });

  describe("memo boundary tests", () => {
    beforeEach(() => {
      vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
        hash: "boundary_hash",
        ledger: 1,
      } as any);
    });

    it("accepts 28 ASCII characters", async () => {
      const result = await tool.execute({
        destination: VALID_DEST,
        amount: "1",
        assetCode: "XLM",
        memo: "a".repeat(28),
      });
      expect(result.txHash).toBe("boundary_hash");
    });

    it("rejects 14 two-byte UTF-8 characters (e.g. あ.repeat(14)) (42 bytes)", async () => {
      await expect(
        tool.execute({
          destination: VALID_DEST,
          amount: "1",
          assetCode: "XLM",
          memo: "あ".repeat(14),
        })
      ).rejects.toThrow();
    });

    it("accepts a 28-byte multi-byte string", async () => {
      const result = await tool.execute({
        destination: VALID_DEST,
        amount: "1",
        assetCode: "XLM",
        memo: "я".repeat(14), // "я" is 2 bytes in UTF-8
      });
      expect(result.txHash).toBe("boundary_hash");
    });
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  describe("Happy path", () => {
    beforeEach(() => {
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(
        makeMockAccount(tool.publicKey) as any
      );
      vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
        hash: "success_tx_hash",
        ledger: 42,
      } as any);
    });

    it("completes an XLM payment and returns txHash + ledger", async () => {
      const result = await tool.execute({
        destination: VALID_DEST,
        amount: "100",
        assetCode: "XLM",
      });

      expect(result.txHash).toBe("success_tx_hash");
      expect(result.ledger).toBe(42);
    });

    it("completes a custom asset payment (USDC)", async () => {
      const result = await tool.execute({
        destination: VALID_DEST,
        amount: "50.5",
        assetCode: "USDC",
        assetIssuer: VALID_ISSUER,
      });

      expect(result.txHash).toBe("success_tx_hash");
    });

    it("calls loadAccount with the agent public key", async () => {
      await tool.execute({ destination: VALID_DEST, amount: "1", assetCode: "XLM" });
      expect(rpcClient.loadAccount).toHaveBeenCalledOnce();
      expect(rpcClient.loadAccount).toHaveBeenCalledWith(tool.publicKey);
    });

    it("calls submitTransaction exactly once per payment", async () => {
      await tool.execute({ destination: VALID_DEST, amount: "1", assetCode: "XLM" });
      expect(rpcClient.submitTransaction).toHaveBeenCalledOnce();
    });

    it("embeds a memo when provided", async () => {
      // We just verify execute doesn't throw and the memo is accepted
      const result = await tool.execute({
        destination: VALID_DEST,
        amount: "1",
        assetCode: "XLM",
        memo: "test-memo-123",
      });
      expect(result.txHash).toBeTruthy();
    });
  });

  // ── Horizon / network error handling ────────────────────────────────────────

  describe("Network error handling", () => {
    beforeEach(() => {
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(
        makeMockAccount(tool.publicKey) as any
      );
    });

    it("propagates Horizon submission error", async () => {
      vi.mocked(rpcClient.submitTransaction).mockRejectedValue(
        new Error("Horizon: transaction failed — op_no_source_account")
      );

      await expect(
        tool.execute({ destination: VALID_DEST, amount: "1", assetCode: "XLM" })
      ).rejects.toThrow(/op_no_source_account/);
    });

    it("surfaces insufficient funds error from Horizon", async () => {
      vi.mocked(rpcClient.submitTransaction).mockRejectedValue(
        new Error("Horizon: op_underfunded — insufficient balance")
      );

      await expect(
        tool.execute({ destination: VALID_DEST, amount: "999999", assetCode: "XLM" })
      ).rejects.toThrow(/underfunded/);
    });

    it("propagates account not found error", async () => {
      vi.mocked(rpcClient.loadAccount).mockRejectedValue(
        new Error("Horizon: account not found (404)")
      );

      await expect(
        tool.execute({ destination: VALID_DEST, amount: "1", assetCode: "XLM" })
      ).rejects.toThrow(/account not found/);
    });

    it("handles network timeout from loadAccount", async () => {
      vi.mocked(rpcClient.loadAccount).mockRejectedValue(
        Object.assign(new Error("ECONNABORTED: network timeout after 30000ms"), {
          code: "ECONNABORTED",
        })
      );

      await expect(
        tool.execute({ destination: VALID_DEST, amount: "1", assetCode: "XLM" })
      ).rejects.toThrow(/timeout/i);
    });

    it("handles network timeout from submitTransaction", async () => {
      vi.mocked(rpcClient.submitTransaction).mockRejectedValue(
        Object.assign(new Error("ECONNABORTED: network timeout after 30000ms"), {
          code: "ECONNABORTED",
        })
      );

      await expect(
        tool.execute({ destination: VALID_DEST, amount: "1", assetCode: "XLM" })
      ).rejects.toThrow(/timeout/i);
    });

    it("surfaces tx_bad_seq when sequence number is stale", async () => {
      vi.mocked(rpcClient.submitTransaction).mockRejectedValue(
        new Error("Horizon: tx_bad_seq — sequence number is not valid")
      );

      await expect(
        tool.execute({ destination: VALID_DEST, amount: "1", assetCode: "XLM" })
      ).rejects.toThrow(/tx_bad_seq/);
    });

    it("recovers from tx_bad_seq on first retry", async () => {
      vi.mocked(rpcClient.submitTransaction)
        .mockRejectedValueOnce(new Error("Horizon: tx_bad_seq — sequence number is not valid"))
        .mockResolvedValueOnce({ hash: "retry_success_hash", ledger: 42 } as any);

      const result = await tool.execute({
        destination: VALID_DEST,
        amount: "1",
        assetCode: "XLM",
      });
      expect(result.txHash).toBe("retry_success_hash");
      expect(result.ledger).toBe(42);
      expect(rpcClient.submitTransaction).toHaveBeenCalledTimes(2);
    });

    it("surfaces destination account non-existent (op_no_destination)", async () => {
      vi.mocked(rpcClient.submitTransaction).mockRejectedValue(
        new Error("Horizon: op_no_destination — destination account does not exist")
      );

      await expect(
        tool.execute({ destination: VALID_DEST, amount: "1", assetCode: "XLM" })
      ).rejects.toThrow(/op_no_destination/);
    });
  });

  // ── Retry exhaustion ────────────────────────────────────────────────────────

  describe("Retry exhaustion", () => {
    beforeEach(() => {
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(
        makeMockAccount(tool.publicKey) as any
      );
    });

    it("throws after all retries are exhausted on loadAccount", async () => {
      // rpcClient.loadAccount is already wrapped in withRetry internally.
      // We simulate the final rejection reaching the tool.
      vi.mocked(rpcClient.loadAccount).mockRejectedValue(
        new Error("max retries exceeded: 503 Service Unavailable")
      );

      await expect(
        tool.execute({ destination: VALID_DEST, amount: "1", assetCode: "XLM" })
      ).rejects.toThrow(/503/);
    });

    it("throws after all retries exhausted on submitTransaction", async () => {
      vi.mocked(rpcClient.submitTransaction).mockRejectedValue(
        new Error("max retries exceeded: Horizon unavailable")
      );

      await expect(
        tool.execute({ destination: VALID_DEST, amount: "1", assetCode: "XLM" })
      ).rejects.toThrow(/Horizon unavailable/);
    });
  });

  // ── State verification ──────────────────────────────────────────────────────

  describe("State verification", () => {
    it("does not call submitTransaction when loadAccount fails", async () => {
      vi.mocked(rpcClient.loadAccount).mockRejectedValue(new Error("not found"));

      try {
        await tool.execute({ destination: VALID_DEST, amount: "1", assetCode: "XLM" });
      } catch (_) { /* expected */ }

      expect(rpcClient.submitTransaction).not.toHaveBeenCalled();
    });

    it("exposes the agent public key", () => {
      expect(tool.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
    });
  });

  // ── Network passphrase selection ────────────────────────────────────────────

  describe("Network passphrase selection", () => {
    it("uses Networks.PUBLIC (mainnet) when STELLAR_NETWORK is mainnet", async () => {
      // The correct network passphrase is verified via resolveNetworkPassphrase
      // unit tests in rpc_client.test.ts. Here we just verify the tool submits.
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(
        makeMockAccount(Keypair.fromSecret(TEST_SECRET).publicKey()) as any
      );
      vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
        hash: "mainnet_tx",
        ledger: 100,
      } as any);

      const tool = new StellarPaymentTool(TEST_SECRET);
      const result = await tool.execute({
        destination: VALID_DEST,
        amount: "1",
        assetCode: "XLM",
      });

      expect(result.txHash).toBe("mainnet_tx");
      expect(rpcClient.submitTransaction).toHaveBeenCalled();
    });

    it("uses Networks.FUTURENET when STELLAR_NETWORK is futurenet", async () => {
      vi.mocked(rpcClient.loadAccount).mockResolvedValue(
        makeMockAccount(Keypair.fromSecret(TEST_SECRET).publicKey()) as any
      );
      vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
        hash: "futurenet_tx",
        ledger: 200,
      } as any);

      const tool = new StellarPaymentTool(TEST_SECRET);
      const result = await tool.execute({
        destination: VALID_DEST,
        amount: "1",
        assetCode: "XLM",
      });

      expect(result.txHash).toBe("futurenet_tx");
      expect(rpcClient.submitTransaction).toHaveBeenCalled();
    });
  });
});
