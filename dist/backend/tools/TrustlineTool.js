"use strict";
/**
 * backend/tools/TrustlineTool.ts
 * Manage asset trustlines for the agent account.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.TrustlineTool = exports.TrustlineInputSchema = void 0;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const zod_1 = require("zod");
const config_1 = require("../config");
const rpc_client_1 = require("../rpc_client");
const StellarPaymentTool_1 = require("./StellarPaymentTool");
exports.TrustlineInputSchema = zod_1.z.object({
    assetCode: zod_1.z.string().min(1).max(12),
    assetIssuer: zod_1.z
        .string()
        .length(56, "Invalid asset issuer address")
        .refine((val) => stellar_sdk_1.StrKey.isValidEd25519PublicKey(val), "Asset issuer must be a valid Stellar public key"),
    action: zod_1.z.enum(["add", "remove"]),
    limit: zod_1.z.string().optional(),
});
class TrustlineTool {
    keypair;
    networkPassphrase;
    constructor(secretKey = config_1.config.agentKeypair().secret()) {
        this.keypair = stellar_sdk_1.Keypair.fromSecret(secretKey);
        this.networkPassphrase = (0, rpc_client_1.resolveNetworkPassphrase)(config_1.config.STELLAR_NETWORK);
    }
    async checkTrustline(assetCode, assetIssuer) {
        const account = await (0, rpc_client_1.loadAccount)(this.keypair.publicKey());
        return account.balances.some((b) => b.asset_type !== "native" && b.asset_code === assetCode && b.asset_issuer === assetIssuer);
    }
    async execute(rawInput) {
        const input = exports.TrustlineInputSchema.parse(rawInput);
        const asset = new stellar_sdk_1.Asset(input.assetCode, input.assetIssuer);
        const account = await (0, rpc_client_1.loadAccount)(this.keypair.publicKey());
        const tx = new stellar_sdk_1.TransactionBuilder(account, {
            fee: stellar_sdk_1.BASE_FEE,
            networkPassphrase: this.networkPassphrase,
        })
            .addOperation(stellar_sdk_1.Operation.changeTrust({
            asset,
            ...(input.action === "remove"
                ? { limit: "0" }
                : input.limit
                    ? { limit: input.limit }
                    : {}),
        }))
            .setTimeout(30)
            .build();
        tx.sign(this.keypair);
        const result = StellarPaymentTool_1.SubmitResultSchema.parse(await (0, rpc_client_1.submitTransaction)(tx));
        return { txHash: result.hash, ledger: result.ledger };
    }
}
exports.TrustlineTool = TrustlineTool;
//# sourceMappingURL=TrustlineTool.js.map