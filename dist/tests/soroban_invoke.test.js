"use strict";
/**
 * tests/soroban_invoke.test.ts
 *
 * Comprehensive test suite for SorobanInvokeTool.
 * Covers: simulation gate, happy path, ERROR/FAILED status handling,
 * polling timeout, invalid inputs, and dry-run mode.
 *
 * ## Mock Architecture
 *
 * This suite uses vi.mock() at the module level to mock two critical dependencies:
 *
 * 1. **rpcClient**: The RPC abstraction layer that communicates with Horizon and Soroban.
 *    - Allows us to test SorobanInvokeTool in complete isolation from network calls.
 *    - Each test configures the mock's return values to simulate different network scenarios
 *      (SUCCESS, FAILED, NOT_FOUND, ERROR statuses, timeouts, etc.).
 *    - The mock is cleared before each test via vi.clearAllMocks() (from vitest.config.ts).
 *
 * 2. **config**: The environment configuration (network URLs, agent keypair, thresholds).
 *    - Mocked to return predictable, test-friendly values.
 *    - Prevents the test from requiring actual environment variables or .env files.
 *
 * ## Why isolate: true Matters Here
 *
 * With vitest.config.ts set to isolate: true, each test file gets its own V8 context:
 * - Mock definitions (vi.mock()) apply only to this test file.
 * - Other test files can mock the same modules differently without interference.
 * - Global state (vi.clearAllMocks(), test instance) is not shared between files.
 *
 * Example: If balance_check.test.ts also mocks rpcClient, it won't affect this file's mocks.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const SorobanInvokeTool_1 = require("../backend/tools/SorobanInvokeTool");
const rpcClient = __importStar(require("../backend/rpc_client"));
// ─── Module mock ──────────────────────────────────────────────────────────────
/**
 * Mock the rpc_client module to intercept all calls to Horizon and Soroban RPC.
 *
 * Each function (loadAccount, prepareSorobanTx, etc.) is mocked with vi.fn(),
 * allowing tests to define return values or rejection behavior on a per-test basis.
 *
 * The sorobanServer object contains sendTransaction and getTransaction, which are
 * critical for the polling mechanism that confirms transaction settlement.
 */
vitest_1.vi.mock("../backend/rpc_client", () => ({
    loadAccount: vitest_1.vi.fn(),
    submitTransaction: vitest_1.vi.fn(),
    simulateSorobanTx: vitest_1.vi.fn(),
    prepareSorobanTx: vitest_1.vi.fn(),
    horizonServer: {},
    sorobanServer: {
        sendTransaction: vitest_1.vi.fn(),
        getTransaction: vitest_1.vi.fn(),
    },
}));
/**
 * Mock the config module to provide a predictable environment.
 *
 * In real use, config.ts reads from process.env or .env files.
 * Here, we statically return test credentials and thresholds.
 *
 * Note: The AGENT_SECRET_KEY is a Stellar secret key used in tests only.
 * It is never used in actual signed transactions in this test suite
 * because all RPC calls are mocked.
 */
vitest_1.vi.mock("../backend/config", () => {
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
        },
    };
});
// ─── Fixtures ─────────────────────────────────────────────────────────────────
/**
 * Test fixtures: reusable constants and helper functions.
 */
const TEST_SECRET = "SBZ7EYXHNB4WPPIWC5YAMH2U4L4QU6DKYXQWG4I55G6O4CLE4BBHCE73";
const VALID_CONTRACT = "CDPVBHPSVYKWSI5ECEA4DASBG3RBNU5EHEE3DHNFX7RMBCZV66CSC7NH";
/**
 * makeMockAccount(publicKey): Constructs a mock Stellar account object.
 *
 * SorobanInvokeTool calls rpcClient.loadAccount() to fetch the agent's
 * current account details from Horizon. This mock account satisfies
 * that interface without hitting the network.
 *
 * Fields like sequenceNumber, thresholds, and signers are required
 * by the Stellar SDK's transaction building logic.
 */
