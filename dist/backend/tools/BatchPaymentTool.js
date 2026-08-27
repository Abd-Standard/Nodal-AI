"use strict";
/**
 * backend/tools/BatchPaymentTool.ts
 *
 * Executes 1–100 payment operations in a single atomic Stellar transaction.
 * Spending limit is enforced on the aggregate amount (sum of all payments).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BatchPaymentTool = exports.BatchPaymentInputSchema = void 0;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const zod_1 = require("zod");
const config_1 = require("../config");
const rpc_client_1 = require("../rpc_client");
const StellarPaymentTool_1 = require("./StellarPaymentTool");
const SorobanInvokeTool_1 = require("./SorobanInvokeTool");
exports.BatchPaymentInputSchema = zod_1.z.object({
    payments: zod_1.z.array(StellarPaymentTool_1.PaymentInputSchema).min(1).max(100),
});
class BatchPaymentTool {
    keypair;
    networkPassphrase;
    constructor(secretKey = config_1.config.agentKeypair().secret()) {
        this.keypair = stellar_sdk_1.Keypair.fromSecret(secretKey);
        this.networkPassphrase = (0, rpc_client_1.resolveNetworkPassphrase)(config_1.config.STELLAR_NETWORK);
    }
    async execute(rawInput) {
        const { payments } = exports.BatchPaymentInputSchema.parse(rawInput);
        // Aggregate spending limit check
        const total = payments.reduce((sum, p) => sum + parseFloat(p.amount), 0);
        const limit = parseFloat(config_1.config.AGENT_SPENDING_LIMIT);
        if (total > limit) {
            throw new Error(`Batch total ${total} ${config_1.config.X402_ASSET_CODE} exceeds AGENT_SPENDING_LIMIT of ${config_1.config.AGENT_SPENDING_LIMIT}`);
        }
        const sourceAccount = await (0, rpc_client_1.loadAccount)(this.keypair.publicKey());
        const builder = new stellar_sdk_1.TransactionBuilder(sourceAccount, {
            fee: stellar_sdk_1.BASE_FEE,
            networkPassphrase: this.networkPassphrase,
        });
        for (const p of payments) {
            if (p.assetCode !== "XLM" && !p.assetIssuer) {
                throw new Error(`Asset issuer is required for non-native asset ${p.assetCode}`);
            }
            const asset = p.assetCode === "XLM" ? stellar_sdk_1.Asset.native() : new stellar_sdk_1.Asset(p.assetCode, p.assetIssuer);
            builder.addOperation(stellar_sdk_1.Operation.payment({ destination: p.destination, asset, amount: p.amount }));
        }
        const tx = builder.setTimeout(SorobanInvokeTool_1.SOROBAN_TX_TIMEOUT).build();
        tx.sign(this.keypair);
        const result = StellarPaymentTool_1.SubmitResultSchema.parse(await (0, rpc_client_1.submitTransaction)(tx));
        return { txHash: result.hash, ledger: result.ledger };
    }
}
exports.BatchPaymentTool = BatchPaymentTool;
//# sourceMappingURL=BatchPaymentTool.js.map