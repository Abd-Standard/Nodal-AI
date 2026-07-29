"use strict";
/**
 * tests/account_info.test.ts
 * Tests for AccountInfoTool (#106)
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
const AccountInfoTool_1 = require("../backend/tools/AccountInfoTool");
const rpcClient = __importStar(require("../backend/rpc_client"));
vitest_1.vi.mock("../backend/rpc_client", () => ({
    loadAccount: vitest_1.vi.fn(),
    horizonServer: {},
    sorobanServer: {},
    submitTransaction: vitest_1.vi.fn(),
    simulateSorobanTx: vitest_1.vi.fn(),
    prepareSorobanTx: vitest_1.vi.fn(),
}));
vitest_1.vi.mock("../backend/config", () => ({
    config: {
        STELLAR_NETWORK: "testnet",
        HORIZON_URL: "https://horizon-testnet.stellar.org",
        SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
        AGENT_PUBLIC_KEY: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        X402_ASSET_CODE: "USDC",
        X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        MAX_RETRIES: 3,
        RETRY_DELAY_MS: 100,
        AGENT_SPENDING_LIMIT: "100",
        agentKeypair: () => ({ secret: () => "process.env.AGENT_SECRET_KEY" }),
    },
}));
const AGENT_KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
function makeMockAccount(overrides = {}) {
    return {
        accountId: () => AGENT_KEY,
        sequenceNumber: () => "1234567890",
        subentry_count: 2,
        balances: [
            { asset_type: "native", balance: "100.0000000" },
            {
                asset_type: "credit_alphanum4",
                asset_code: "USDC",
                asset_issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
                balance: "50.0000000",
            },
        ],
        ...overrides,
    };
}
(0, vitest_1.describe)("AccountInfoTool", () => {
    let tool;
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
        tool = new AccountInfoTool_1.AccountInfoTool();
    });
    (0, vitest_1.it)("returns AccountInfo with correct publicKey", async () => {
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount());
        const info = await tool.fetch();
        (0, vitest_1.expect)(info.publicKey).toBe(AGENT_KEY);
    });
    (0, vitest_1.it)("maps native balance to 'XLM'", async () => {
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount());
        const info = await tool.fetch();
        const xlm = info.balances.find((b) => b.asset === "XLM");
        (0, vitest_1.expect)(xlm).toBeDefined();
        (0, vitest_1.expect)(xlm.balance).toBe("100.0000000");
    });
    (0, vitest_1.it)("maps non-native balance to 'CODE:ISSUER' format", async () => {
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount());
        const info = await tool.fetch();
        const usdc = info.balances.find((b) => b.asset.startsWith("USDC:"));
        (0, vitest_1.expect)(usdc).toBeDefined();
        (0, vitest_1.expect)(usdc.balance).toBe("50.0000000");
    });
    (0, vitest_1.it)("returns correct sequenceNumber", async () => {
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount());
        const info = await tool.fetch();
        (0, vitest_1.expect)(info.sequenceNumber).toBe("1234567890");
    });
    (0, vitest_1.it)("returns correct subentryCount", async () => {
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount());
        const info = await tool.fetch();
        (0, vitest_1.expect)(info.subentryCount).toBe(2);
    });
    (0, vitest_1.it)("returns publicKey, balances, sequenceNumber, and subentryCount in one call", async () => {
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount());
        const info = await tool.fetch();
        (0, vitest_1.expect)(info).toMatchObject({
            publicKey: AGENT_KEY,
            sequenceNumber: "1234567890",
            subentryCount: 2,
        });
        (0, vitest_1.expect)(Array.isArray(info.balances)).toBe(true);
        (0, vitest_1.expect)(info.balances.length).toBeGreaterThan(0);
    });
    (0, vitest_1.it)("returns empty balances array for an account with no balances", async () => {
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount({ balances: [] }));
        const info = await tool.fetch();
        (0, vitest_1.expect)(info.balances).toEqual([]);
    });
    (0, vitest_1.it)("propagates loadAccount error", async () => {
        vitest_1.vi.mocked(rpcClient.loadAccount).mockRejectedValue(new Error("account not found"));
        await (0, vitest_1.expect)(tool.fetch()).rejects.toThrow("account not found");
    });
});
//# sourceMappingURL=account_info.test.js.map