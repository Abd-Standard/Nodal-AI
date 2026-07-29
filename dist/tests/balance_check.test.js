"use strict";
/**
 * tests/balance_check.test.ts
 *
 * Tests for BalanceCheckTool — covers input validation, balance filtering,
 * and network error propagation.
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
const BalanceCheckTool_1 = require("../backend/tools/BalanceCheckTool");
const rpcClient = __importStar(require("../backend/rpc_client"));
// ─── Module mocks ─────────────────────────────────────────────────────────────
vitest_1.vi.mock("../backend/rpc_client", () => ({
    loadAccount: vitest_1.vi.fn(),
    horizonServer: {},
    submitTransaction: vitest_1.vi.fn(),
    sorobanServer: {},
    simulateSorobanTx: vitest_1.vi.fn(),
    prepareSorobanTx: vitest_1.vi.fn(),
}));
vitest_1.vi.mock("../backend/config", () => ({
    config: {
        STELLAR_NETWORK: "testnet",
        HORIZON_URL: "https://horizon-testnet.stellar.org",
        SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
        X402_ASSET_CODE: "USDC",
        X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        MAX_RETRIES: 3,
        RETRY_DELAY_MS: 100,
        agentKeypair: () => ({ secret: () => "process.env.AGENT_SECRET_KEY" }),
    },
}));
// ─── Fixtures ─────────────────────────────────────────────────────────────────
const VALID_KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
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
(0, vitest_1.describe)("BalanceCheckTool", () => {
    let tool;
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
        tool = new BalanceCheckTool_1.BalanceCheckTool();
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue({ balances: MOCK_BALANCES });
    });
    // ── Input validation ────────────────────────────────────────────────────────
    (0, vitest_1.describe)("Input validation", () => {
        (0, vitest_1.it)("rejects a public key that is too short", async () => {
            await (0, vitest_1.expect)(tool.getBalance({ publicKey: "GABC123" })).rejects.toThrow(/Invalid Stellar public key/);
        });
        (0, vitest_1.it)("rejects a public key that is too long", async () => {
            await (0, vitest_1.expect)(tool.getBalance({ publicKey: "G".padEnd(57, "A") })).rejects.toThrow(/Invalid Stellar public key/);
        });
        (0, vitest_1.it)("rejects an assetIssuer that is not 56 chars", async () => {
            await (0, vitest_1.expect)(tool.getBalance({ publicKey: VALID_KEY, assetCode: "USDC", assetIssuer: "TOOSHORT" })).rejects.toThrow(/Invalid asset issuer address/);
        });
        (0, vitest_1.it)("accepts a valid public key with no optional fields", async () => {
            await (0, vitest_1.expect)(tool.getBalance({ publicKey: VALID_KEY })).resolves.toBeDefined();
        });
    });
    // ── Happy path ──────────────────────────────────────────────────────────────
    (0, vitest_1.describe)("Happy path", () => {
        (0, vitest_1.it)("returns the publicKey in the result", async () => {
            const result = await tool.getBalance({ publicKey: VALID_KEY });
            (0, vitest_1.expect)(result.publicKey).toBe(VALID_KEY);
        });
        (0, vitest_1.it)("returns all balances when no assetCode filter is given", async () => {
            const result = await tool.getBalance({ publicKey: VALID_KEY });
            (0, vitest_1.expect)(result.balances).toHaveLength(3);
        });
        (0, vitest_1.it)("filters to XLM only when assetCode is XLM", async () => {
            const result = await tool.getBalance({ publicKey: VALID_KEY, assetCode: "XLM" });
            (0, vitest_1.expect)(result.balances).toHaveLength(1);
            (0, vitest_1.expect)(result.balances[0]).toBeDefined();
            (0, vitest_1.expect)(result.balances[0].assetType).toBe("native");
        });
        (0, vitest_1.it)("filters to a specific non-native asset by assetCode", async () => {
            const result = await tool.getBalance({ publicKey: VALID_KEY, assetCode: "USDC" });
            (0, vitest_1.expect)(result.balances).toHaveLength(1);
            (0, vitest_1.expect)(result.balances[0]).toBeDefined();
            (0, vitest_1.expect)(result.balances[0].assetCode).toBe("USDC");
        });
        (0, vitest_1.it)("further filters by assetIssuer when provided", async () => {
            const result = await tool.getBalance({
                publicKey: VALID_KEY,
                assetCode: "USDC",
                assetIssuer: VALID_ISSUER,
            });
            (0, vitest_1.expect)(result.balances).toHaveLength(1);
            (0, vitest_1.expect)(result.balances[0]).toBeDefined();
            (0, vitest_1.expect)(result.balances[0].assetIssuer).toBe(VALID_ISSUER);
        });
        (0, vitest_1.it)("returns an empty array when filtered asset is not held", async () => {
            const result = await tool.getBalance({ publicKey: VALID_KEY, assetCode: "BTC" });
            (0, vitest_1.expect)(result.balances).toHaveLength(0);
        });
        (0, vitest_1.it)("maps assetCode and assetIssuer as undefined for native balance", async () => {
            const result = await tool.getBalance({ publicKey: VALID_KEY, assetCode: "XLM" });
            (0, vitest_1.expect)(result.balances[0]).toBeDefined();
            (0, vitest_1.expect)(result.balances[0].assetCode).toBeUndefined();
            (0, vitest_1.expect)(result.balances[0].assetIssuer).toBeUndefined();
        });
        (0, vitest_1.it)("calls loadAccount with the provided public key", async () => {
            await tool.getBalance({ publicKey: VALID_KEY });
            (0, vitest_1.expect)(rpcClient.loadAccount).toHaveBeenCalledOnce();
            (0, vitest_1.expect)(rpcClient.loadAccount).toHaveBeenCalledWith(VALID_KEY);
        });
    });
    // ── Network error handling ──────────────────────────────────────────────────
    (0, vitest_1.describe)("Network error handling", () => {
        (0, vitest_1.it)("propagates account not found error", async () => {
            vitest_1.vi.mocked(rpcClient.loadAccount).mockRejectedValue(new Error("Horizon: account not found (404)"));
            await (0, vitest_1.expect)(tool.getBalance({ publicKey: VALID_KEY })).rejects.toThrow(/account not found/);
        });
        (0, vitest_1.it)("propagates a generic network error", async () => {
            vitest_1.vi.mocked(rpcClient.loadAccount).mockRejectedValue(new Error("503 Service Unavailable"));
            await (0, vitest_1.expect)(tool.getBalance({ publicKey: VALID_KEY })).rejects.toThrow(/503/);
        });
    });
});
//# sourceMappingURL=balance_check.test.js.map