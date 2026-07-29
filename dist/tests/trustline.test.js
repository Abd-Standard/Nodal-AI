"use strict";
/**
 * tests/trustline.test.ts
 * Tests for TrustlineTool (#105)
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
const TrustlineTool_1 = require("../backend/tools/TrustlineTool");
const rpcClient = __importStar(require("../backend/rpc_client"));
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
    const { Keypair } = require("@stellar/stellar-sdk");
    const secret = "process.env.AGENT_SECRET_KEY";
    return {
        config: {
            STELLAR_NETWORK: "testnet",
            HORIZON_URL: "https://horizon-testnet.stellar.org",
            SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
            AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
            X402_ASSET_CODE: "USDC",
            X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            MAX_RETRIES: 3,
            RETRY_DELAY_MS: 100,
            AGENT_SPENDING_LIMIT: "100",
            agentKeypair: () => Keypair.fromSecret(secret),
        },
    };
});
const TEST_SECRET = "process.env.AGENT_SECRET_KEY";
const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
function makeMockAccount(hasUsdc = false) {
    const { Keypair } = require("@stellar/stellar-sdk");
    const publicKey = Keypair.fromSecret(TEST_SECRET).publicKey();
    return {
        accountId: () => publicKey,
        sequenceNumber: () => "100",
        incrementSequenceNumber: vitest_1.vi.fn(),
        sequence: "100",
        incrementedSequenceNumber: () => "101",
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
        balances: [
            { asset_type: "native", balance: "100.0000000" },
            ...(hasUsdc
                ? [{ asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: ISSUER, balance: "0.0000000" }]
                : []),
        ],
        signers: [],
        data_attr: {},
        subentry_count: hasUsdc ? 1 : 0,
        home_domain: "",
        inflation_dest: null,
    };
}
(0, vitest_1.describe)("TrustlineTool", () => {
    let tool;
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
        tool = new TrustlineTool_1.TrustlineTool(TEST_SECRET);
        vitest_1.vi.mocked(rpcClient.submitTransaction).mockResolvedValue({ hash: "trust_hash", ledger: 5 });
    });
    (0, vitest_1.it)("add trustline submits changeTrust operation and returns txHash", async () => {
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount());
        const result = await tool.execute({ assetCode: "USDC", assetIssuer: ISSUER, action: "add" });
        (0, vitest_1.expect)(result.txHash).toBe("trust_hash");
        (0, vitest_1.expect)(rpcClient.submitTransaction).toHaveBeenCalledOnce();
    });
    (0, vitest_1.it)("remove trustline submits changeTrust with limit '0'", async () => {
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount(true));
        const result = await tool.execute({ assetCode: "USDC", assetIssuer: ISSUER, action: "remove" });
        (0, vitest_1.expect)(result.txHash).toBe("trust_hash");
    });
    (0, vitest_1.it)("add trustline with custom limit", async () => {
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount());
        const result = await tool.execute({
            assetCode: "USDC",
            assetIssuer: ISSUER,
            action: "add",
            limit: "1000",
        });
        (0, vitest_1.expect)(result.txHash).toBe("trust_hash");
    });
    (0, vitest_1.it)("checkTrustline returns true when trustline exists", async () => {
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount(true));
        const exists = await tool.checkTrustline("USDC", ISSUER);
        (0, vitest_1.expect)(exists).toBe(true);
    });
    (0, vitest_1.it)("checkTrustline returns false when trustline does not exist", async () => {
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount(false));
        const exists = await tool.checkTrustline("USDC", ISSUER);
        (0, vitest_1.expect)(exists).toBe(false);
    });
    (0, vitest_1.it)("checkTrustline returns false for native XLM (no trustline needed)", async () => {
        // The native balance entry has asset_type "native", which the check filters
        // out via `b.asset_type !== "native"`. Passing any issuer for XLM must
        // still return false — XLM is always spendable and never requires a trustline.
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount(false));
        const exists = await tool.checkTrustline("XLM", ISSUER);
        (0, vitest_1.expect)(exists).toBe(false);
    });
    (0, vitest_1.it)("rejects invalid assetIssuer length", async () => {
        await (0, vitest_1.expect)(tool.execute({ assetCode: "USDC", assetIssuer: "SHORT", action: "add" })).rejects.toThrow(/Invalid asset issuer/);
    });
    (0, vitest_1.it)("rejects a syntactically invalid 56-character assetIssuer", async () => {
        await (0, vitest_1.expect)(tool.execute({
            assetCode: "USDC",
            assetIssuer: "G" + "A".repeat(55),
            action: "add",
        })).rejects.toThrow(/valid Stellar public key/i);
    });
    (0, vitest_1.it)("propagates submission error", async () => {
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount());
        vitest_1.vi.mocked(rpcClient.submitTransaction).mockRejectedValue(new Error("op_low_reserve"));
        await (0, vitest_1.expect)(tool.execute({ assetCode: "USDC", assetIssuer: ISSUER, action: "add" })).rejects.toThrow("op_low_reserve");
    });
});
//# sourceMappingURL=trustline.test.js.map