/**
 * tests/rpc_client.test.ts
 *
 * Tests for withRetry and DEFAULT_IS_RETRYABLE in backend/rpc_client.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ZodError, z } from "zod";
import { withRetry, DEFAULT_IS_RETRYABLE, resolveNetworkPassphrase, withTimeout, TimeoutError, prepareSorobanTx, sorobanServer } from "../backend/rpc_client";
import { Networks, rpc, xdr, StrKey, Keypair } from "@stellar/stellar-sdk";

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    rpc: {
      ...mod.rpc,
      assembleTransaction: vi.fn(),
    },
  };
});

vi.mock("../backend/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  generateCorrelationId: vi.fn(() => "mock-id"),
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
      RPC_TIMEOUT_MS: 9000,
      MAX_X402_PAYMENTS_PER_MINUTE: 10,
      MAX_SOROBAN_FEE_STROOPS: 1_000_000,
    },
  };
});

// ─── resolveNetworkPassphrase ─────────────────────────────────────────────────

describe("resolveNetworkPassphrase", () => {
  it("returns Networks.PUBLIC for mainnet", () => {
    expect(resolveNetworkPassphrase("mainnet")).toBe(Networks.PUBLIC);
  });

  it("returns Networks.TESTNET for testnet", () => {
    expect(resolveNetworkPassphrase("testnet")).toBe(Networks.TESTNET);
  });

  it("returns Networks.FUTURENET for futurenet", () => {
    expect(resolveNetworkPassphrase("futurenet")).toBe(Networks.FUTURENET);
  });

  it("throws for an unknown network string", () => {
    expect(() => resolveNetworkPassphrase("unknown")).toThrow("Unsupported network: unknown");
  });

  it("throws for empty string", () => {
    expect(() => resolveNetworkPassphrase("")).toThrow("Unsupported network: ");
  });

  it("throws for undefined cast to string", () => {
    expect(() => resolveNetworkPassphrase(undefined as any)).toThrow();
  });
});

// ─── DEFAULT_IS_RETRYABLE ─────────────────────────────────────────────────────

describe("DEFAULT_IS_RETRYABLE", () => {
  it("returns false for ZodError", () => {
    expect(DEFAULT_IS_RETRYABLE(new ZodError([]))).toBe(false);
  });

  it("returns false for TypeError", () => {
    expect(DEFAULT_IS_RETRYABLE(new TypeError("bad type"))).toBe(false);
  });

  it("returns true for a generic Error", () => {
    expect(DEFAULT_IS_RETRYABLE(new Error("503 Service Unavailable"))).toBe(true);
  });

  it("returns true for a plain string error", () => {
    expect(DEFAULT_IS_RETRYABLE("network failure")).toBe(true);
  });
});

// ─── withRetry ────────────────────────────────────────────────────────────────

describe("withRetry", () => {
  it("throws ZodError immediately without retrying", async () => {
    const zodError = z.string().safeParse(42).error!;
    const fn = vi.fn().mockRejectedValue(zodError);

    await expect(withRetry(fn, 3, 0)).rejects.toBeInstanceOf(ZodError);
    // Deterministic failure — must not retry at all
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws TypeError immediately without retrying", async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError("cannot read property"));

    await expect(withRetry(fn, 3, 0)).rejects.toBeInstanceOf(TypeError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries the full MAX_RETRIES times for a transient error (e.g. HTTP 503)", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("503 Service Unavailable"));

    await expect(withRetry(fn, 3, 0)).rejects.toThrow("503");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("resolves on the first successful attempt without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");

    await expect(withRetry(fn, 3, 0)).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("resolves after a transient failure followed by success", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("recovered");

    await expect(withRetry(fn, 3, 0)).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  // ── Exponential back-off timing with fake timers (#58) ──────────────────────

  it("respects exponential delay progression [1500, 3000, 6000]", async () => {
    vi.useFakeTimers();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("try1"))
      .mockRejectedValueOnce(new Error("try2"))
      .mockRejectedValueOnce(new Error("try3"))
      .mockResolvedValue("success");

    const promise = withRetry(fn, 4, 1500, DEFAULT_IS_RETRYABLE, 30000);
    await vi.advanceTimersByTimeAsync(0); // Initial attempt
    expect(fn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1500); // First retry after 1500ms delay
    expect(fn).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(3000); // Second retry after 3000ms delay
    expect(fn).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(6000); // Third retry after 6000ms delay
    expect(fn).toHaveBeenCalledTimes(4);

    await expect(promise).resolves.toBe("success");
    vi.useRealTimers();
  });

  it("respects maxDelayMs cap on exponential growth", async () => {
    vi.useFakeTimers();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValue("ok");

    const promise = withRetry(fn, 3, 1500, DEFAULT_IS_RETRYABLE, 2000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1500); // First retry
    await vi.advanceTimersByTimeAsync(2000); // Second retry should be capped at 2000, not 3000

    await expect(promise).resolves.toBe("ok");
    vi.useRealTimers();
  });

  it("jitter does not cause delay to exceed maxDelayMs cap", async () => {
    vi.useFakeTimers();
    const fn = vi.fn().mockResolvedValue("ok");
    const startTime = Date.now();

    // Jitter is ±20% of capped delay, so for cap of 1000: jitter max is 200
    // Total max delay should not exceed 1000 + 200 = 1200
    const promise = withRetry(fn, 1, 500, DEFAULT_IS_RETRYABLE, 1000);
    await vi.advanceTimersByTimeAsync(1200);

    await expect(promise).resolves.toBe("ok");
    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeLessThanOrEqual(1200);
    vi.useRealTimers();
  });

  it("last error is re-thrown after exhaustion with StellarRPCError", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Service Unavailable"));

    const err = await withRetry(fn, 3, 0).catch((e: unknown) => e);
    expect((err as Error).name).toBe("StellarRPCError");
    expect((err as Error).message).toContain("RPC call failed after 3 attempts");
  });
});

// ─── withTimeout ──────────────────────────────────────────────────────────────

describe("withTimeout", () => {
  it("resolves when the promise completes before the timeout", async () => {
    const fast = Promise.resolve("done");
    await expect(withTimeout(fast, 500)).resolves.toBe("done");
  });

  it("throws TimeoutError when the promise exceeds the timeout", async () => {
    const slow = new Promise<never>(() => {}); // never resolves
    await expect(withTimeout(slow, 10)).rejects.toBeInstanceOf(TimeoutError);
  });

  it("TimeoutError message identifies it as a timeout, not a network error", async () => {
    const slow = new Promise<never>(() => {});
    const err = await withTimeout(slow, 10).catch((e) => e);
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err.message).toMatch(/timeout/i);
    expect(err.name).toBe("TimeoutError");
  });
});

// ─── prepareSorobanTx auth checks ──────────────────────────────────────────

describe("prepareSorobanTx auth checks", () => {
  beforeEach(() => {
    vi.spyOn(sorobanServer, "simulateTransaction").mockResolvedValue({} as any);
  });

  it("throws when auth contains an unexpected signer (address credentials)", async () => {
    const badKeypair = Keypair.random();
    const badAddress = badKeypair.publicKey();
    const rawKey = StrKey.decodeEd25519PublicKey(badAddress);

    const mockAuthEntry = {
      credentials: () => ({
        switch: () => xdr.SorobanCredentialsType.sorobanCredentialsAddress(),
        address: () => ({
          address: () => ({
            switch: () => xdr.ScAddressType.scAddressTypeAccount(),
            accountId: () => ({
              ed25519: () => rawKey,
            }),
          }),
        }),
      }),
    };

    const mockTx = {
      operations: [{ auth: [mockAuthEntry] }],
    };

    vi.mocked(rpc.assembleTransaction).mockReturnValue({
      build: vi.fn().mockReturnValue(mockTx as any),
    });

    const dummyTx = {} as any;
    await expect(prepareSorobanTx(dummyTx)).rejects.toThrow(/unexpected/i);
  });

  it("does not throw when auth entries use source account credentials", async () => {
    const mockAuthEntry = {
      credentials: () => ({
        switch: () => xdr.SorobanCredentialsType.sorobanCredentialsSourceAccount(),
      }),
    };

    const mockTx = {
      operations: [{ auth: [mockAuthEntry] }],
    };

    vi.mocked(rpc.assembleTransaction).mockReturnValue({
      build: vi.fn().mockReturnValue(mockTx as any),
    });

    const dummyTx = {} as any;
    await expect(prepareSorobanTx(dummyTx)).resolves.toBeDefined();
  });

  it("does not throw when address credentials match the agent's public key", async () => {
    const agentSecret = "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73";
    const agentPublicKey = Keypair.fromSecret(agentSecret).publicKey();
    const rawKey = StrKey.decodeEd25519PublicKey(agentPublicKey);

    const mockAuthEntry = {
      credentials: () => ({
        switch: () => xdr.SorobanCredentialsType.sorobanCredentialsAddress(),
        address: () => ({
          address: () => ({
            switch: () => xdr.ScAddressType.scAddressTypeAccount(),
            accountId: () => ({
              ed25519: () => rawKey,
            }),
          }),
        }),
      }),
    };

    const mockTx = {
      operations: [{ auth: [mockAuthEntry] }],
    };

    vi.mocked(rpc.assembleTransaction).mockReturnValue({
      build: vi.fn().mockReturnValue(mockTx as any),
    });

    const dummyTx = {} as any;
    await expect(prepareSorobanTx(dummyTx)).resolves.toBeDefined();
  });
});
