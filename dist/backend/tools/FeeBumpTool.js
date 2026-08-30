"use strict";
/**
 * backend/tools/FeeBumpTool.ts
 * Wraps any failed transaction in a fee-bump envelope for sponsored retry.
 * Allows the agent to pay fees on behalf of a transaction signed by a different account.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FeeBumpTool = exports.FeeBumpInputSchema = void 0;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const zod_1 = require("zod");
const config_1 = require("../config");
const logger_1 = require("../logger");
const rpc_client_1 = require("../rpc_client");
const logger_2 = require("../utils/logger");
const StellarPaymentTool_1 = require("./StellarPaymentTool");
const log = (0, logger_2.createLogger)("fee-bump");
// ─── Input schema ─────────────────────────────────────────────────────────────
exports.FeeBumpInputSchema = zod_1.z.object({
    innerTxXdr: zod_1.z.string().min(1, "innerTxXdr must be a non-empty base64 XDR string"),
    feeAccount: zod_1.z.string().length(56, "Invalid Stellar public key").optional(),
    baseFeeMultiplier: zod_1.z.number().int().min(2).default(2),
});
// ─── Tool implementation ──────────────────────────────────────────────────────
class FeeBumpTool {
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
        const input = exports.FeeBumpInputSchema.parse(rawInput);
        const feeAccount = input.feeAccount ?? this.keypair.publicKey();
        // Deserialize the inner transaction from XDR
        let innerTx;
        try {
            innerTx = stellar_sdk_1.TransactionBuilder.fromXDR(input.innerTxXdr, this.networkPassphrase);
        }
        catch {
            throw new Error(`Invalid inner transaction XDR: unable to deserialize`);
        }
        if (innerTx instanceof stellar_sdk_1.FeeBumpTransaction) {
            throw new Error("Inner transaction must not itself be a fee-bump transaction");
        }
        // ── Network passphrase guard ──────────────────────────────────────────────
        // XDR does not embed the network passphrase, so TransactionBuilder.fromXDR()
        // will successfully deserialize a transaction signed for any network.
        // We detect cross-network XDRs by verifying the source account's signature
        // against the transaction hash computed with the current network passphrase.
        // If the signature is invalid for our hash, the inner tx was signed for a
        // different network and must be rejected before we build or submit the
        // fee-bump envelope.
        if (innerTx.signatures.length > 0) {
            const sourceKeypair = stellar_sdk_1.Keypair.fromPublicKey(innerTx.source);
            const sourceHint = sourceKeypair.signatureHint();
            const sourceSig = innerTx.signatures.find((d) => d.hint().equals(sourceHint));
            if (sourceSig) {
                const sigValid = sourceKeypair.verify(innerTx.hash(), sourceSig.signature());
                if (!sigValid) {
                    throw new Error("Inner transaction was signed for a different network passphrase. " +
                        "Ensure the inner XDR originates from the same network as the agent " +
                        `(${this.networkPassphrase}).`);
                }
            }
        }
        const baseFee = parseInt(innerTx.fee, 10);
        const operationCount = innerTx.operations.length || 1;
        const feePerOp = Math.ceil(baseFee / operationCount);
        // baseFeeMultiplier must be >= 2 to ensure the fee-bump fee is strictly greater than
        // the inner transaction's fee, preventing fee_insufficient network rejections.
        const newFeePerOp = Math.max(feePerOp * input.baseFeeMultiplier, parseInt(stellar_sdk_1.BASE_FEE, 10));
        // Fee-bump fee must be at least (inner ops + 1) * newFeePerOp per Stellar protocol
        const feeBumpFee = String((operationCount + 1) * newFeePerOp);
        logger_1.logger.info("Building fee-bump transaction", {
            feeAccount,
            innerTxHash: innerTx.hash().toString("hex"),
            baseFeeMultiplier: input.baseFeeMultiplier,
            feeBumpFee,
        });
        const feeBumpTx = stellar_sdk_1.TransactionBuilder.buildFeeBumpTransaction(feeAccount, feeBumpFee, innerTx, this.networkPassphrase);
        feeBumpTx.sign(this.keypair);
        const result = StellarPaymentTool_1.SubmitResultSchema.parse(await (0, rpc_client_1.submitTransaction)(feeBumpTx));
        return { txHash: result.hash, ledger: result.ledger };
    }
}
exports.FeeBumpTool = FeeBumpTool;
//# sourceMappingURL=FeeBumpTool.js.map