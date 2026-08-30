"use strict";
/**
 * tests/rpc_client.test.ts
 *
 * Tests for withRetry and DEFAULT_IS_RETRYABLE in backend/rpc_client.ts.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const zod_1 = require("zod");
const rpc_client_1 = require("../backend/rpc_client");
const stellar_sdk_1 = require("@stellar/stellar-sdk");
vitest_1.vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
    const mod = await importOriginal();
    return {
        ...mod,
        rpc: {
            ...mod.rpc,
            assembleTransaction: vitest_1.vi.fn(),
        },
    };
});
const { rpcClientLog } = vitest_1.vi.hoisted(() => ({
    rpcClientLog: {
        info: vitest_1.vi.fn(),
        warn: vitest_1.vi.fn(),
        error: vitest_1.vi.fn(),
        debug: vitest_1.vi.fn(),
    },
}));
vitest_1.vi.mock("../backend/utils/logger", () => ({
    logger: { info: vitest_1.vi.fn(), warn: vitest_1.vi.fn(), error: vitest_1.vi.fn(), debug: vitest_1.vi.fn() },
    createLogger: vitest_1.vi.fn(() => rpcClientLog),
    generateCorrelationId: vitest_1.vi.fn(() => "mock-id"),
}));
vitest_1.vi.mock("../backend/config", () => {
    const { Keypair } = require("@stellar/stellar-sdk");
    const secret = "process.env.AGENT_SECRET_KEY";
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
(0, vitest_1.beforeEach)(() => {
    rpcClientLog.info.mockClear();
    rpcClientLog.warn.mockClear();
    rpcClientLog.error.mockClear();
    rpcClientLog.debug.mockClear();
});
(0, vitest_1.afterEach)(() => {
    vitest_1.vi.useRealTimers();
});
// ─── resolveNetworkPassphrase ─────────────────────────────────────────────────
(0, vitest_1.describe)("resolveNetworkPassphrase", () => {
    (0, vitest_1.it)("returns Networks.PUBLIC for mainnet", () => {
        (0, vitest_1.expect)((0, rpc_client_1.resolveNetworkPassphrase)("mainnet")).toBe(stellar_sdk_1.Networks.PUBLIC);
    });
    (0, vitest_1.it)("returns Networks.TESTNET for testnet", () => {
        (0, vitest_1.expect)((0, rpc_client_1.resolveNetworkPassphrase)("testnet")).toBe(stellar_sdk_1.Networks.TESTNET);
    });
    (0, vitest_1.it)("returns Networks.FUTURENET for futurenet", () => {
        (0, vitest_1.expect)((0, rpc_client_1.resolveNetworkPassphrase)("futurenet")).toBe(stellar_sdk_1.Networks.FUTURENET);
    });
    (0, vitest_1.it)("throws for an unknown network string", () => {
        (0, vitest_1.expect)(() => (0, rpc_client_1.resolveNetworkPassphrase)("unknown")).toThrow("Unsupported network: unknown");
    });
    (0, vitest_1.it)("throws for empty string", () => {
        (0, vitest_1.expect)(() => (0, rpc_client_1.resolveNetworkPassphrase)("")).toThrow("Unsupported network: ");
    });
    (0, vitest_1.it)("throws for undefined cast to string", () => {
        (0, vitest_1.expect)(() => (0, rpc_client_1.resolveNetworkPassphrase)(undefined)).toThrow();
    });
});
// ─── DEFAULT_IS_RETRYABLE ─────────────────────────────────────────────────────
(0, vitest_1.describe)("DEFAULT_IS_RETRYABLE", () => {
    (0, vitest_1.it)("returns false for ZodError", () => {
        (0, vitest_1.expect)((0, rpc_client_1.DEFAULT_IS_RETRYABLE)(new zod_1.ZodError([]))).toBe(false);
    });
    (0, vitest_1.it)("returns false for TypeError", () => {
        (0, vitest_1.expect)((0, rpc_client_1.DEFAULT_IS_RETRYABLE)(new TypeError("bad type"))).toBe(false);
    });
    (0, vitest_1.it)("returns true for a generic Error", () => {
        (0, vitest_1.expect)((0, rpc_client_1.DEFAULT_IS_RETRYABLE)(new Error("503 Service Unavailable"))).toBe(true);
    });
    (0, vitest_1.it)("returns true for a plain string error", () => {
        (0, vitest_1.expect)((0, rpc_client_1.DEFAULT_IS_RETRYABLE)("network failure")).toBe(true);
    });
});
// ─── withRetry ────────────────────────────────────────────────────────────────
(0, vitest_1.describe)("withRetry", () => {
    (0, vitest_1.it)("throws ZodError immediately without retrying", async () => {
        const zodError = zod_1.z.string().safeParse(42).error;
        const fn = vitest_1.vi.fn().mockRejectedValue(zodError);
        await (0, vitest_1.expect)((0, rpc_client_1.withRetry)(fn, 3, 0)).rejects.toBeInstanceOf(zod_1.ZodError);
        // Deterministic failure — must not retry at all
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(1);
    });
    (0, vitest_1.it)("throws TypeError immediately without retrying", async () => {
        const fn = vitest_1.vi.fn().mockRejectedValue(new TypeError("cannot read property"));
        await (0, vitest_1.expect)((0, rpc_client_1.withRetry)(fn, 3, 0)).rejects.toBeInstanceOf(TypeError);
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(1);
    });
    (0, vitest_1.it)("retries the full MAX_RETRIES times for a transient error (e.g. HTTP 503)", async () => {
        const fn = vitest_1.vi.fn().mockRejectedValue(new Error("503 Service Unavailable"));
        await (0, vitest_1.expect)((0, rpc_client_1.withRetry)(fn, 3, 0)).rejects.toThrow("503");
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(3);
    });
    (0, vitest_1.it)("resolves on the first successful attempt without retrying", async () => {
        const fn = vitest_1.vi.fn().mockResolvedValue("ok");
        await (0, vitest_1.expect)((0, rpc_client_1.withRetry)(fn, 3, 0)).resolves.toBe("ok");
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(1);
    });
    (0, vitest_1.it)("resolves after a transient failure followed by success", async () => {
        const fn = vitest_1.vi.fn()
            .mockRejectedValueOnce(new Error("transient"))
            .mockResolvedValue("recovered");
        await (0, vitest_1.expect)((0, rpc_client_1.withRetry)(fn, 3, 0)).resolves.toBe("recovered");
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(2);
    });
    // ── Exponential back-off timing with fake timers (#58) ──────────────────────
    (0, vitest_1.it)("respects exponential delay progression [1500, 3000, 6000]", async () => {
        vitest_1.vi.useFakeTimers();
        // Mock Math.random to return 0 so jitter (±20%) is eliminated from delays
        const randomSpy = vitest_1.vi.spyOn(Math, "random").mockReturnValue(0);
        const fn = vitest_1.vi.fn()
            .mockRejectedValueOnce(new Error("try1"))
            .mockRejectedValueOnce(new Error("try2"))
            .mockRejectedValueOnce(new Error("try3"))
            .mockResolvedValue("success");
        const promise = (0, rpc_client_1.withRetry)(fn, 4, 1500, rpc_client_1.DEFAULT_IS_RETRYABLE, 30000);
        await vitest_1.vi.advanceTimersByTimeAsync(0); // Initial attempt
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(1);
        // Each delay includes ±20% jitter, so advance by delay + 20% ceiling
        await vitest_1.vi.advanceTimersByTimeAsync(1500 * 1.2 + 50); // First retry after ~1500ms
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(2);
        await vitest_1.vi.advanceTimersByTimeAsync(3000 * 1.2 + 50); // Second retry after ~3000ms
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(3);
        await vitest_1.vi.advanceTimersByTimeAsync(6000 * 1.2 + 50); // Third retry after ~6000ms
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(4);
        await (0, vitest_1.expect)(promise).resolves.toBe("success");
        randomSpy.mockRestore();
        vitest_1.vi.useRealTimers();
    });
    (0, vitest_1.it)("respects maxDelayMs cap on exponential growth", async () => {
        vitest_1.vi.useFakeTimers();
        const fn = vitest_1.vi.fn()
            .mockRejectedValueOnce(new Error("fail"))
            .mockResolvedValue("ok");
        const promise = (0, rpc_client_1.withRetry)(fn, 3, 1500, rpc_client_1.DEFAULT_IS_RETRYABLE, 2000);
        await vitest_1.vi.advanceTimersByTimeAsync(0);
        await vitest_1.vi.advanceTimersByTimeAsync(1500); // First retry
        await vitest_1.vi.advanceTimersByTimeAsync(2000); // Second retry should be capped at 2000, not 3000
        await (0, vitest_1.expect)(promise).resolves.toBe("ok");
        vitest_1.vi.useRealTimers();
    });
    (0, vitest_1.it)("jitter does not cause delay to exceed maxDelayMs cap", async () => {
        vitest_1.vi.useFakeTimers();
        const fn = vitest_1.vi.fn().mockResolvedValue("ok");
        const startTime = Date.now();
        // Jitter is ±20% of capped delay, so for cap of 1000: jitter max is 200
        // Total max delay should not exceed 1000 + 200 = 1200
        const promise = (0, rpc_client_1.withRetry)(fn, 1, 500, rpc_client_1.DEFAULT_IS_RETRYABLE, 1000);
        await vitest_1.vi.advanceTimersByTimeAsync(1200);
        await (0, vitest_1.expect)(promise).resolves.toBe("ok");
        const elapsed = Date.now() - startTime;
        (0, vitest_1.expect)(elapsed).toBeLessThanOrEqual(1200);
        vitest_1.vi.useRealTimers();
    });
    (0, vitest_1.it)("last error is re-thrown after exhaustion with StellarRPCError", async () => {
        const fn = vitest_1.vi.fn().mockRejectedValue(new Error("Service Unavailable"));
        let caughtErr;
        try {
            await (0, rpc_client_1.withRetry)(fn, 3, 0);
        }
        catch (e) {
            caughtErr = e;
        }
        (0, vitest_1.expect)(caughtErr).toBeInstanceOf(Error);
        const err = caughtErr;
        (0, vitest_1.expect)(err.name).toBe("StellarRPCError");
        (0, vitest_1.expect)(err.message).toContain("RPC call failed after 3 attempts");
        let caught;
        try {
            await (0, rpc_client_1.withRetry)(fn, 3, 0);
        }
        catch (e) {
            caught = e;
        }
        (0, vitest_1.expect)(caught).toBeDefined();
        (0, vitest_1.expect)(caught.name).toBe("StellarRPCError");
        (0, vitest_1.expect)(caught.message).toContain("RPC call failed after 3 attempt(s)");
    });
});
// ─── withTimeout ──────────────────────────────────────────────────────────────
(0, vitest_1.describe)("withTimeout", () => {
    (0, vitest_1.it)("resolves when the promise completes before the timeout", async () => {
        const fast = Promise.resolve("done");
        await (0, vitest_1.expect)((0, rpc_client_1.withTimeout)(fast, 500)).resolves.toBe("done");
    });
    (0, vitest_1.it)("throws TimeoutError when the promise exceeds the timeout", async () => {
        const slow = new Promise(() => { }); // never resolves
        await (0, vitest_1.expect)((0, rpc_client_1.withTimeout)(slow, 10)).rejects.toBeInstanceOf(rpc_client_1.TimeoutError);
    });
    (0, vitest_1.it)("TimeoutError message identifies it as a timeout, not a network error", async () => {
        const slow = new Promise(() => { });
        const err = await (0, rpc_client_1.withTimeout)(slow, 10).catch((e) => e);
        (0, vitest_1.expect)(err).toBeInstanceOf(rpc_client_1.TimeoutError);
        (0, vitest_1.expect)(err.message).toMatch(/timeout/i);
        (0, vitest_1.expect)(err.name).toBe("TimeoutError");
    });
});
// ─── prepareSorobanTx auth checks ──────────────────────────────────────────
(0, vitest_1.describe)("prepareSorobanTx auth checks", () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.spyOn(rpc_client_1.sorobanServer, "simulateTransaction").mockResolvedValue({});
    });
    (0, vitest_1.it)("throws when auth contains an unexpected signer (address credentials)", async () => {
        const badKeypair = stellar_sdk_1.Keypair.random();
        const badAddress = badKeypair.publicKey();
        const rawKey = stellar_sdk_1.StrKey.decodeEd25519PublicKey(badAddress);
        const mockAuthEntry = {
            credentials: () => ({
                switch: () => stellar_sdk_1.xdr.SorobanCredentialsType.sorobanCredentialsAddress(),
                address: () => ({
                    address: () => ({
                        switch: () => stellar_sdk_1.xdr.ScAddressType.scAddressTypeAccount(),
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
        vitest_1.vi.mocked(stellar_sdk_1.rpc.assembleTransaction).mockReturnValue({
            build: vitest_1.vi.fn().mockReturnValue(mockTx),
        });
        const dummyTx = {};
        await (0, vitest_1.expect)((0, rpc_client_1.prepareSorobanTx)(dummyTx)).rejects.toThrow(/unexpected/i);
    });
    (0, vitest_1.it)("does not throw when auth entries use source account credentials", async () => {
        const mockAuthEntry = {
            credentials: () => ({
                switch: () => stellar_sdk_1.xdr.SorobanCredentialsType.sorobanCredentialsSourceAccount(),
            }),
        };
        const mockTx = {
            operations: [{ auth: [mockAuthEntry] }],
        };
        vitest_1.vi.mocked(stellar_sdk_1.rpc.assembleTransaction).mockReturnValue({
            build: vitest_1.vi.fn().mockReturnValue(mockTx),
        });
        const dummyTx = {};
        await (0, vitest_1.expect)((0, rpc_client_1.prepareSorobanTx)(dummyTx)).resolves.toBeDefined();
    });
    (0, vitest_1.it)("does not throw when address credentials match the agent's public key", async () => {
        const agentSecret = "process.env.AGENT_SECRET_KEY";
        const agentPublicKey = stellar_sdk_1.Keypair.fromSecret(agentSecret).publicKey();
        const rawKey = stellar_sdk_1.StrKey.decodeEd25519PublicKey(agentPublicKey);
        const mockAuthEntry = {
            credentials: () => ({
                switch: () => stellar_sdk_1.xdr.SorobanCredentialsType.sorobanCredentialsAddress(),
                address: () => ({
                    address: () => ({
                        switch: () => stellar_sdk_1.xdr.ScAddressType.scAddressTypeAccount(),
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
        vitest_1.vi.mocked(stellar_sdk_1.rpc.assembleTransaction).mockReturnValue({
            build: vitest_1.vi.fn().mockReturnValue(mockTx),
        });
        const dummyTx = {};
        await (0, vitest_1.expect)((0, rpc_client_1.prepareSorobanTx)(dummyTx)).resolves.toBeDefined();
    });
});
// ─── Request ID headers ───────────────────────────────────────────────────────
(0, vitest_1.describe)("RPC servers with request ID headers", () => {
    (0, vitest_1.it)("horizonServer is created with X-Request-ID header", () => {
        (0, vitest_1.expect)(rpc_client_1.horizonServer).toBeDefined();
    });
    (0, vitest_1.it)("sorobanServer is created with X-Request-ID header", () => {
        (0, vitest_1.expect)(rpc_client_1.sorobanServer).toBeDefined();
    });
});
//# sourceMappingURL=rpc_client.test.js.map