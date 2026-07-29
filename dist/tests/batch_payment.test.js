"use strict";
/**
 * tests/batch_payment.test.ts
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
const BatchPaymentTool_1 = require("../backend/tools/BatchPaymentTool");
const rpcClient = __importStar(require("../backend/rpc_client"));
vitest_1.vi.mock("../backend/rpc_client", () => ({
    loadAccount: vitest_1.vi.fn(),
    submitTransaction: vitest_1.vi.fn(),
    horizonServer: {},
    sorobanServer: {},
    simulateSorobanTx: vitest_1.vi.fn(),
    prepareSorobanTx: vitest_1.vi.fn(),
    resolveNetworkPassphrase: (network) => 
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    require("@stellar/stellar-sdk").Networks[network === "mainnet" ? "PUBLIC" : network === "futurenet" ? "FUTURENET" : "TESTNET"],
}));
vitest_1.vi.mock("../backend/config", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { Keypair } = require("@stellar/stellar-sdk");
    const secret = "process.env.AGENT_SECRET_KEY";
    return {
        config: {
            STELLAR_NETWORK: "testnet",
            HORIZON_URL: "https://horizon-testnet.stellar.org",
            SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
            X402_ASSET_CODE: "USDC",
            X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            AGENT_SPENDING_LIMIT: "1000",
            AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
            agentKeypair: () => Keypair.fromSecret(secret),
        },
    };
});
vitest_1.vi.mock("../backend/persistence", () => ({ saveResult: vitest_1.vi.fn() }));
const DEST1 = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const DEST2 = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const DEST3 = "GDRIFTCEWUMA5IM6NUQPLA27YPHDMUNMPDXCQWCD3BRPVKMPX5KEM5F5";
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
(0, vitest_1.describe)("BatchPaymentTool", () => {
    let tool;
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
        tool = new BatchPaymentTool_1.BatchPaymentTool();
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount("GDRIFTCEWUMA5IM6NUQPLA27YPHDMUNMPDXCQWCD3BRPVKMPX5KEM5F5"));
        vitest_1.vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
            hash: "batch_tx_hash",
            ledger: 55,
        });
    });
    (0, vitest_1.it)("executes a 3-payment batch and returns txHash + ledger", async () => {
        const result = await tool.execute({
            payments: [
                { destination: DEST1, amount: "10", assetCode: "XLM" },
                { destination: DEST2, amount: "20", assetCode: "XLM" },
                { destination: DEST3, amount: "30", assetCode: "XLM" },
            ],
        });
        (0, vitest_1.expect)(result.txHash).toBe("batch_tx_hash");
        (0, vitest_1.expect)(result.ledger).toBe(55);
        (0, vitest_1.expect)(rpcClient.submitTransaction).toHaveBeenCalledOnce();
    });
    (0, vitest_1.it)("rejects a batch with more than 100 payments", async () => {
        const payments = Array.from({ length: 101 }, (_, i) => ({
            destination: DEST1,
            amount: "1",
            assetCode: "XLM",
        }));
        await (0, vitest_1.expect)(tool.execute({ payments })).rejects.toThrow();
    });
    (0, vitest_1.it)("rejects when the aggregate total exceeds AGENT_SPENDING_LIMIT", async () => {
        // AGENT_SPENDING_LIMIT is 1000; 3 × 400 = 1200
        await (0, vitest_1.expect)(tool.execute({
            payments: [
                { destination: DEST1, amount: "400", assetCode: "XLM" },
                { destination: DEST2, amount: "400", assetCode: "XLM" },
                { destination: DEST3, amount: "400", assetCode: "XLM" },
            ],
        })).rejects.toThrow(/AGENT_SPENDING_LIMIT/);
    });
    (0, vitest_1.it)("accepts a batch where the total exactly equals the spending limit", async () => {
        // 100 × 10 = 1000, which equals the limit
        const payments = Array.from({ length: 100 }, () => ({
            destination: DEST1,
            amount: "10",
            assetCode: "XLM",
        }));
        const result = await tool.execute({ payments });
        (0, vitest_1.expect)(result.txHash).toBe("batch_tx_hash");
    });
    (0, vitest_1.it)("rejects an empty payments array", async () => {
        await (0, vitest_1.expect)(tool.execute({ payments: [] })).rejects.toThrow();
    });
    (0, vitest_1.it)("rejects a non-XLM payment missing assetIssuer", async () => {
        await (0, vitest_1.expect)(tool.execute({
            payments: [{ destination: DEST1, amount: "10", assetCode: "USDC" }],
        })).rejects.toThrow(/Asset issuer is required/);
    });
});
//# sourceMappingURL=batch_payment.test.js.map