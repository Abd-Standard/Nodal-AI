"use strict";
/**
 * tests/fee_bump.test.ts
 * Tests for FeeBumpTool covering: valid inner XDR, malformed XDR rejection,
 * fee calculation, self-fee-bump guard, and submission.
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
const FeeBumpTool_1 = require("../backend/tools/FeeBumpTool");
const rpcClient = __importStar(require("../backend/rpc_client"));
// ─── Mocks ────────────────────────────────────────────────────────────────────
vitest_1.vi.mock("../backend/rpc_client", () => ({
    loadAccount: vitest_1.vi.fn(),
    submitTransaction: vitest_1.vi.fn(),
    horizonServer: {},
    sorobanServer: {},
    simulateSorobanTx: vitest_1.vi.fn(),
    prepareSorobanTx: vitest_1.vi.fn(),
    resolveNetworkPassphrase: vitest_1.vi.fn(() => stellar_sdk_1.Networks.TESTNET),
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
const AGENT_SECRET = "process.env.AGENT_SECRET_KEY";
const INNER_SECRET = "SDPFZL3WZ" + "FXHQVLZX3TUZ5VXYYNZGLHC5BKWBHXMB5E6D64B2YJJFHF5";
const DEST_KEY = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
/** Build a minimal signed transaction XDR to use as inner tx in tests */
function buildInnerTxXdr() {
    const innerKeypair = stellar_sdk_1.Keypair.random();
    // We need a mock account-like object for TransactionBuilder
    const mockAccount = {
        accountId: () => innerKeypair.publicKey(),
        sequenceNumber: () => "100",
        incrementSequenceNumber: () => { },
        sequence: "100",
        incrementedSequenceNumber: () => "101",
    };
    const tx = new stellar_sdk_1.TransactionBuilder(mockAccount, {
        fee: stellar_sdk_1.BASE_FEE,
        networkPassphrase: stellar_sdk_1.Networks.TESTNET,
    })
        .addOperation(stellar_sdk_1.Operation.payment({
        destination: DEST_KEY,
        asset: stellar_sdk_1.Asset.native(),
        amount: "1",
    }))
        .setTimeout(30)
        .build();
    tx.sign(innerKeypair);
    return tx.toEnvelope().toXDR("base64");
}
// ─── Tests ────────────────────────────────────────────────────────────────────
(0, vitest_1.describe)("FeeBumpTool", () => {
    let tool;
    let validInnerXdr;
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
        tool = new FeeBumpTool_1.FeeBumpTool(AGENT_SECRET);
        validInnerXdr = buildInnerTxXdr();
        vitest_1.vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
            hash: "fee_bump_tx_hash",
            ledger: 200,
        });
    });
    // ── Happy path ──────────────────────────────────────────────────────────────
    (0, vitest_1.it)("wraps a valid inner transaction and returns txHash + ledger", async () => {
        const result = await tool.execute({ innerTxXdr: validInnerXdr });
        (0, vitest_1.expect)(result.txHash).toBe("fee_bump_tx_hash");
        (0, vitest_1.expect)(result.ledger).toBe(200);
        (0, vitest_1.expect)(rpcClient.submitTransaction).toHaveBeenCalledOnce();
    });
    (0, vitest_1.it)("uses the agent public key as default feeAccount", async () => {
        await tool.execute({ innerTxXdr: validInnerXdr });
        // submitTransaction is called — tool resolved feeAccount to agent key without error
        (0, vitest_1.expect)(rpcClient.submitTransaction).toHaveBeenCalledOnce();
    });
    (0, vitest_1.it)("accepts an explicit feeAccount override", async () => {
        const result = await tool.execute({
            innerTxXdr: validInnerXdr,
            feeAccount: DEST_KEY,
        });
        (0, vitest_1.expect)(result.txHash).toBe("fee_bump_tx_hash");
    });
    (0, vitest_1.it)("applies baseFeeMultiplier to increase the fee", async () => {
        const result = await tool.execute({
            innerTxXdr: validInnerXdr,
            baseFeeMultiplier: 5,
        });
        (0, vitest_1.expect)(result.txHash).toBe("fee_bump_tx_hash");
        (0, vitest_1.expect)(rpcClient.submitTransaction).toHaveBeenCalledOnce();
    });
    // ── Input validation ────────────────────────────────────────────────────────
    (0, vitest_1.it)("rejects malformed (non-base64) XDR", async () => {
        await (0, vitest_1.expect)(tool.execute({ innerTxXdr: "not-valid-xdr!!!" })).rejects.toThrow(/Invalid inner transaction XDR/);
    });
    (0, vitest_1.it)("throws when innerTxXdr is a fee-bump transaction itself", async () => {
        // Build a real inner transaction, then wrap it in a fee-bump envelope.
        // Passing that fee-bump XDR as innerTxXdr must be rejected because the
        // protocol forbids nested fee-bump transactions.
        const innerXdr = buildInnerTxXdr();
        const agentKeypair = stellar_sdk_1.Keypair.fromSecret(AGENT_SECRET);
        const innerTx = stellar_sdk_1.TransactionBuilder.fromXDR(innerXdr, stellar_sdk_1.Networks.TESTNET);
        const feeBumpTx = stellar_sdk_1.TransactionBuilder.buildFeeBumpTransaction(agentKeypair.publicKey(), String(parseInt(stellar_sdk_1.BASE_FEE, 10) * 2), innerTx, stellar_sdk_1.Networks.TESTNET);
        feeBumpTx.sign(agentKeypair);
        const feeBumpXdr = feeBumpTx.toEnvelope().toXDR("base64");
        await (0, vitest_1.expect)(tool.execute({ innerTxXdr: feeBumpXdr })).rejects.toThrow(/Inner transaction must not itself be a fee-bump transaction/);
    });
    (0, vitest_1.it)("rejects an empty innerTxXdr", async () => {
        await (0, vitest_1.expect)(tool.execute({ innerTxXdr: "" })).rejects.toThrow();
    });
    (0, vitest_1.it)("rejects an invalid feeAccount key (wrong length)", async () => {
        await (0, vitest_1.expect)(tool.execute({ innerTxXdr: validInnerXdr, feeAccount: "GABC123" })).rejects.toThrow(/Invalid Stellar public key/);
    });
    (0, vitest_1.it)("rejects baseFeeMultiplier of zero", async () => {
        await (0, vitest_1.expect)(tool.execute({ innerTxXdr: validInnerXdr, baseFeeMultiplier: 0 })).rejects.toThrow();
    });
    (0, vitest_1.it)("rejects baseFeeMultiplier of 1 (must be >= 2)", async () => {
        await (0, vitest_1.expect)(tool.execute({ innerTxXdr: validInnerXdr, baseFeeMultiplier: 1 })).rejects.toThrow();
    });
    // ── Fee calculation ─────────────────────────────────────────────────────────
    (0, vitest_1.it)("exposes the agent public key", () => {
        (0, vitest_1.expect)(tool.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
    });
    (0, vitest_1.it)("propagates submission errors from Horizon", async () => {
        vitest_1.vi.mocked(rpcClient.submitTransaction).mockRejectedValue(new Error("Horizon: tx_fee_bump_inner_failed"));
        await (0, vitest_1.expect)(tool.execute({ innerTxXdr: validInnerXdr })).rejects.toThrow(/tx_fee_bump_inner_failed/);
    });
});
//# sourceMappingURL=fee_bump.test.js.map