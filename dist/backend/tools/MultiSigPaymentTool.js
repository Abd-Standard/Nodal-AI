"use strict";
/**
 * backend/tools/MultiSigPaymentTool.ts
 * Build M-of-N multi-signature payment transactions for high-value PayFi operations.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultiSigPaymentTool = exports.MultiSigInputSchema = void 0;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const zod_1 = require("zod");
const config_1 = require("../config");
const rpc_client_1 = require("../rpc_client");
const StellarPaymentTool_1 = require("./StellarPaymentTool");
exports.MultiSigInputSchema = zod_1.z.object({
    destination: zod_1.z.string().length(56, "Invalid Stellar public key"),
    amount: zod_1.z
        .string()
        .regex(/^(?!0(\.0+)?$)\d+(\.\d{1,7})?$/, "Amount must be a valid Stellar decimal")
        .refine((v) => parseFloat(v) > 0, "Amount must be greater than zero"),
    assetCode: zod_1.z.string().default("XLM"),
    assetIssuer: zod_1.z.string().optional(),
    memo: zod_1.z
        .string()
        .refine((v) => Buffer.byteLength(v, "utf8") <= 28, "Memo must be at most 28 bytes")
        .optional(),
    additionalSigners: zod_1.z.array(zod_1.z.string().length(56, "Invalid signer public key")),
    minSignatures: zod_1.z.number().int().min(1),
    signatures: zod_1.z.array(zod_1.z.string()).optional(),
});
class MultiSigPaymentTool {
    keypair;
    networkPassphrase;
    constructor(secretKey = config_1.config.agentKeypair().secret()) {
        this.keypair = stellar_sdk_1.Keypair.fromSecret(secretKey);
        this.networkPassphrase = (0, rpc_client_1.resolveNetworkPassphrase)(config_1.config.STELLAR_NETWORK);
    }
    async execute(rawInput) {
        const input = exports.MultiSigInputSchema.parse(rawInput);
        if (input.minSignatures > input.additionalSigners.length + 1) {
            throw new Error(`minSignatures (${input.minSignatures}) exceeds total available signers (${input.additionalSigners.length + 1})`);
        }
        if (input.assetCode !== "XLM" && !input.assetIssuer) {
            throw new Error(`Asset issuer is required for non-native asset ${input.assetCode}`);
        }
        const asset = input.assetCode === "XLM"
            ? stellar_sdk_1.Asset.native()
            : new stellar_sdk_1.Asset(input.assetCode, input.assetIssuer);
        const account = await (0, rpc_client_1.loadAccount)(this.keypair.publicKey());
        const builder = new stellar_sdk_1.TransactionBuilder(account, {
            fee: stellar_sdk_1.BASE_FEE,
            networkPassphrase: this.networkPassphrase,
        }).addOperation(stellar_sdk_1.Operation.payment({ destination: input.destination, asset, amount: input.amount }));
        if (input.memo) {
            builder.addMemo(stellar_sdk_1.Memo.text(input.memo));
        }
        const tx = builder.setTimeout(30).build();
        // If pre-collected signatures are provided and meet threshold, sign and submit
        if (input.signatures && input.signatures.length >= input.minSignatures) {
            // Agent signs first
            tx.sign(this.keypair);
            // Apply additional signatures from provided decorated signatures (XDR-encoded)
            for (const sigXdr of input.signatures) {
                try {
                    const decoratedSig = stellar_sdk_1.xdr.DecoratedSignature.fromXDR(sigXdr, "base64");
                    tx.addDecoratedSignature(decoratedSig);
                }
                catch (err) {
                    throw new Error(`Invalid signature XDR: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            const result = StellarPaymentTool_1.SubmitResultSchema.parse(await (0, rpc_client_1.submitTransaction)(tx));
            return { txHash: result.hash, ledger: result.ledger };
        }
        // No sufficient signatures yet — return unsigned XDR for external collection
        return { unsignedXDR: tx.toXDR() };
    }
}
exports.MultiSigPaymentTool = MultiSigPaymentTool;
//# sourceMappingURL=MultiSigPaymentTool.js.map