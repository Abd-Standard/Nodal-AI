/**
 * tests/path_payment.test.ts
 *
 * Comprehensive test suite for PathPaymentTool.
 * Covers: happy path, input validation, network errors, tx_bad_seq retry,
 * and memo edge cases.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { PathPaymentTool } from "../backend/tools/PathPaymentTool";
import * as rpcClient from "../backend/rpc_client";

// ─── Module mock ──────────────────────────────────────────────────────────────

vi.mock("../backend/rpc_client", () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  resolveNetworkPassphrase: vi.fn(() => "Test SDF Network ; September 2015"),
  horizonServer: {},
  sorobanServer: {},
  simulateSorobanTx: vi.fn(),
  prepareSorobanTx: vi.fn(),
}));

// ─── Mock config ──────────────────────────────────────────────────────────────
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

const VALID_INPUT = {
  sourceAmount: "100",
  destination: VALID_DEST,
  destinationAssetCode: "USDC",
  destinationAssetIssuer: VALID_ISSUER,
  destinationMin: "95",
};

// ─── Test suite ───────────────────────────────────────────────────────────────

describe("PathPaymentTool", () => {
  let tool: PathPaymentTool;
  const { loadAccount, submitTransaction } = vi.mocked(rpcClient);

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new PathPaymentTool();
    loadAccount.mockResolvedValue(makeMockAccount(tool.publicKey) as any);
    submitTransaction.mockResolvedValue({
      hash: "success_tx_hash",
      ledger: 42,
    } as any);
  });

  // ── Input validation ────────────────────────────────────────────────────────

  describe("Input validation", () => {
    it("rejects a destination key that is too short", async () => {
      await expect(
        tool.execute({ ...VALID_INPUT, destination: "GABC123" })
      ).rejects.toThrow(/Invalid Stellar public key/);
    });

    it("rejects a negative source amount", async () => {
      await expect(
        tool.execute({ ...VALID_INPUT, sourceAmount: "-1" })
      ).rejects.toThrow(/Amount must be/);
    });

    it("rejects zero source amount", async () => {
      await expect(
        tool.execute({ ...VALID_INPUT, sourceAmount: "0" })
      ).rejects.toThrow(/Amount must be/);
    });

    it("rejects source amount with more than 7 decimal places", async () => {
      await expect(
        tool.execute({ ...VALID_INPUT, sourceAmount: "1.12345678" })
      ).rejects.toThrow(/Amount must be/);
    });

    it("rejects a non-XLM source asset when issuer is missing", async () => {
      await expect(
        tool.execute({
          ...VALID_INPUT,
          sourceAssetCode: "USDC",
          sourceAssetIssuer: undefined,
        })
      ).rejects.toThrow(
        "Asset issuer is required for non-native source asset USDC"
      );
    });

    it("rejects a non-XLM destination asset when issuer is missing", async () => {
      await expect(
        tool.execute({
          ...VALID_INPUT,
          destinationAssetCode: "EURT",
          destinationAssetIssuer: undefined,
        })
      ).rejects.toThrow(
        "Asset issuer is required for non-native destination asset EURT"
      );
    });

    it("rejects a memo longer than 28 bytes", async () => {
      await expect(
        tool.execute({
          ...VALID_INPUT,
          memo: "A".repeat(29),
        })
      ).rejects.toThrow();
    });
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  describe("Happy path", () => {
    it("completes a path payment and returns txHash + ledger", async () => {
      const result = await tool.execute(VALID_INPUT);

      expect(result.txHash).toBe("success_tx_hash");
      expect(result.ledger).toBe(42);
    });

    it("completes an XLM-to-XLM path payment", async () => {
      const result = await tool.execute({
        sourceAmount: "50",
        destination: VALID_DEST,
        destinationAssetCode: "XLM",
        destinationMin: "49",
      });

      expect(result.txHash).toBe("success_tx_hash");
    });

    it("calls loadAccount with the agent public key", async () => {
      await tool.execute(VALID_INPUT);
      expect(loadAccount).toHaveBeenCalledWith(tool.publicKey);
    });

    it("calls submitTransaction exactly once per successful payment", async () => {
      await tool.execute(VALID_INPUT);
      expect(submitTransaction).toHaveBeenCalledOnce();
    });

    it("embeds a memo when provided", async () => {
      const result = await tool.execute({
        ...VALID_INPUT,
        memo: "path-payment-memo",
      });
      expect(result.txHash).toBeTruthy();
    });
  });

  // ── tx_bad_seq retry ────────────────────────────────────────────────────────

  describe("tx_bad_seq retry", () => {
    it("retries once on tx_bad_seq and succeeds", async () => {
      submitTransaction
        .mockRejectedValueOnce(new Error("tx_bad_seq"))
        .mockResolvedValueOnce({ hash: "retry_hash", ledger: 200 } as any);

      const result = await tool.execute(VALID_INPUT);
      expect(result.txHash).toBe("retry_hash");
      expect(submitTransaction).toHaveBeenCalledTimes(2);
    });

    it("reloads account on tx_bad_seq retry", async () => {
      submitTransaction
        .mockRejectedValueOnce(new Error("tx_bad_seq"))
        .mockResolvedValueOnce({ hash: "retry_hash", ledger: 200 } as any);

      await tool.execute(VALID_INPUT);

      // Account should be loaded twice: initial + retry
      expect(loadAccount).toHaveBeenCalledTimes(2);
    });

    it("propagates non-tx_bad_seq errors without retry", async () => {
      submitTransaction.mockRejectedValue(
        new Error("Horizon: op_underfunded — insufficient balance")
      );

      await expect(
        tool.execute(VALID_INPUT)
      ).rejects.toThrow(/underfunded/);
      expect(submitTransaction).toHaveBeenCalledOnce();
    });
  });

  // ── Network error handling ──────────────────────────────────────────────────

  describe("Network error handling", () => {
    it("propagates Horizon submission error", async () => {
      submitTransaction.mockRejectedValue(
        new Error("Horizon: transaction failed — op_no_source_account")
      );

      await expect(
        tool.execute(VALID_INPUT)
      ).rejects.toThrow(/op_no_source_account/);
    });

    it("propagates account not found error", async () => {
      loadAccount.mockRejectedValue(
        new Error("Horizon: account not found (404)")
      );

      await expect(
        tool.execute(VALID_INPUT)
      ).rejects.toThrow(/account not found/);
    });

    it("handles network timeout from submitTransaction", async () => {
      submitTransaction.mockRejectedValue(
        Object.assign(new Error("ECONNABORTED: network timeout after 30000ms"), {
          code: "ECONNABORTED",
        })
      );

      await expect(
        tool.execute(VALID_INPUT)
      ).rejects.toThrow(/timeout/i);
    });
  });

  // ── State verification ──────────────────────────────────────────────────────

  describe("State verification", () => {
    it("does not call submitTransaction when loadAccount fails", async () => {
      loadAccount.mockRejectedValue(new Error("not found"));

      try {
        await tool.execute(VALID_INPUT);
      } catch (_) {
        /* expected */
      }

      expect(submitTransaction).not.toHaveBeenCalled();
    });

    it("exposes the agent public key", () => {
      expect(tool.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
    });
  });
});
