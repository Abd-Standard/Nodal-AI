"use strict";
/**
 * tests/dex_offer.test.ts
 * Tests for DexOfferTool: create, update, delete, and input validation.
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
const DexOfferTool_1 = require("../backend/tools/DexOfferTool");
const rpcClient = __importStar(require("../backend/rpc_client"));
// ─── Mocks ────────────────────────────────────────────────────────────────────
vitest_1.vi.mock("../backend/rpc_client", () => ({
    loadAccount: vitest_1.vi.fn(),
    submitTransaction: vitest_1.vi.fn(),
    horizonServer: {},
    sorobanServer: {},
    simulateSorobanTx: vitest_1.vi.fn(),
    prepareSorobanTx: vitest_1.vi.fn(),
    resolveNetworkPassphrase: (network) => 
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("@stellar/stellar-sdk").Networks[network === "mainnet" ? "PUBLIC" : network === "futurenet" ? "FUTURENET" : "TESTNET"],
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
            X402_ASSET_CODE: "USDC",
            X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            AGENT_SPENDING_LIMIT: "1000",
            AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
            agentKeypair: () => Keypair.fromSecret(secret),
        },
    };
});
// ─── Fixtures ─────────────────────────────────────────────────────────────────
const TEST_SECRET = "process.env.AGENT_SECRET_KEY";
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
        balances: [],
        signers: [],
        data_attr: {},
        subentry_count: 0,
        home_domain: "",
        inflation_dest: null,
    };
}
/**
 * Create a mock transaction result XDR with a manageSellOffer result containing the given offer ID.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeMockTxResultXdr(offerId) {
    const kp = stellar_sdk_1.Keypair.fromSecret(TEST_SECRET);
    const issuerKp = stellar_sdk_1.Keypair.random();
    const issuer = issuerKp.publicKey();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const OfferEntryExtCtor = stellar_sdk_1.xdr.OfferEntryExt;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const TransactionResultExtCtor = stellar_sdk_1.xdr.TransactionResultExt;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Int64Ctor = stellar_sdk_1.xdr.Int64;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const OfferEntryCtor = stellar_sdk_1.xdr.OfferEntry;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const TransactionResultCtor = stellar_sdk_1.xdr.TransactionResult;
    const offer = new OfferEntryCtor({
        sellerId: kp.xdrAccountId(),
        offerId: BigInt(offerId),
        selling: stellar_sdk_1.Asset.native().toXDRObject(),
        buying: new stellar_sdk_1.Asset("USDC", issuer).toXDRObject(),
        amount: BigInt(1000000000),
        price: new stellar_sdk_1.xdr.Price({ n: 1, d: 1 }),
        flags: 0,
        ext: new OfferEntryExtCtor(0),
    });
    const offerUnion = stellar_sdk_1.xdr.ManageOfferSuccessResultOffer.manageOfferCreated(offer);
    const successResult = new stellar_sdk_1.xdr.ManageOfferSuccessResult({
        offersClaimed: [],
        offer: offerUnion,
    });
    const msor = stellar_sdk_1.xdr.ManageSellOfferResult.manageSellOfferSuccess(successResult);
    const tr = stellar_sdk_1.xdr.OperationResultTr.manageSellOffer(msor);
    const opResult = stellar_sdk_1.xdr.OperationResult.opInner(tr);
    const txResultResult = stellar_sdk_1.xdr.TransactionResultResult.txSuccess([opResult]);
    const txResult = new TransactionResultCtor({
        feeCharged: new Int64Ctor(BigInt(100)),
        result: txResultResult,
        ext: new TransactionResultExtCtor(0),
    });
    return txResult.toXDR("base64");
}
const BASE_OFFER = {
    selling: { code: "XLM" },
    buying: { code: "USDC", issuer: USDC_ISSUER },
    amount: "100",
    price: "0.25",
};
// ─── Tests ────────────────────────────────────────────────────────────────────
(0, vitest_1.describe)("DexOfferTool", () => {
    let tool;
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
        tool = new DexOfferTool_1.DexOfferTool(TEST_SECRET);
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount(tool.publicKey));
        vitest_1.vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
            hash: "offer_tx_hash",
            ledger: 10,
        });
    });
    // ── Create offer ────────────────────────────────────────────────────────────
    (0, vitest_1.it)("creates an offer and returns txHash + ledger", async () => {
        const result = await tool.execute({ action: "create", ...BASE_OFFER });
        (0, vitest_1.expect)(result.txHash).toBe("offer_tx_hash");
        (0, vitest_1.expect)(result.ledger).toBe(10);
        (0, vitest_1.expect)(rpcClient.submitTransaction).toHaveBeenCalledOnce();
    });
    (0, vitest_1.it)("returns offerId from transaction result metadata for create action", async () => {
        const networkAssignedOfferId = "12345678";
        vitest_1.vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
            hash: "offer_tx_hash",
            ledger: 10,
            result_xdr: makeMockTxResultXdr(networkAssignedOfferId),
        });
        const result = await tool.execute({ action: "create", ...BASE_OFFER });
        (0, vitest_1.expect)(result.txHash).toBe("offer_tx_hash");
        (0, vitest_1.expect)(result.ledger).toBe(10);
        (0, vitest_1.expect)(result.offerId).toBe(networkAssignedOfferId);
    });
    // ── Delete offer ────────────────────────────────────────────────────────────
    (0, vitest_1.it)("deletes an offer by submitting amount=0 with the offerId", async () => {
        const result = await tool.execute({
            action: "delete",
            ...BASE_OFFER,
            offerId: "42",
        });
        (0, vitest_1.expect)(result.txHash).toBe("offer_tx_hash");
        (0, vitest_1.expect)(result.offerId).toBe("42");
        // Verify submitTransaction was called (amount=0 is set internally for delete)
        (0, vitest_1.expect)(rpcClient.submitTransaction).toHaveBeenCalledOnce();
    });
    // ── Update offer amount ─────────────────────────────────────────────────────
    (0, vitest_1.it)("updates an existing offer amount", async () => {
        vitest_1.vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
            hash: "update_tx_hash",
            ledger: 20,
        });
        const result = await tool.execute({
            action: "update",
            ...BASE_OFFER,
            amount: "200",
            offerId: "99",
        });
        (0, vitest_1.expect)(result.txHash).toBe("update_tx_hash");
        (0, vitest_1.expect)(result.offerId).toBe("99");
    });
    // ── Input validation ────────────────────────────────────────────────────────
    (0, vitest_1.it)("rejects update action without offerId", async () => {
        await (0, vitest_1.expect)(tool.execute({ action: "update", ...BASE_OFFER })).rejects.toThrow(/offerId is required/);
    });
    (0, vitest_1.it)("rejects delete action without offerId", async () => {
        await (0, vitest_1.expect)(tool.execute({ action: "delete", ...BASE_OFFER })).rejects.toThrow(/offerId is required/);
    });
    (0, vitest_1.it)("rejects invalid amount (zero)", async () => {
        await (0, vitest_1.expect)(tool.execute({ action: "create", ...BASE_OFFER, amount: "0" })).rejects.toThrow(/Amount must be/);
    });
    (0, vitest_1.it)("rejects invalid price format", async () => {
        await (0, vitest_1.expect)(tool.execute({ action: "create", ...BASE_OFFER, price: "abc" })).rejects.toThrow(/Price must be/);
    });
    (0, vitest_1.it)("rejects unknown action", async () => {
        await (0, vitest_1.expect)(tool.execute({ action: "buy", ...BASE_OFFER })).rejects.toThrow();
    });
    (0, vitest_1.it)("propagates network errors from submitTransaction", async () => {
        vitest_1.vi.mocked(rpcClient.submitTransaction).mockRejectedValueOnce(new Error("Network Error"));
        await (0, vitest_1.expect)(tool.execute({ action: "create", ...BASE_OFFER })).rejects.toThrow("Network Error");
    });
});
// ─── Schema unit tests ────────────────────────────────────────────────────────
(0, vitest_1.describe)("DexOfferInputSchema", () => {
    (0, vitest_1.it)("parses a valid create payload", () => {
        const result = DexOfferTool_1.DexOfferInputSchema.parse({
            action: "create",
            selling: { code: "XLM" },
            buying: { code: "USDC", issuer: USDC_ISSUER },
            amount: "50",
            price: "0.5",
        });
        (0, vitest_1.expect)(result.action).toBe("create");
    });
    (0, vitest_1.it)("parses a valid delete payload with offerId as number", () => {
        const result = DexOfferTool_1.DexOfferInputSchema.parse({
            action: "delete",
            selling: { code: "XLM" },
            buying: { code: "USDC", issuer: USDC_ISSUER },
            amount: "1",
            price: "0.1",
            offerId: 7,
        });
        (0, vitest_1.expect)(result.offerId).toBe(7);
    });
});
//# sourceMappingURL=dex_offer.test.js.map