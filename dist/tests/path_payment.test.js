"use strict";
/**
 * tests/path_payment.test.ts
 * Tests for PathPaymentTool covering happy path, slippage rejection,
 * input validation, self-payment guard, and tx_bad_seq retry.
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
const PathPaymentTool_1 = require("../backend/tools/PathPaymentTool");
const rpcClient = __importStar(require("../backend/rpc_client"));
// ─── Mocks ────────────────────────────────────────────────────────────────────
vitest_1.vi.mock("../backend/rpc_client", () => ({
    loadAccount: vitest_1.vi.fn(),
    submitTransaction: vitest_1.vi.fn(),
    horizonServer: {},
    sorobanServer: {},
    simulateSorobanTx: vitest_1.vi.fn(),
    prepareSorobanTx: vitest_1.vi.fn(),
    resolveNetworkPassphrase: vitest_1.vi.fn(() => "Test SDF Network ; September 2015"),
}));
vitest_1.vi.mock("../backend/config", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Keypair } = require("@stellar/stellar-sdk"); // eslint-disable-line @typescript-eslint/no-var-requires
    const secret = "process.env.AGENT_SECRET_KEY";
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
const TEST_SECRET = "process.env.AGENT_SECRET_KEY";
const VALID_DEST = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const USDC_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
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
// ─── Tests ────────────────────────────────────────────────────────────────────
(0, vitest_1.describe)("PathPaymentTool", () => {
    let tool;
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
        tool = new PathPaymentTool_1.PathPaymentTool(TEST_SECRET);
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount(tool.publicKey));
        vitest_1.vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
            hash: "path_tx_hash",
            ledger: 100,
        });
    });
    // ── Happy path ──────────────────────────────────────────────────────────────
    (0, vitest_1.it)("executes XLM → USDC path payment and returns txHash + ledger", async () => {
        const result = await tool.execute({
            destination: VALID_DEST,
            sendAsset: { code: "XLM" },
            sendAmount: "10",
            destAsset: { code: "USDC", issuer: USDC_ISSUER },
            destMinAmount: "9",
        });
        (0, vitest_1.expect)(result.txHash).toBe("path_tx_hash");
        (0, vitest_1.expect)(result.ledger).toBe(100);
        (0, vitest_1.expect)(rpcClient.loadAccount).toHaveBeenCalledWith(tool.publicKey);
        (0, vitest_1.expect)(rpcClient.submitTransaction).toHaveBeenCalledOnce();
    });
    (0, vitest_1.it)("accepts an optional intermediate path asset", async () => {
        const result = await tool.execute({
            destination: VALID_DEST,
            sendAsset: { code: "XLM" },
            sendAmount: "10",
            destAsset: { code: "USDC", issuer: USDC_ISSUER },
            destMinAmount: "9",
            path: [{ code: "USD", issuer: USDC_ISSUER }],
        });
        (0, vitest_1.expect)(result.txHash).toBe("path_tx_hash");
    });
    (0, vitest_1.it)("accepts a memo when provided", async () => {
        const result = await tool.execute({
            destination: VALID_DEST,
            sendAsset: { code: "XLM" },
            sendAmount: "5",
            destAsset: { code: "USDC", issuer: USDC_ISSUER },
            destMinAmount: "4",
            memo: "swap-ref-123",
        });
        (0, vitest_1.expect)(result.txHash).toBe("path_tx_hash");
    });
    (0, vitest_1.it)("accepts memo type 'id' with numeric value", async () => {
        const result = await tool.execute({
            destination: VALID_DEST,
            sendAsset: { code: "XLM" },
            sendAmount: "5",
            destAsset: { code: "USDC", issuer: USDC_ISSUER },
            destMinAmount: "4",
            memoType: "id",
            memo: 987654321,
        });
        (0, vitest_1.expect)(result.txHash).toBe("path_tx_hash");
    });
    (0, vitest_1.it)("accepts memo type 'hash' with 32-byte hex string", async () => {
        const result = await tool.execute({
            destination: VALID_DEST,
            sendAsset: { code: "XLM" },
            sendAmount: "5",
            destAsset: { code: "USDC", issuer: USDC_ISSUER },
            destMinAmount: "4",
            memoType: "hash",
            memo: "b".repeat(64),
        });
        (0, vitest_1.expect)(result.txHash).toBe("path_tx_hash");
    });
    (0, vitest_1.it)("accepts memo type 'return' with 32-byte hex string", async () => {
        const result = await tool.execute({
            destination: VALID_DEST,
            sendAsset: { code: "XLM" },
            sendAmount: "5",
            destAsset: { code: "USDC", issuer: USDC_ISSUER },
            destMinAmount: "4",
            memoType: "return",
            memo: "c".repeat(64),
        });
        (0, vitest_1.expect)(result.txHash).toBe("path_tx_hash");
    });
    // ── Input validation ────────────────────────────────────────────────────────
    (0, vitest_1.it)("rejects missing destination", async () => {
        await (0, vitest_1.expect)(tool.execute({
            sendAsset: { code: "XLM" },
            sendAmount: "10",
            destAsset: { code: "USDC", issuer: USDC_ISSUER },
            destMinAmount: "9",
        })).rejects.toThrow();
    });
    (0, vitest_1.it)("rejects non-XLM sendAsset without issuer", async () => {
        await (0, vitest_1.expect)(tool.execute({
            destination: VALID_DEST,
            sendAsset: { code: "USDC" }, // missing issuer
            sendAmount: "10",
            destAsset: { code: "XLM" },
            destMinAmount: "9",
        })).rejects.toThrow(/Asset issuer is required/);
    });
    (0, vitest_1.it)("rejects zero sendAmount", async () => {
        await (0, vitest_1.expect)(tool.execute({
            destination: VALID_DEST,
            sendAsset: { code: "XLM" },
            sendAmount: "0",
            destAsset: { code: "USDC", issuer: USDC_ISSUER },
            destMinAmount: "9",
        })).rejects.toThrow(/sendAmount must be/);
    });
    (0, vitest_1.it)("rejects self-payment", async () => {
        await (0, vitest_1.expect)(tool.execute({
            destination: tool.publicKey,
            sendAsset: { code: "XLM" },
            sendAmount: "10",
            destAsset: { code: "USDC", issuer: USDC_ISSUER },
            destMinAmount: "9",
        })).rejects.toThrow("Payment destination cannot be the agent's own address");
    });
    // ── Slippage / network errors ────────────────────────────────────────────────
    (0, vitest_1.it)("propagates op_under_dest_min (slippage rejection) from Horizon", async () => {
        vitest_1.vi.mocked(rpcClient.submitTransaction).mockRejectedValue(new Error("Horizon: op_under_dest_min — destination minimum not met"));
        await (0, vitest_1.expect)(tool.execute({
            destination: VALID_DEST,
            sendAsset: { code: "XLM" },
            sendAmount: "1",
            destAsset: { code: "USDC", issuer: USDC_ISSUER },
            destMinAmount: "999",
        })).rejects.toThrow(/op_under_dest_min/);
    });
    (0, vitest_1.it)("recovers from tx_bad_seq on first retry", async () => {
        vitest_1.vi.mocked(rpcClient.submitTransaction)
            .mockRejectedValueOnce(new Error("Horizon: tx_bad_seq — sequence number is not valid"))
            .mockResolvedValueOnce({ hash: "retry_hash", ledger: 42 });
        const result = await tool.execute({
            destination: VALID_DEST,
            sendAsset: { code: "XLM" },
            sendAmount: "10",
            destAsset: { code: "USDC", issuer: USDC_ISSUER },
            destMinAmount: "9",
        });
        (0, vitest_1.expect)(result.txHash).toBe("retry_hash");
        (0, vitest_1.expect)(rpcClient.submitTransaction).toHaveBeenCalledTimes(2);
    });
});
//# sourceMappingURL=path_payment.test.js.map