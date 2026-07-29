"use strict";
/**
 * tests/multisig_payment.test.ts
 * Tests for MultiSigPaymentTool (#108)
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
const MultiSigPaymentTool_1 = require("../backend/tools/MultiSigPaymentTool");
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
const DEST = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const SIGNER2 = "GCEZWKCA5VLDNRLN3RPRJMRZOX3Z6G5CHCGZUK9AI4WDCBAHD9HTPFE7";
const ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
function makeMockAccount() {
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
        balances: [{ asset_type: "native", balance: "10000.0000000" }],
        signers: [],
        data_attr: {},
        subentry_count: 0,
        home_domain: "",
        inflation_dest: null,
    };
}
(0, vitest_1.describe)("MultiSigPaymentTool", () => {
    let tool;
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
        tool = new MultiSigPaymentTool_1.MultiSigPaymentTool(TEST_SECRET);
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount());
    });
    (0, vitest_1.it)("returns unsigned XDR when no signatures provided", async () => {
        const result = await tool.execute({
            destination: DEST,
            amount: "100",
            assetCode: "XLM",
            additionalSigners: [SIGNER2],
            minSignatures: 2,
        });
        (0, vitest_1.expect)(result.unsignedXDR).toBeDefined();
        (0, vitest_1.expect)(typeof result.unsignedXDR).toBe("string");
        (0, vitest_1.expect)(result.txHash).toBeUndefined();
    });
    (0, vitest_1.it)("unsigned XDR is valid base64-encoded XDR (non-empty)", async () => {
        const result = await tool.execute({
            destination: DEST,
            amount: "50",
            assetCode: "XLM",
            additionalSigners: [SIGNER2],
            minSignatures: 2,
        });
        // Valid XDR can be decoded from base64
        (0, vitest_1.expect)(() => Buffer.from(result.unsignedXDR, "base64")).not.toThrow();
        (0, vitest_1.expect)(result.unsignedXDR.length).toBeGreaterThan(50);
    });
    (0, vitest_1.it)("submits and returns txHash when sufficient signatures provided", async () => {
        vitest_1.vi.mocked(rpcClient.submitTransaction).mockResolvedValue({ hash: "multisig_hash", ledger: 10 });
        const result = await tool.execute({
            destination: DEST,
            amount: "100",
            assetCode: "XLM",
            additionalSigners: [SIGNER2],
            minSignatures: 1,
            signatures: ["sig1"],
        });
        (0, vitest_1.expect)(result.txHash).toBe("multisig_hash");
        (0, vitest_1.expect)(result.ledger).toBe(10);
    });
    (0, vitest_1.it)("throws when minSignatures exceeds total available signers", async () => {
        await (0, vitest_1.expect)(tool.execute({
            destination: DEST,
            amount: "100",
            assetCode: "XLM",
            additionalSigners: [SIGNER2],
            minSignatures: 5, // only 2 signers (agent + SIGNER2)
        })).rejects.toThrow(/minSignatures.*exceeds total available signers/);
    });
    (0, vitest_1.it)("throws when non-XLM asset has no issuer", async () => {
        await (0, vitest_1.expect)(tool.execute({
            destination: DEST,
            amount: "100",
            assetCode: "USDC",
            additionalSigners: [SIGNER2],
            minSignatures: 1,
        })).rejects.toThrow(/Asset issuer is required/);
    });
    (0, vitest_1.it)("accepts custom asset with issuer and returns XDR", async () => {
        const result = await tool.execute({
            destination: DEST,
            amount: "100",
            assetCode: "USDC",
            assetIssuer: ISSUER,
            additionalSigners: [SIGNER2],
            minSignatures: 2,
        });
        (0, vitest_1.expect)(result.unsignedXDR).toBeDefined();
    });
});
//# sourceMappingURL=multisig_payment.test.js.map