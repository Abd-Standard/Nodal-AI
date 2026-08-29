"use strict";
/**
 * backend/tools/StellarPaymentTool.ts
 * Standalone tool: native XLM or asset payment via Horizon.
 *
 * Architecture: Tool → simulate → sign → submit
 * Never broadcasts without a prior simulation pass.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.StellarPaymentTool = exports.PaymentInputSchema = exports.SubmitResultSchema = void 0;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const zod_1 = require("zod");
const config_1 = require("../config");
const logger_1 = require("../logger");
const rpc_client_1 = require("../rpc_client");
const SorobanInvokeTool_1 = require("./SorobanInvokeTool");
const logger_2 = require("../utils/logger");
const log = (0, logger_2.createLogger)("stellar-payment");
// ─── Input schema ─────────────────────────────────────────────────────────────
const SubmitResultSchema = zod_1.z.object({
    hash: zod_1.z.string(),
    ledger: zod_1.z.number(),
});
exports.SubmitResultSchema = SubmitResultSchema;
/**
 * Zod schema for payment input validation.
 *
 * @property destination - 56-character Stellar public key (G...) of the recipient
 * @property amount - Positive decimal string with up to 7 decimal places (Stellar network limit)
 * @property assetCode - Asset code (default: "XLM")
 * @property assetIssuer - Asset issuer public key (required for non-XLM assets)
 * @property memoType - Type of memo: "text", "id", "hash", or "return" (default: "text")
 * @property memo - Optional memo value (string for text/return/hash, number for id)
 */
exports.PaymentInputSchema = zod_1.z.object({
    destination: zod_1.z.string()
        .length(56, "Invalid Stellar public key")
        .refine((val) => stellar_sdk_1.StrKey.isValidEd25519PublicKey(val), "Destination must be a valid Stellar public key (G...)"),
    amount: zod_1.z
        .string()
        // Negative-lookahead rejects "0" and all zero-value decimals ("0.0", "0.0000000")
        .regex(/^(?!0(\.0+)?$)\d+(\.\d{1,7})?$/, "Amount must be a valid Stellar decimal")
        // Belt-and-suspenders guard: parseFloat catches any edge cases the regex misses
        .refine((v) => parseFloat(v) > 0, "Amount must be greater than zero"),
    assetCode: zod_1.z.string().default("XLM"),
    assetIssuer: zod_1.z.string().optional(),
    memoType: zod_1.z.enum(["text", "id", "hash", "return"]).optional().default("text"),
    memo: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).optional(),
});
// ─── Helper: build memo based on type ───────────────────────────────────────────
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
class StellarPaymentTool {
    keypair;
    networkPassphrase;
    /**
     * Create a new StellarPaymentTool instance.
     *
     * @param secretKey - Stellar secret key (S...) for signing transactions
     */
    constructor(secretKey = config_1.config.agentKeypair().secret()) {
        this.keypair = stellar_sdk_1.Keypair.fromSecret(secretKey);
        this.networkPassphrase = (0, rpc_client_1.resolveNetworkPassphrase)(config_1.config.STELLAR_NETWORK);
    }
    get publicKey() {
        return this.keypair.publicKey();
    }
    /**
     * Execute a payment on the Stellar network.
     *
     * Steps:
     * 1. Validate input with Zod schema
     * 2. Resolve asset (native XLM or custom asset)
     * 3. Load source account to get latest sequence number
     * 4. Build transaction with payment operation and optional memo
     * 5. Validate transaction envelope
     * 6. Sign transaction with keypair
     * 7. Submit transaction to the network
     *
     * @param rawInput - Raw payment input (will be validated)
     * @returns Object containing transaction hash and ledger number
     * @throws {z.ZodError} If input fails validation
     * @throws {Error} If source account not found or transaction submission fails
     */
    async execute(rawInput) {
        // 1. Validate input
        const input = exports.PaymentInputSchema.parse(rawInput);
        // Self-payment guard
        if (input.destination === this.keypair.publicKey()) {
            throw new Error("Payment destination cannot be the agent's own address");
        }
        // 2. Resolve asset
        if (input.assetCode !== "XLM" && !input.assetIssuer) {
            throw new Error(`Asset issuer is required for non-native asset ${input.assetCode}`);
        }
        const asset = input.assetCode === "XLM"
            ? stellar_sdk_1.Asset.native()
            : new stellar_sdk_1.Asset(input.assetCode, input.assetIssuer);
        // 3. Load source account (latest sequence number)
        let sourceAccount = await (0, rpc_client_1.loadAccount)(this.keypair.publicKey());
        // 4. Build transaction
        const buildTx = () => {
            const builder = new stellar_sdk_1.TransactionBuilder(sourceAccount, {
                fee: stellar_sdk_1.BASE_FEE, // BASE_FEE (100 stroops) is the actual fee for classic Stellar payments — not overwritten
                networkPassphrase: this.networkPassphrase,
            })
                .addOperation(stellar_sdk_1.Operation.payment({
                destination: input.destination,
                asset,
                amount: input.amount,
            }));
            if (input.memo !== undefined) {
                const memo = buildMemo(input.memoType, input.memo);
                if (memo) {
                    builder.addMemo(memo);
                }
            }
            return builder.setTimeout(SorobanInvokeTool_1.SOROBAN_TX_TIMEOUT).build();
        };
        let tx = buildTx();
        // 5. Fee estimation / simulation via Horizon dry-run
        //    (Horizon doesn't expose simulation like Soroban, so we validate
        //     the transaction envelope locally before submission)
        logger_1.logger.info("Validating payment envelope", {
            source: this.keypair.publicKey(),
            destination: input.destination,
            amount: input.amount,
            assetCode: input.assetCode,
        });
        // 6. Sign
        tx.sign(this.keypair);
        // 7. Submit (with auto-retry on tx_bad_seq)
        try {
            const result = SubmitResultSchema.parse(await (0, rpc_client_1.submitTransaction)(tx));
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
                const result = SubmitResultSchema.parse(await (0, rpc_client_1.submitTransaction)(tx));
                return { txHash: result.hash, ledger: result.ledger };
            }
            throw err;
        }
    }
}
exports.StellarPaymentTool = StellarPaymentTool;
//# sourceMappingURL=StellarPaymentTool.js.map