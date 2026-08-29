"use strict";
/**
 * backend/tools/DexOfferTool.ts
 * Place, update, or delete a manage-sell offer on the Stellar DEX.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DexOfferTool = exports.DexOfferInputSchema = void 0;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const zod_1 = require("zod");
const config_1 = require("../config");
const rpc_client_1 = require("../rpc_client");
const SorobanInvokeTool_1 = require("./SorobanInvokeTool");
const StellarPaymentTool_1 = require("./StellarPaymentTool");
/**
 * Extract offer ID from the transaction result XDR.
 * For manageSellOffer create operations, the result contains the offerID.
 */
function extractOfferIdFromTxResult(resultXdr, action) {
    if (action !== "create")
        return null;
    try {
        const txResult = stellar_sdk_1.xdr.TransactionResult.fromXDR(resultXdr, "base64");
        const result = txResult.result();
        if (result.switch() !== stellar_sdk_1.xdr.TransactionResultCode.txSuccess())
            return null;
        const opResults = result.results();
        if (opResults.length === 0)
            return null;
        // opResults[0] is the OperationResult union
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const opResult = opResults[0];
        if (opResult.switch() !== stellar_sdk_1.xdr.OperationResultCode.opInner()) {
            return null;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const tr = opResult.tr();
        if (tr.switch() !== stellar_sdk_1.xdr.OperationType.manageSellOffer()) {
            return null;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const manageSellOfferResult = tr.manageSellOfferResult();
        const successResult = manageSellOfferResult.success();
        if (!successResult)
            return null;
        const offerUnion = successResult.offer();
        if (!offerUnion)
            return null;
        // After deserialization, the union arm is "offer", so use .value()
        const offer = offerUnion.value();
        if (!offer)
            return null;
        return offer.offerId().toString();
    }
    catch {
        return null;
    }
}
// ─── Schemas ──────────────────────────────────────────────────────────────────
const AssetSchema = zod_1.z.object({
    code: zod_1.z.string(),
    issuer: zod_1.z.string().optional(),
});
exports.DexOfferInputSchema = zod_1.z
    .object({
    action: zod_1.z.enum(["create", "update", "delete"]),
    selling: AssetSchema,
    buying: AssetSchema,
    amount: zod_1.z
        .string()
        .regex(/^(?!0(\.0+)?$)\d+(\.\d{1,7})?$/, "Amount must be a valid Stellar decimal")
        .refine((v) => parseFloat(v) > 0, "Amount must be greater than zero"),
    price: zod_1.z.string().regex(/^\d+(\.\d+)?$/, "Price must be a positive decimal"),
    offerId: zod_1.z.union([zod_1.z.string(), zod_1.z.number()]).optional(),
})
    .superRefine((data, ctx) => {
    if ((data.action === "update" || data.action === "delete") && data.offerId == null) {
        ctx.addIssue({
            code: zod_1.z.ZodIssueCode.custom,
            message: "offerId is required for update and delete actions",
            path: ["offerId"],
        });
    }
});
// ─── Helper ───────────────────────────────────────────────────────────────────
function resolveAsset(a) {
    return a.code === "XLM" ? stellar_sdk_1.Asset.native() : new stellar_sdk_1.Asset(a.code, a.issuer);
}
// ─── Tool ─────────────────────────────────────────────────────────────────────
class DexOfferTool {
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
        const input = exports.DexOfferInputSchema.parse(rawInput);
        const selling = resolveAsset(input.selling);
        const buying = resolveAsset(input.buying);
        // For delete: amount must be "0" regardless of the validated input amount
        const offerAmount = input.action === "delete" ? "0" : input.amount;
        const offerId = input.offerId != null ? String(input.offerId) : "0";
        const sourceAccount = await (0, rpc_client_1.loadAccount)(this.keypair.publicKey());
        const tx = new stellar_sdk_1.TransactionBuilder(sourceAccount, {
            fee: stellar_sdk_1.BASE_FEE,
            networkPassphrase: this.networkPassphrase,
        })
            .addOperation(stellar_sdk_1.Operation.manageSellOffer({
            selling,
            buying,
            amount: offerAmount,
            price: input.price,
            offerId,
        }))
            .setTimeout(SorobanInvokeTool_1.SOROBAN_TX_TIMEOUT)
            .build();
        tx.sign(this.keypair);
        const submitResult = await (0, rpc_client_1.submitTransaction)(tx);
        const result = StellarPaymentTool_1.SubmitResultSchema.parse(submitResult);
        // For create actions, extract the network-assigned offerId from the transaction result.
        // For update/delete actions, return the input offerId.
        let finalOfferId = offerId;
        if (input.action === "create" && "result_xdr" in submitResult) {
            const extractedOfferId = extractOfferIdFromTxResult(submitResult.result_xdr, input.action);
            if (extractedOfferId) {
                finalOfferId = extractedOfferId;
            }
        }
        return { txHash: result.hash, ledger: result.ledger, offerId: finalOfferId };
    }
}
exports.DexOfferTool = DexOfferTool;
//# sourceMappingURL=DexOfferTool.js.map