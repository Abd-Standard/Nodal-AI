"use strict";
/**
 * tests/payment.test.ts
 *
 * Comprehensive test suite for StellarPaymentTool.
 * Covers: happy path, input validation, network errors, retry exhaustion,
 * timeout simulation, insufficient funds, and memo edge cases.
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
const StellarPaymentTool_1 = require("../backend/tools/StellarPaymentTool");
const rpcClient = __importStar(require("../backend/rpc_client"));
// ─── Module mock ──────────────────────────────────────────────────────────────
// All Horizon/Soroban network calls are intercepted here.
vitest_1.vi.mock("../backend/rpc_client", () => ({
    loadAccount: vitest_1.vi.fn(),
    submitTransaction: vitest_1.vi.fn(),
    horizonServer: {},
    sorobanServer: {},
    simulateSorobanTx: vitest_1.vi.fn(),
    prepareSorobanTx: vitest_1.vi.fn(),
}));
// ─── Mock config — isolate from real .env ─────────────────────────────────────
vitest_1.vi.mock("../backend/config", () => {
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
const VALID_DEST = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const VALID_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
/** Minimal account object that satisfies TransactionBuilder */
function makeMockAccount(publicKey) {
    return {
        id: publicKey,
        accountId: () => publicKey,
        sequenceNumber: () => "100",
        incrementSequenceNumber: vitest_1.vi.fn(),
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
(0, vitest_1.describe)("StellarPaymentTool", () => {
    let tool;
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
        tool = new StellarPaymentTool_1.StellarPaymentTool();
        // Default: return a minimal valid account for TransactionBuilder
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount(tool.publicKey));
    });
    // ── Input validation ────────────────────────────────────────────────────────
    (0, vitest_1.describe)("Input validation", () => {
        (0, vitest_1.it)("rejects a destination key that is too short", async () => {
            await (0, vitest_1.expect)(tool.execute({ destination: "GABC123", amount: "10", assetCode: "XLM" })).rejects.toThrow(/Invalid Stellar public key/);
        });
        (0, vitest_1.it)("rejects a destination key that is too long", async () => {
            await (0, vitest_1.expect)(tool.execute({ destination: "G".padEnd(57, "A"), amount: "10", assetCode: "XLM" })).rejects.toThrow(/Invalid Stellar public key/);
        });
        (0, vitest_1.it)("rejects a negative amount", async () => {
            await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: "-1", assetCode: "XLM" })).rejects.toThrow(/Amount must be/);
        });
        (0, vitest_1.it)("rejects zero amount (not a valid Stellar decimal)", async () => {
            await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: "0", assetCode: "XLM" })).rejects.toThrow(/Amount must be/);
        });
        (0, vitest_1.it)("rejects amount with more than 7 decimal places", async () => {
            await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: "1.12345678", assetCode: "XLM" })).rejects.toThrow(/Amount must be/);
        });
        (0, vitest_1.it)("rejects self-payment (destination === agent public key)", async () => {
            await (0, vitest_1.expect)(tool.execute({ destination: tool.publicKey, amount: "1", assetCode: "XLM" })).rejects.toThrow("Payment destination cannot be the agent's own address");
        });
        (0, vitest_1.it)("rejects a non-XLM asset when issuer is missing", async () => {
            await (0, vitest_1.expect)(tool.execute({
                destination: VALID_DEST,
                amount: "10",
                assetCode: "USDC",
                assetIssuer: undefined,
            })).rejects.toThrow("Asset issuer is required for non-native asset USDC");
        });
        (0, vitest_1.it)("rejects a memo longer than 28 bytes", async () => {
            await (0, vitest_1.expect)(tool.execute({
                destination: VALID_DEST,
                amount: "1",
                assetCode: "XLM",
                memo: "A".repeat(29),
            })).rejects.toThrow();
        });
        (0, vitest_1.it)("accepts a 7-decimal amount (boundary)", async () => {
            vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount(tool.publicKey));
            vitest_1.vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
                hash: "boundary_hash",
                ledger: 1,
            });
            const result = await tool.execute({
                destination: VALID_DEST,
                amount: "0.0000001",
                assetCode: "XLM",
            });
            (0, vitest_1.expect)(result.txHash).toBe("boundary_hash");
        });
    });
    (0, vitest_1.describe)("memo boundary tests", () => {
        (0, vitest_1.beforeEach)(() => {
            vitest_1.vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
                hash: "boundary_hash",
                ledger: 1,
            });
        });
        (0, vitest_1.it)("accepts 28 ASCII characters", async () => {
            const result = await tool.execute({
                destination: VALID_DEST,
                amount: "1",
                assetCode: "XLM",
                memo: "a".repeat(28),
            });
            (0, vitest_1.expect)(result.txHash).toBe("boundary_hash");
        });
        (0, vitest_1.it)("rejects 14 two-byte UTF-8 characters (e.g. あ.repeat(14)) (42 bytes)", async () => {
            await (0, vitest_1.expect)(tool.execute({
                destination: VALID_DEST,
                amount: "1",
                assetCode: "XLM",
                memo: "あ".repeat(14),
            })).rejects.toThrow();
        });
        (0, vitest_1.it)("accepts a 28-byte multi-byte string", async () => {
            const result = await tool.execute({
                destination: VALID_DEST,
                amount: "1",
                assetCode: "XLM",
                memo: "я".repeat(14), // "я" is 2 bytes in UTF-8
            });
            (0, vitest_1.expect)(result.txHash).toBe("boundary_hash");
        });
    });
    // ── Happy path ──────────────────────────────────────────────────────────────
    (0, vitest_1.describe)("Happy path", () => {
        (0, vitest_1.beforeEach)(() => {
            vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount(tool.publicKey));
            vitest_1.vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
                hash: "success_tx_hash",
                ledger: 42,
            });
        });
        (0, vitest_1.it)("completes an XLM payment and returns txHash + ledger", async () => {
            const result = await tool.execute({
                destination: VALID_DEST,
                amount: "100",
                assetCode: "XLM",
            });
            (0, vitest_1.expect)(result.txHash).toBe("success_tx_hash");
            (0, vitest_1.expect)(result.ledger).toBe(42);
        });
        (0, vitest_1.it)("completes a custom asset payment (USDC)", async () => {
            const result = await tool.execute({
                destination: VALID_DEST,
                amount: "50.5",
                assetCode: "USDC",
                assetIssuer: VALID_ISSUER,
            });
            (0, vitest_1.expect)(result.txHash).toBe("success_tx_hash");
        });
        (0, vitest_1.it)("calls loadAccount with the agent public key", async () => {
            await tool.execute({ destination: VALID_DEST, amount: "1", assetCode: "XLM" });
            (0, vitest_1.expect)(rpcClient.loadAccount).toHaveBeenCalledOnce();
            (0, vitest_1.expect)(rpcClient.loadAccount).toHaveBeenCalledWith(tool.publicKey);
        });
        (0, vitest_1.it)("calls submitTransaction exactly once per payment", async () => {
            await tool.execute({ destination: VALID_DEST, amount: "1", assetCode: "XLM" });
            (0, vitest_1.expect)(rpcClient.submitTransaction).toHaveBeenCalledOnce();
        });
        (0, vitest_1.it)("embeds a memo when provided", async () => {
            // We just verify execute doesn't throw and the memo is accepted
            const result = await tool.execute({
                destination: VALID_DEST,
                amount: "1",
                assetCode: "XLM",
                memo: "test-memo-123",
            });
            (0, vitest_1.expect)(result.txHash).toBeTruthy();
        });
    });
    // ── Horizon / network error handling ────────────────────────────────────────
    (0, vitest_1.describe)("Network error handling", () => {
        (0, vitest_1.beforeEach)(() => {
            vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount(tool.publicKey));
        });
        (0, vitest_1.it)("propagates Horizon submission error", async () => {
            vitest_1.vi.mocked(rpcClient.submitTransaction).mockRejectedValue(new Error("Horizon: transaction failed — op_no_source_account"));
            await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: "1", assetCode: "XLM" })).rejects.toThrow(/op_no_source_account/);
        });
        (0, vitest_1.it)("surfaces insufficient funds error from Horizon", async () => {
            vitest_1.vi.mocked(rpcClient.submitTransaction).mockRejectedValue(new Error("Horizon: op_underfunded — insufficient balance"));
            await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: "999999", assetCode: "XLM" })).rejects.toThrow(/underfunded/);
        });
        (0, vitest_1.it)("propagates account not found error", async () => {
            vitest_1.vi.mocked(rpcClient.loadAccount).mockRejectedValue(new Error("Horizon: account not found (404)"));
            await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: "1", assetCode: "XLM" })).rejects.toThrow(/account not found/);
        });
        (0, vitest_1.it)("handles network timeout from loadAccount", async () => {
            vitest_1.vi.mocked(rpcClient.loadAccount).mockRejectedValue(Object.assign(new Error("ECONNABORTED: network timeout after 30000ms"), {
                code: "ECONNABORTED",
            }));
            await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: "1", assetCode: "XLM" })).rejects.toThrow(/timeout/i);
        });
        (0, vitest_1.it)("handles network timeout from submitTransaction", async () => {
            vitest_1.vi.mocked(rpcClient.submitTransaction).mockRejectedValue(Object.assign(new Error("ECONNABORTED: network timeout after 30000ms"), {
                code: "ECONNABORTED",
            }));
            await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: "1", assetCode: "XLM" })).rejects.toThrow(/timeout/i);
        });
        (0, vitest_1.it)("surfaces tx_bad_seq when sequence number is stale", async () => {
            vitest_1.vi.mocked(rpcClient.submitTransaction).mockRejectedValue(new Error("Horizon: tx_bad_seq — sequence number is not valid"));
            await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: "1", assetCode: "XLM" })).rejects.toThrow(/tx_bad_seq/);
        });
        (0, vitest_1.it)("recovers from tx_bad_seq on first retry", async () => {
            vitest_1.vi.mocked(rpcClient.submitTransaction)
                .mockRejectedValueOnce(new Error("Horizon: tx_bad_seq — sequence number is not valid"))
                .mockResolvedValueOnce({ hash: "retry_success_hash", ledger: 42 });
            const result = await tool.execute({
                destination: VALID_DEST,
                amount: "1",
                assetCode: "XLM",
            });
            (0, vitest_1.expect)(result.txHash).toBe("retry_success_hash");
            (0, vitest_1.expect)(result.ledger).toBe(42);
            (0, vitest_1.expect)(rpcClient.submitTransaction).toHaveBeenCalledTimes(2);
        });
        (0, vitest_1.it)("surfaces destination account non-existent (op_no_destination)", async () => {
            vitest_1.vi.mocked(rpcClient.submitTransaction).mockRejectedValue(new Error("Horizon: op_no_destination — destination account does not exist"));
            await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: "1", assetCode: "XLM" })).rejects.toThrow(/op_no_destination/);
        });
    });
    // ── Retry exhaustion ────────────────────────────────────────────────────────
    (0, vitest_1.describe)("Retry exhaustion", () => {
        (0, vitest_1.beforeEach)(() => {
            vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount(tool.publicKey));
        });
        (0, vitest_1.it)("throws after all retries are exhausted on loadAccount", async () => {
            // rpcClient.loadAccount is already wrapped in withRetry internally.
            // We simulate the final rejection reaching the tool.
            vitest_1.vi.mocked(rpcClient.loadAccount).mockRejectedValue(new Error("max retries exceeded: 503 Service Unavailable"));
            await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: "1", assetCode: "XLM" })).rejects.toThrow(/503/);
        });
        (0, vitest_1.it)("throws after all retries exhausted on submitTransaction", async () => {
            vitest_1.vi.mocked(rpcClient.submitTransaction).mockRejectedValue(new Error("max retries exceeded: Horizon unavailable"));
            await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: "1", assetCode: "XLM" })).rejects.toThrow(/Horizon unavailable/);
        });
    });
    // ── State verification ──────────────────────────────────────────────────────
    (0, vitest_1.describe)("State verification", () => {
        (0, vitest_1.it)("does not call submitTransaction when loadAccount fails", async () => {
            vitest_1.vi.mocked(rpcClient.loadAccount).mockRejectedValue(new Error("not found"));
            try {
                await tool.execute({ destination: VALID_DEST, amount: "1", assetCode: "XLM" });
            }
            catch (_) { /* expected */ }
            (0, vitest_1.expect)(rpcClient.submitTransaction).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)("exposes the agent public key", () => {
            (0, vitest_1.expect)(tool.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
        });
    });
    // ── Network passphrase selection ────────────────────────────────────────────
    (0, vitest_1.describe)("Network passphrase selection", () => {
        (0, vitest_1.it)("uses Networks.PUBLIC (mainnet) when STELLAR_NETWORK is mainnet", async () => {
            // Create a tool instance and inspect the signed transaction
            vitest_1.vi.resetModules();
            vitest_1.vi.mock("../backend/config", () => ({
                config: {
                    STELLAR_NETWORK: "mainnet",
                    HORIZON_URL: "https://horizon.stellar.org",
                    SOROBAN_RPC_URL: "https://soroban-mainnet.stellar.org",
                    X402_ASSET_CODE: "USDC",
                    X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
                    MAX_RETRIES: 3,
                    RETRY_DELAY_MS: 100,
                    AGENT_PUBLIC_KEY: stellar_sdk_1.Keypair.fromSecret(TEST_SECRET).publicKey(),
                    agentKeypair: () => stellar_sdk_1.Keypair.fromSecret(TEST_SECRET),
                },
            }));
            vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount(stellar_sdk_1.Keypair.fromSecret(TEST_SECRET).publicKey()));
            vitest_1.vi.mocked(rpcClient.submitTransaction).mockImplementation((xdr) => {
                // Verify XDR contains mainnet network passphrase
                (0, vitest_1.expect)(xdr).toContain("Public Global Stellar Network");
                return Promise.resolve({ hash: "mainnet_tx", ledger: 100 });
            });
            const mainnetTool = new StellarPaymentTool_1.StellarPaymentTool(TEST_SECRET);
            const result = await mainnetTool.execute({
                destination: VALID_DEST,
                amount: "1",
                assetCode: "XLM",
            });
            (0, vitest_1.expect)(result.txHash).toBe("mainnet_tx");
            (0, vitest_1.expect)(rpcClient.submitTransaction).toHaveBeenCalled();
        });
        (0, vitest_1.it)("uses Networks.FUTURENET when STELLAR_NETWORK is futurenet", async () => {
            vitest_1.vi.resetModules();
            vitest_1.vi.mock("../backend/config", () => ({
                config: {
                    STELLAR_NETWORK: "futurenet",
                    HORIZON_URL: "https://horizon-futurenet.stellar.org",
                    SOROBAN_RPC_URL: "https://soroban-futurenet.stellar.org",
                    X402_ASSET_CODE: "USDC",
                    X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
                    MAX_RETRIES: 3,
                    RETRY_DELAY_MS: 100,
                    AGENT_PUBLIC_KEY: stellar_sdk_1.Keypair.fromSecret(TEST_SECRET).publicKey(),
                    agentKeypair: () => stellar_sdk_1.Keypair.fromSecret(TEST_SECRET),
                },
            }));
            vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount(stellar_sdk_1.Keypair.fromSecret(TEST_SECRET).publicKey()));
            vitest_1.vi.mocked(rpcClient.submitTransaction).mockImplementation((xdr) => {
                // Verify XDR contains futurenet network passphrase
                (0, vitest_1.expect)(xdr).toContain("Future Network");
                return Promise.resolve({ hash: "futurenet_tx", ledger: 200 });
            });
            const futureNetTool = new StellarPaymentTool_1.StellarPaymentTool(TEST_SECRET);
            const result = await futureNetTool.execute({
                destination: VALID_DEST,
                amount: "1",
                assetCode: "XLM",
            });
            (0, vitest_1.expect)(result.txHash).toBe("futurenet_tx");
            (0, vitest_1.expect)(rpcClient.submitTransaction).toHaveBeenCalled();
        });
    });
});
//# sourceMappingURL=payment.test.js.map