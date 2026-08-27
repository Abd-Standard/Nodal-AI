"use strict";
/**
 * backend/tools/PathPaymentTool.ts
 * Cross-asset path payment via Stellar's pathPaymentStrictSend operation.
 * Enables sending one asset and having the recipient receive a different asset
 * through the Stellar DEX (e.g., send XLM, recipient receives USDC).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.PathPaymentTool = exports.PathPaymentInputSchema = void 0;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const zod_1 = require("zod");
const config_1 = require("../config");
const logger_1 = require("../logger");
const rpc_client_1 = require("../rpc_client");
const logger_2 = require("../utils/logger");
const StellarPaymentTool_1 = require("./StellarPaymentTool");
const log = (0, logger_2.createLogger)("path-payment");
// ─── Input schema ─────────────────────────────────────────────────────────────
const AssetSchema = zod_1.z.object({
    code: zod_1.z.string(),
    issuer: zod_1.z.string().optional(),
});
exports.PathPaymentInputSchema = zod_1.z.object({
    destination: zod_1.z.string().length(56, "Invalid Stellar public key"),
    sendAsset: AssetSchema,
    sendAmount: zod_1.z
        .string()
        .regex(/^(?!0(\.0+)?$)\d+(\.\d{1,7})?$/, "sendAmount must be a valid Stellar decimal")
        .refine((v) => parseFloat(v) > 0, "sendAmount must be greater than zero"),
    destAsset: AssetSchema,
    destMinAmount: zod_1.z
        .string()
        .regex(/^(?!0(\.0+)?$)\d+(\.\d{1,7})?$/, "destMinAmount must be a valid Stellar decimal")
        .refine((v) => parseFloat(v) > 0, "destMinAmount must be greater than zero"),
    path: zod_1.z.array(AssetSchema).optional().default([]),
    memoType: zod_1.z.enum(["text", "id", "hash", "return"]).optional().default("text"),
    memo: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).optional(),
});
// ─── Helper ───────────────────────────────────────────────────────────────────
function toAsset(a) {
    if (a.code === "XLM")
        return stellar_sdk_1.Asset.native();
    if (!a.issuer) {
        throw new Error(`Asset issuer is required for non-native asset ${a.code}`);
    }
    return new stellar_sdk_1.Asset(a.code, a.issuer);
}
/**
 * Build a Stellar Memo object based on memoType and value.
 *
 * @param memoType - Type of memo: "text", "id", "hash", or "return"
 * @param memoValue - Memo value (string for text/return/hash, number for id)
 * @returns Memo instance or null if memoValue is undefined
 */
function buildMemo(memoType, memoValue) {
    if (memoValue === undefined) {
        return null;
    }
    switch (memoType) {
        case "id":
            if (typeof memoValue !== "number") {
                throw new Error("Memo ID must be a number");
            }
            // Convert to unsigned 64-bit integer
            const id = BigInt(memoValue);
            if (id < 0n || id > 18446744073709551615n) {
                throw new Error("Memo ID must be a 64-bit unsigned integer (0 to 2^64-1)");
            }
            return stellar_sdk_1.Memo.id(id.toString());
        case "hash":
            if (typeof memoValue !== "string") {
                throw new Error("Memo hash must be a string");
            }
            // Remove 0x prefix if present and validate length
            const hashHex = memoValue.replace(/^0x/, "");
            if (hashHex.length !== 64) {
                throw new Error("Memo hash must be a 32-byte hex string (64 hex characters)");
            }
            if (!/^[0-9a-fA-F]{64}$/.test(hashHex)) {
                throw new Error("Memo hash must contain only valid hex characters");
            }
            return stellar_sdk_1.Memo.hash(hashHex);
        case "return":
            if (typeof memoValue !== "string") {
                throw new Error("Memo return must be a string");
            }
            // Remove 0x prefix if present and validate length
            const returnHex = memoValue.replace(/^0x/, "");
            if (returnHex.length !== 64) {
                throw new Error("Memo return must be a 32-byte hex string (64 hex characters)");
            }
            if (!/^[0-9a-fA-F]{64}$/.test(returnHex)) {
                throw new Error("Memo return must contain only valid hex characters");
            }
            return stellar_sdk_1.Memo.return(returnHex);
        case "text":
        default:
            if (typeof memoValue !== "string") {
                throw new Error("Memo text must be a string");
            }
            if (Buffer.byteLength(memoValue, "utf8") > 28) {
                throw new Error("Memo text must be at most 28 bytes");
            }
            return stellar_sdk_1.Memo.text(memoValue);
    }
}
// ─── Tool implementation ──────────────────────────────────────────────────────
class PathPaymentTool {
    keypair;
    networkPassphrase;
    constructor(secretKey = config_1.config.agentKeypair().secret()) {
        this.keypair = stellar_sdk_1.Keypair.fromSecret(secretKey);
        this.networkPassphrase = (0, rpc_client_1.resolveNetworkPassphrase)(config_1.config.STELLAR_NETWORK);
    }
    get publicKey() {
        return this.keypair.publicKey();
    }
    async execute(rawInput) {
        const input = exports.PathPaymentInputSchema.parse(rawInput);
        if (input.destination === this.keypair.publicKey()) {
            throw new Error("Payment destination cannot be the agent's own address");
        }
        const sendAsset = toAsset(input.sendAsset);
        const destAsset = toAsset(input.destAsset);
        const pathAssets = input.path.map(toAsset);
        let sourceAccount = await (0, rpc_client_1.loadAccount)(this.keypair.publicKey());
        const buildTx = () => {
            const builder = new stellar_sdk_1.TransactionBuilder(sourceAccount, {
                fee: stellar_sdk_1.BASE_FEE,
                networkPassphrase: this.networkPassphrase,
            }).addOperation(stellar_sdk_1.Operation.pathPaymentStrictSend({
                sendAsset,
                sendAmount: input.sendAmount,
                destination: input.destination,
                destAsset,
                destMin: input.destMinAmount,
                path: pathAssets,
            }));
            if (input.memo !== undefined) {
                const memo = buildMemo(input.memoType, input.memo);
                if (memo) {
                    builder.addMemo(memo);
                }
            }
            return builder.setTimeout(30).build();
        };
        logger_1.logger.info("Executing path payment", {
            source: this.keypair.publicKey(),
            destination: input.destination,
            sendAmount: input.sendAmount,
            sendAsset: input.sendAsset.code,
            destAsset: input.destAsset.code,
            destMinAmount: input.destMinAmount,
        });
        let tx = buildTx();
        tx.sign(this.keypair);
        try {
            const result = StellarPaymentTool_1.SubmitResultSchema.parse(await (0, rpc_client_1.submitTransaction)(tx));
            return { txHash: result.hash, ledger: result.ledger };
        }
        catch (err) {
            if (err instanceof Error && err.message.includes("tx_bad_seq")) {
                logger_1.logger.warn("tx_bad_seq detected, reloading account and retrying once", {
                    source: this.keypair.publicKey(),
                });
                sourceAccount = await (0, rpc_client_1.loadAccount)(this.keypair.publicKey());
                tx = buildTx();
                tx.sign(this.keypair);
                const result = StellarPaymentTool_1.SubmitResultSchema.parse(await (0, rpc_client_1.submitTransaction)(tx));
                return { txHash: result.hash, ledger: result.ledger };
            }
            throw err;
        }
    }
}
exports.PathPaymentTool = PathPaymentTool;
//# sourceMappingURL=PathPaymentTool.js.map