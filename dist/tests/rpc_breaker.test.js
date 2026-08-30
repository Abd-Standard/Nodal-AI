"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const opossum_1 = __importDefault(require("opossum"));
// rpc_client imports config at module load, and loadConfig() calls
// process.exit(1) when required env vars are absent — so importing the module
// under test would kill the run before a single assertion. Mocked with valid
// values; the breaker logic under test never touches the network.
vitest_1.vi.mock("../backend/config", () => ({
    config: {
        HORIZON_URL: "https://horizon-testnet.stellar.org",
        SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
        STELLAR_NETWORK: "testnet",
        MAX_RETRIES: 1,
        RETRY_DELAY_MS: 1,
    },
}));
const rpc_client_1 = require("../backend/rpc_client");
/**
 * Issue #244 — circuit breaker behaviour.
 *
 * The breaker was wired up but never asserted, so a misconfiguration would
 * fail silently: the circuit simply never opening looks identical to a healthy
 * dependency until the outage that needed it.
 *
 * Tests build their own breaker over a controlled action rather than driving
 * the exported RPC breakers, which would require a live network.
 */
/** Trip the breaker by exceeding volumeThreshold with 100% failures. */
async function driveToOpen(breaker) {
    for (let i = 0; i < rpc_client_1.RPC_BREAKER_OPTIONS.volumeThreshold + 1; i++) {
        await breaker.fire().catch(() => undefined);
    }
}
(0, vitest_1.describe)("RPC circuit breaker", () => {
    (0, vitest_1.it)("uses thresholds that can actually trip", () => {
        // A volumeThreshold at or below zero, or a 100% error threshold, would
        // mean the breaker never opens in practice.
        (0, vitest_1.expect)(rpc_client_1.RPC_BREAKER_OPTIONS.volumeThreshold).toBeGreaterThan(0);
        (0, vitest_1.expect)(rpc_client_1.RPC_BREAKER_OPTIONS.errorThresholdPercentage).toBeGreaterThan(0);
        (0, vitest_1.expect)(rpc_client_1.RPC_BREAKER_OPTIONS.errorThresholdPercentage).toBeLessThanOrEqual(100);
        (0, vitest_1.expect)(rpc_client_1.RPC_BREAKER_OPTIONS.resetTimeout).toBeGreaterThan(0);
    });
    (0, vitest_1.it)("opens after the failure threshold is exceeded", async () => {
        const breaker = (0, rpc_client_1.createRpcBreaker)("test-open", async () => {
            throw new Error("upstream down");
        });
        (0, vitest_1.expect)(breaker.opened).toBe(false);
        await driveToOpen(breaker);
        (0, vitest_1.expect)(breaker.opened).toBe(true);
        breaker.shutdown();
    });
    (0, vitest_1.it)("rejects immediately while open instead of calling through", async () => {
        let calls = 0;
        const breaker = (0, rpc_client_1.createRpcBreaker)("test-shortcircuit", async () => {
            calls++;
            throw new Error("upstream down");
        });
        await driveToOpen(breaker);
        const callsWhenOpened = calls;
        await breaker.fire().catch(() => undefined);
        // The point of the breaker: further calls are short-circuited, so the
        // failing dependency stops being hammered.
        (0, vitest_1.expect)(calls).toBe(callsWhenOpened);
        breaker.shutdown();
    });
    (0, vitest_1.it)("transitions to half-open after resetTimeout", async () => {
        vitest_1.vi.useFakeTimers();
        try {
            const breaker = (0, rpc_client_1.createRpcBreaker)("test-halfopen", async () => {
                throw new Error("upstream down");
            });
            await driveToOpen(breaker);
            (0, vitest_1.expect)(breaker.opened).toBe(true);
            vitest_1.vi.advanceTimersByTime(rpc_client_1.RPC_BREAKER_OPTIONS.resetTimeout + 1);
            (0, vitest_1.expect)(breaker.halfOpen).toBe(true);
            breaker.shutdown();
        }
        finally {
            vitest_1.vi.useRealTimers();
        }
    });
    (0, vitest_1.it)("closes on a successful call in the half-open state", async () => {
        vitest_1.vi.useFakeTimers();
        let shouldFail = true;
        try {
            const breaker = (0, rpc_client_1.createRpcBreaker)("test-close", async () => {
                if (shouldFail)
                    throw new Error("upstream down");
                return "ok";
            });
            await driveToOpen(breaker);
            vitest_1.vi.advanceTimersByTime(rpc_client_1.RPC_BREAKER_OPTIONS.resetTimeout + 1);
            (0, vitest_1.expect)(breaker.halfOpen).toBe(true);
            shouldFail = false;
            vitest_1.vi.useRealTimers();
            await (0, vitest_1.expect)(breaker.fire()).resolves.toBe("ok");
            // Recovery must actually close the circuit, or traffic never resumes.
            (0, vitest_1.expect)(breaker.closed).toBe(true);
            breaker.shutdown();
        }
        finally {
            vitest_1.vi.useRealTimers();
        }
    });
    (0, vitest_1.it)("emits open, halfOpen and close events for telemetry", async () => {
        vitest_1.vi.useFakeTimers();
        let shouldFail = true;
        try {
            const breaker = new opossum_1.default(async () => {
                if (shouldFail)
                    throw new Error("upstream down");
                return "ok";
            }, { ...rpc_client_1.RPC_BREAKER_OPTIONS, name: "test-telemetry" });
            (0, rpc_client_1.attachBreakerTelemetry)(breaker, "test-telemetry");
            const seen = [];
            breaker.on("open", () => seen.push("open"));
            breaker.on("halfOpen", () => seen.push("halfOpen"));
            breaker.on("close", () => seen.push("close"));
            await driveToOpen(breaker);
            (0, vitest_1.expect)(seen).toContain("open");
            vitest_1.vi.advanceTimersByTime(rpc_client_1.RPC_BREAKER_OPTIONS.resetTimeout + 1);
            (0, vitest_1.expect)(seen).toContain("halfOpen");
            shouldFail = false;
            vitest_1.vi.useRealTimers();
            await breaker.fire();
            (0, vitest_1.expect)(seen).toContain("close");
            breaker.shutdown();
        }
        finally {
            vitest_1.vi.useRealTimers();
        }
    });
});
//# sourceMappingURL=rpc_breaker.test.js.map