function makeMockAccount(publicKey) {
    return {
        id: publicKey,
        accountId: () => publicKey,
        sequenceNumber: () => "100",
        incrementSequenceNumber: vitest_1.vi.fn(),
        sequence: "100",
        incrementedSequenceNumber: () => "101",
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        flags: {
            auth_required: false,
            auth_revocable: false,
            auth_immutable: false,
        },
        balances: [],
        signers: [],
        data_attr: {},
        subentry_count: 0,
    };
}
// ─── Tests ────────────────────────────────────────────────────────────────────
(0, vitest_1.describe)("SorobanInvokeTool", () => {
    let tool;
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
        tool = new SorobanInvokeTool_1.SorobanInvokeTool();
    });
    // ── Input validation ────────────────────────────────────────────────────────
    /**
     * Input validation tests: ensure SorobanInvokeTool rejects malformed inputs
     * before any network call is attempted.
     *
     * These are fast unit tests that don't need mocked RPC calls since they
     * reject at the parameter validation layer.
     */
    (0, vitest_1.describe)("Input validation", () => {
        (0, vitest_1.it)("rejects a contractId that is too short", async () => {
            await (0, vitest_1.expect)(tool.execute({ contractId: "bad_id", method: "release", args: [] })).rejects.toThrow(/Invalid Stellar contract ID/);
        });
        (0, vitest_1.it)("rejects a contractId that is too long (57 chars)", async () => {
            await (0, vitest_1.expect)(tool.execute({
                contractId: "C".padEnd(57, "A"),
                method: "release",
                args: [],
            })).rejects.toThrow(/Invalid Stellar contract ID/);
        });
        (0, vitest_1.it)("rejects an empty method name", async () => {
            await (0, vitest_1.expect)(tool.execute({ contractId: VALID_CONTRACT, method: "", args: [] })).rejects.toThrow();
        });
        (0, vitest_1.it)("rejects missing contractId", async () => {
            await (0, vitest_1.expect)(tool.execute({ method: "release", args: [] })).rejects.toThrow();
        });
    });
    // ── Simulation gate (mandatory) ─────────────────────────────────────────────
    /**
     * Simulation gate tests: the core safety mechanism of SorobanInvokeTool.
     *
     * Every Soroban invocation must first run through prepareSorobanTx(), which
     * performs a dry-run simulation on the Soroban RPC server. Only if the
     * simulation succeeds (no errors) does the transaction proceed to broadcast.
     *
     * This prevents:
     * - Submitting transactions that will fail on-chain (wasting fees).
     * - Executing unauthorized contract calls or insufficient balance scenarios.
     * - Introducing bad state in the contract due to failed side effects.
     *
     * Tests here verify:
     * 1. prepareSorobanTx is ALWAYS called before submission.
     * 2. If simulation fails, submission is SKIPPED and an error is thrown.
     * 3. Dry-run mode (simulateOnly=true) runs the simulation but skips broadcast.
     */
    (0, vitest_1.describe)("Simulation gate", () => {
        (0, vitest_1.beforeEach)(() => {
            vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"));
        });
        (0, vitest_1.it)("calls prepareSorobanTx before any submission", async () => {
            vitest_1.vi.mocked(rpcClient.prepareSorobanTx).mockResolvedValue({
                sign: vitest_1.vi.fn(),
            });
            vitest_1.vi.mocked(rpcClient.sorobanServer.sendTransaction).mockResolvedValue({
                status: "PENDING",
                hash: "sim_test_hash",
            });
            vitest_1.vi.mocked(rpcClient.sorobanServer.getTransaction).mockResolvedValue({
                status: "SUCCESS",
            });
            await tool.execute({
                contractId: VALID_CONTRACT,
                method: "release",
                args: [],
            });
            (0, vitest_1.expect)(rpcClient.prepareSorobanTx).toHaveBeenCalledOnce();
        });
        (0, vitest_1.it)("throws and does NOT submit when simulation fails", async () => {
            vitest_1.vi.mocked(rpcClient.prepareSorobanTx).mockRejectedValue(new Error("Soroban simulation failed: insufficient balance"));
            await (0, vitest_1.expect)(tool.execute({
                contractId: VALID_CONTRACT,
                method: "release",
                args: [],
            })).rejects.toThrow(/simulation failed/);
            (0, vitest_1.expect)(rpcClient.sorobanServer.sendTransaction).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)("throws when simulation fails with contract error code", async () => {
            vitest_1.vi.mocked(rpcClient.prepareSorobanTx).mockRejectedValue(new Error("Soroban simulation failed: Error(Contract, #3)"));
            await (0, vitest_1.expect)(tool.execute({
                contractId: VALID_CONTRACT,
                method: "release",
                args: [],
            })).rejects.toThrow(/simulation failed/);
        });
        (0, vitest_1.it)("does NOT call sendTransaction when simulateOnly=true", async () => {
            vitest_1.vi.mocked(rpcClient.prepareSorobanTx).mockResolvedValue({
                sign: vitest_1.vi.fn(),
            });
            const result = await tool.execute({
                contractId: VALID_CONTRACT,
                method: "release",
                args: [],
                simulateOnly: true,
            });
            (0, vitest_1.expect)(rpcClient.sorobanServer.sendTransaction).not.toHaveBeenCalled();
            (0, vitest_1.expect)(result.simulationResult).toBeDefined();
        });
    });
    // ── Submission and confirmation polling ─────────────────────────────────────
    /**
     * Submission and confirmation polling tests: verify transaction lifecycle after
     * a successful simulation.
     *
     * After prepareSorobanTx succeeds, the transaction envelope is signed and
     * submitted to sorobanServer.sendTransaction(). The submission returns a
     * PENDING status and a txHash. SorobanInvokeTool then polls sorobanServer.getTransaction()
     * repeatedly until the transaction reaches a terminal state (SUCCESS, FAILED, ERROR).
     *
     * Tests here cover:
     * 1. Happy path: immediate confirmation on the first poll.
     * 2. Retries: transaction confirmed after multiple NOT_FOUND polls.
     * 3. Failure: on-chain FAILED or ERROR statuses are caught and re-thrown.
     * 4. Timeout: polling window exhausted without reaching a terminal state.
     *
     * The polling interval and retry count are defined in config (RETRY_DELAY_MS).
     */
    (0, vitest_1.describe)("Submission and confirmation polling", () => {
        (0, vitest_1.beforeEach)(() => {
            vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"));
            vitest_1.vi.mocked(rpcClient.prepareSorobanTx).mockResolvedValue({
                sign: vitest_1.vi.fn(),
            });
        });
        (0, vitest_1.it)("returns txHash after a successful confirmation on first poll", async () => {
            vitest_1.vi.mocked(rpcClient.sorobanServer.sendTransaction).mockResolvedValue({
                status: "PENDING",
                hash: "confirmed_hash",
            });
            vitest_1.vi.mocked(rpcClient.sorobanServer.getTransaction).mockResolvedValue({
                status: "SUCCESS",
            });
            const result = await tool.execute({
                contractId: VALID_CONTRACT,
                method: "release",
                args: [],
            });
            (0, vitest_1.expect)(result.txHash).toBe("confirmed_hash");
        });
        (0, vitest_1.it)("polls multiple times before SUCCESS", async () => {
            vitest_1.vi.mocked(rpcClient.sorobanServer.sendTransaction).mockResolvedValue({
                status: "PENDING",
                hash: "slow_confirm_hash",
            });
            vitest_1.vi.mocked(rpcClient.sorobanServer.getTransaction)
                .mockResolvedValueOnce({ status: "NOT_FOUND" })
                .mockResolvedValueOnce({ status: "NOT_FOUND" })
                .mockResolvedValueOnce({ status: "SUCCESS" });
            const result = await tool.execute({
                contractId: VALID_CONTRACT,
                method: "release",
                args: [],
            });
            (0, vitest_1.expect)(result.txHash).toBe("slow_confirm_hash");
            (0, vitest_1.expect)(rpcClient.sorobanServer.getTransaction).toHaveBeenCalledTimes(3);
        });
        (0, vitest_1.it)("throws when on-chain status is FAILED", async () => {
            vitest_1.vi.mocked(rpcClient.sorobanServer.sendTransaction).mockResolvedValue({
                status: "PENDING",
                hash: "failed_on_chain_hash",
            });
            vitest_1.vi.mocked(rpcClient.sorobanServer.getTransaction).mockResolvedValue({
                status: "FAILED",
            });
            let error;
            try {
                await tool.execute({
                    contractId: VALID_CONTRACT,
                    method: "release",
                    args: [],
                });
            }
            catch (e) {
                error = e;
            }
            (0, vitest_1.expect)(error).toBeDefined();
            (0, vitest_1.expect)(error.message).toMatch(/failed on-chain/);
            (0, vitest_1.expect)(error.message).toContain("failed_on_chain_hash");
        });
        (0, vitest_1.it)("throws when sendTransaction returns ERROR status", async () => {
            vitest_1.vi.mocked(rpcClient.sorobanServer.sendTransaction).mockResolvedValue({
                status: "ERROR",
                errorResult: { toXDR: () => "base64_error_xdr" },
                hash: "error_hash",
            });
            await (0, vitest_1.expect)(tool.execute({
                contractId: VALID_CONTRACT,
                method: "release",
                args: [],
            })).rejects.toThrow(/Soroban submit failed/);
        });
        (0, vitest_1.it)("throws when polling window is exhausted (timeout)", async () => {
            vitest_1.vi.mocked(rpcClient.sorobanServer.sendTransaction).mockResolvedValue({
                status: "PENDING",
                hash: "never_confirms_hash",
            });
            // Always return NOT_FOUND — simulates a stalled transaction
            vitest_1.vi.mocked(rpcClient.sorobanServer.getTransaction).mockResolvedValue({
                status: "NOT_FOUND",
            });
            await (0, vitest_1.expect)(tool.execute({
                contractId: VALID_CONTRACT,
                method: "release",
                args: [],
            })).rejects.toThrow(/not confirmed within polling window/);
        }, 5_000); // RETRY_DELAY_MS=100 → intervalMs=200ms × 10 attempts ≈ 2s
    });
    // ── Network error handling ──────────────────────────────────────────────────
    /**
     * Network error handling tests: ensure SorobanInvokeTool gracefully surfaces
     * network-level failures.
     *
     * These tests mock network errors (timeouts, 404s) at various points in the
     * call chain (account load, simulation, submission) and verify that they
     * propagate to the caller without being swallowed or retried indefinitely.
     *
     * This is important for user code to distinguish between:
     * - Transient network glitches (worth retrying at the application level).
     * - Permanent errors like "account not found" (require manual intervention).
     */
    (0, vitest_1.describe)("Network error handling", () => {
        (0, vitest_1.beforeEach)(() => {
            vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"));
        });
        (0, vitest_1.it)("propagates network timeout on prepareSorobanTx", async () => {
            vitest_1.vi.mocked(rpcClient.prepareSorobanTx).mockRejectedValue(new Error("ECONNABORTED: network timeout"));
            await (0, vitest_1.expect)(tool.execute({
                contractId: VALID_CONTRACT,
                method: "release",
                args: [],
            })).rejects.toThrow(/timeout/);
        });
        (0, vitest_1.it)("propagates account load failure", async () => {
            vitest_1.vi.mocked(rpcClient.loadAccount).mockRejectedValue(new Error("Horizon: account not found (404)"));
            await (0, vitest_1.expect)(tool.execute({
                contractId: VALID_CONTRACT,
                method: "release",
                args: [],
            })).rejects.toThrow(/not found/);
        });
    });
    // ── Args validation ────────────────────────────────────────────────────────
    (0, vitest_1.describe)("args validation", () => {
        (0, vitest_1.it)("rejects plain JavaScript object in args array", () => {
            const result = SorobanInvokeTool_1.SorobanInvokeInputSchema.safeParse({
                contractId: VALID_CONTRACT,
                method: "test",
                args: [{}],
            });
            (0, vitest_1.expect)(result.success).toBe(false);
        });
        (0, vitest_1.it)("accepts xdr.ScVal instance from nativeToScVal", () => {
            const scVal = (0, stellar_sdk_1.nativeToScVal)(42, { type: "u32" });
            const result = SorobanInvokeTool_1.SorobanInvokeInputSchema.safeParse({
                contractId: VALID_CONTRACT,
                method: "test",
                args: [scVal],
            });
            (0, vitest_1.expect)(result.success).toBe(true);
            (0, vitest_1.expect)(result.data?.args).toHaveLength(1);
        });
        (0, vitest_1.it)("rejects null args", () => {
            const result = SorobanInvokeTool_1.SorobanInvokeInputSchema.safeParse({
                contractId: VALID_CONTRACT,
                method: "test",
                args: null,
            });
            (0, vitest_1.expect)(result.success).toBe(false);
        });
        (0, vitest_1.it)("accepts empty args array as default", () => {
            const result = SorobanInvokeTool_1.SorobanInvokeInputSchema.safeParse({
                contractId: VALID_CONTRACT,
                method: "test",
            });
            (0, vitest_1.expect)(result.success).toBe(true);
            (0, vitest_1.expect)(result.data?.args).toEqual([]);
        });
        (0, vitest_1.it)("accepts multiple xdr.ScVal instances", () => {
            const arg1 = (0, stellar_sdk_1.nativeToScVal)(100n, { type: "i128" });
            const arg2 = (0, stellar_sdk_1.nativeToScVal)("GABC", { type: "address" });
            const result = SorobanInvokeTool_1.SorobanInvokeInputSchema.safeParse({
                contractId: VALID_CONTRACT,
                method: "test",
                args: [arg1, arg2],
            });
            (0, vitest_1.expect)(result.success).toBe(true);
            (0, vitest_1.expect)(result.data?.args).toHaveLength(2);
        });
    });
});
//# sourceMappingURL=soroban_invoke.test.js.map