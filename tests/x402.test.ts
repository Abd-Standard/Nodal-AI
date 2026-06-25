/**
 * tests/x402.test.ts
 *
 * Comprehensive test suite for X402PaymentTool.
 * Covers: valid flow, schema validation, expiry, edge cases,
 * network failures during payment, and proof structure integrity.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { hash, Keypair } from "@stellar/stellar-sdk";
import { X402PaymentTool } from "../backend/tools/X402PaymentTool";
import { StellarPaymentTool } from "../backend/tools/StellarPaymentTool";
import { config } from "../backend/config";

// ─── Mock rpc_client so horizonServer.ledgers() is interceptable ──────────────

vi.mock("../backend/rpc_client", () => ({
  horizonServer: {
    ledgers: vi.fn().mockReturnValue({
      ledger: vi.fn().mockReturnValue({
        call: vi.fn().mockResolvedValue({ closed_at: "2024-01-01T00:00:00Z" }),
      }),
    }),
  },
}));

// ─── Mock StellarPaymentTool so x402 tests don't hit Horizon ─────────────────

vi.mock("../backend/tools/StellarPaymentTool");

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
      MAX_X402_PAYMENTS_PER_MINUTE: 10,
      MAX_SOROBAN_FEE_STROOPS: 1_000_000,
      ALLOWED_X402_ORIGINS: undefined,
    },
  };
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TEST_SECRET   = "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73";
const VALID_PAY_TO  = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const VALID_ISSUER  = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function futureIso(offsetMs = 60_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

const VALID_CHALLENGE = {
  resource: "https://api.example.com/data",
  amount: "1.5000000",
  assetCode: "USDC",
  assetIssuer: VALID_ISSUER,
  payTo: VALID_PAY_TO,
  nonce: "550e8400-e29b-41d4-a716-446655440000",
  expiresAt: futureIso(),
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("X402PaymentTool", () => {
  let tool: X402PaymentTool;
  let mockPaymentTool: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPaymentTool = {
      publicKey: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      execute: vi.fn().mockResolvedValue({ txHash: "x402_mock_tx_hash", ledger: 99 }),
    };
    vi.mocked(StellarPaymentTool).mockImplementation(() => mockPaymentTool);
    tool = new X402PaymentTool(TEST_SECRET);
  });



  // ── Schema validation ───────────────────────────────────────────────────────

  describe("Schema validation", () => {
    it("rejects a challenge with a missing nonce", async () => {
      const { nonce: _omit, ...noNonce } = VALID_CHALLENGE;
      await expect(tool.respond(noNonce)).rejects.toThrow();
    });

    it("rejects a non-UUID nonce", async () => {
      await expect(
        tool.respond({ ...VALID_CHALLENGE, nonce: "not-a-uuid" })
      ).rejects.toThrow(/UUID/);
    });

    it("rejects a challenge where payTo is the agent's own address", async () => {
      const agentPublicKey = Keypair.fromSecret(TEST_SECRET).publicKey();
      await expect(
        tool.respond({ ...VALID_CHALLENGE, payTo: agentPublicKey })
      ).rejects.toThrow("Payment destination cannot be the agent's own address");
    });

    it("rejects USDC payment when assetIssuer is empty", async () => {
      await expect(
        tool.respond({ ...VALID_CHALLENGE, assetCode: "USDC", assetIssuer: "" })
      ).rejects.toThrow("assetIssuer is required for non-XLM payments");
    });

    it("accepts XLM payment without assetIssuer", async () => {
      const proof = await tool.respond({ ...VALID_CHALLENGE, assetCode: "XLM", assetIssuer: "" });
      expect(proof.txHash).toBeTruthy();
    });

    it("rejects a missing resource URL", async () => {
      const { resource: _omit, ...noResource } = VALID_CHALLENGE;
      await expect(tool.respond(noResource)).rejects.toThrow();
    });

    it("rejects a non-URL resource field", async () => {
      await expect(
        tool.respond({ ...VALID_CHALLENGE, resource: "not-a-url" })
      ).rejects.toThrow(/URL/);
    });

    it("rejects a payTo address that is too short", async () => {
      await expect(
        tool.respond({ ...VALID_CHALLENGE, payTo: "GBBD47" })
      ).rejects.toThrow(/Stellar address/);
    });

    it("rejects missing expiresAt field", async () => {
      const { expiresAt: _omit, ...noExpiry } = VALID_CHALLENGE;
      await expect(tool.respond(noExpiry)).rejects.toThrow();
    });

    it("rejects an expiresAt that is not a valid ISO datetime", async () => {
      await expect(
        tool.respond({ ...VALID_CHALLENGE, expiresAt: "not-a-date" })
      ).rejects.toThrow();
    });

    it("rejects a completely empty object", async () => {
      await expect(tool.respond({})).rejects.toThrow();
    });

    it("rejects null input", async () => {
      await expect(tool.respond(null)).rejects.toThrow();
    });
  });

  // ── Expiry guard ─────────────────────────────────────────────────────────────

  describe("Expiry guard", () => {
    it("rejects a challenge expired 1 ms ago", async () => {
      await expect(
        tool.respond({ ...VALID_CHALLENGE, expiresAt: new Date(Date.now() - 1).toISOString() })
      ).rejects.toThrow(/expired/);
    });

    it("rejects a challenge expired 1 hour ago", async () => {
      await expect(
        tool.respond({ ...VALID_CHALLENGE, expiresAt: new Date(Date.now() - 3_600_000).toISOString() })
      ).rejects.toThrow(/expired/);
    });

    it("accepts a challenge expiring 1 ms from now", async () => {
      const proof = await tool.respond({
        ...VALID_CHALLENGE,
        expiresAt: futureIso(1),
      });
      expect(proof.txHash).toBeTruthy();
    });
  });

  // ── Rate limiting ────────────────────────────────────────────────────────────

  describe("Rate limiting", () => {
    it("allows up to MAX_X402_PAYMENTS_PER_MINUTE calls within the window", async () => {
      for (let i = 0; i < 10; i++) {
        const proof = await tool.respond(VALID_CHALLENGE);
        expect(proof.txHash).toBe("x402_mock_tx_hash");
      }
      expect(mockPaymentTool.execute).toHaveBeenCalledTimes(10);
    });

    it("throws on the 11th call within the same 60s window", async () => {
      for (let i = 0; i < 10; i++) {
        await tool.respond(VALID_CHALLENGE);
      }
      await expect(tool.respond(VALID_CHALLENGE)).rejects.toThrow("x402: rate limit exceeded");
    });

    it("resets the counter after 60s window elapses", async () => {
      vi.useFakeTimers();
      const startTime = Date.now();
      const farFutureExpiry = new Date(startTime + 180_000).toISOString();
      const challenge = { ...VALID_CHALLENGE, expiresAt: farFutureExpiry };

      for (let i = 0; i < 10; i++) {
        await tool.respond(challenge);
      }
      await expect(tool.respond(challenge)).rejects.toThrow("rate limit exceeded");

      vi.setSystemTime(startTime + 60_001);

      const proof = await tool.respond(challenge);
      expect(proof.txHash).toBe("x402_mock_tx_hash");
      vi.useRealTimers();
    });
  });

  describe("ALLOWED_X402_ORIGINS validation", () => {
    it("accepts a challenge from a trusted origin", async () => {
      (config as any).ALLOWED_X402_ORIGINS = "api.example.com, other.com";
      const proof = await tool.respond(VALID_CHALLENGE);
      expect(proof.txHash).toBe("x402_mock_tx_hash");
    });

    it("rejects a challenge from an untrusted origin", async () => {
      (config as any).ALLOWED_X402_ORIGINS = "trusted.com";
      await expect(tool.respond(VALID_CHALLENGE)).rejects.toThrow("x402: untrusted resource origin");
    });

    it("disables wildcard (*) bypass", async () => {
      (config as any).ALLOWED_X402_ORIGINS = "*";
      await expect(tool.respond(VALID_CHALLENGE)).rejects.toThrow("x402: untrusted resource origin");
    });

    afterEach(() => {
      (config as any).ALLOWED_X402_ORIGINS = undefined;
    });
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  describe("Happy path", () => {
    it("returns a valid x402 payment proof structure", async () => {
      const proof = await tool.respond(VALID_CHALLENGE);

      expect(proof.protocol).toBe("x402");
      expect(proof.network).toBe("testnet");
      expect(proof.txHash).toBe("x402_mock_tx_hash");
      expect(proof.nonce).toBe(VALID_CHALLENGE.nonce);
      expect(proof.payer).toMatch(/^G[A-Z2-7]{55}$/);
      // signedAt is either ledger close time or wall-clock fallback — both are valid ISO strings
      expect(proof.signedAt).toBeTruthy();
      expect(() => new Date(proof.signedAt)).not.toThrow();
      expect(new Date(proof.signedAt).toISOString()).toBe(proof.signedAt);
    });

    it("embeds nonce in memo as SHA-256 fingerprint (28 hex chars)", async () => {
      await tool.respond(VALID_CHALLENGE);

      const callArg = mockPaymentTool.execute.mock.calls[0][0] as any;

      const expectedMemo = hash(Buffer.from(VALID_CHALLENGE.nonce)).toString("hex").slice(0, 28);
      expect(callArg.memo).toBe(expectedMemo);
      expect(callArg.memo.length).toBe(28);
    });

    it("delegates to StellarPaymentTool with correct destination and amount", async () => {
      await tool.respond(VALID_CHALLENGE);

      expect(mockPaymentTool.execute).toHaveBeenCalledWith(
        expect.objectContaining({
          destination: VALID_CHALLENGE.payTo,
          amount: VALID_CHALLENGE.amount,
          assetCode: VALID_CHALLENGE.assetCode,
          assetIssuer: VALID_CHALLENGE.assetIssuer,
        })
      );
    });

    it("omits assetIssuer for XLM payments", async () => {
      await tool.respond({ ...VALID_CHALLENGE, assetCode: "XLM" });

      const callArg = mockPaymentTool.execute.mock.calls[0][0] as any;
      expect(callArg.assetIssuer).toBeUndefined();
    });

    it("calls StellarPaymentTool.execute exactly once per challenge", async () => {
      await tool.respond(VALID_CHALLENGE);

      expect(mockPaymentTool.execute).toHaveBeenCalledOnce();
    });
  });

  // ── Payment failure propagation ─────────────────────────────────────────────

  describe("Payment failure propagation", () => {
    function getMockExecute() {
      return mockPaymentTool.execute as ReturnType<typeof vi.fn>;
    }

    it("propagates insufficient funds from underlying payment", async () => {
      getMockExecute().mockRejectedValueOnce(
        new Error("Horizon: op_underfunded — insufficient balance")
      );

      await expect(tool.respond(VALID_CHALLENGE)).rejects.toThrow(/underfunded/);
    });

    it("propagates network timeout from underlying payment", async () => {
      getMockExecute().mockRejectedValueOnce(
        new Error("ECONNABORTED: network timeout")
      );

      await expect(tool.respond(VALID_CHALLENGE)).rejects.toThrow(/timeout/);
    });

    it("propagates trust line missing error", async () => {
      getMockExecute().mockRejectedValueOnce(
        new Error("Horizon: op_no_trust — recipient missing trust line for USDC")
      );

      await expect(tool.respond(VALID_CHALLENGE)).rejects.toThrow(/no_trust/);
    });
  });

  // ── Nonce replay protection ─────────────────────────────────────────────────

  describe("Nonce replay protection", () => {
    it("first use with a given nonce succeeds", async () => {
      await expect(tool.respond(VALID_CHALLENGE)).resolves.toHaveProperty("nonce", VALID_CHALLENGE.nonce);
    });

    it("second use with the same nonce throws", async () => {
      await tool.respond(VALID_CHALLENGE);
      await expect(tool.respond(VALID_CHALLENGE)).rejects.toThrow("x402: nonce already used");
    });

    it("allows a different nonce after a previous one was consumed", async () => {
      await tool.respond(VALID_CHALLENGE);
      const second = { ...VALID_CHALLENGE, nonce: "660e8400-e29b-41d4-a716-446655440001" };
      await expect(tool.respond(second)).resolves.toHaveProperty("nonce", second.nonce);
    });
  });

  // ── Snapshot tests for X402PaymentProof shape ──────────────────────────────

  describe("X402PaymentProof snapshot", () => {
    it("X402PaymentProof has expected shape and fields", async () => {
      const proof = await tool.respond(VALID_CHALLENGE);

      expect(proof).toMatchSnapshot();
      expect(proof).toHaveProperty("protocol", "x402");
      expect(proof).toHaveProperty("network");
      expect(proof).toHaveProperty("txHash");
      expect(proof).toHaveProperty("nonce");
      expect(proof).toHaveProperty("payer");
      expect(proof).toHaveProperty("signedAt");
    });
  });
});
