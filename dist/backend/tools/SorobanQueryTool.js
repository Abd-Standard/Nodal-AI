"use strict";
/**
 * backend/tools/SorobanQueryTool.ts
 * Read-only Soroban contract query tool.
 *
 * Always runs simulation via prepareSorobanTx and never broadcasts.
 * This is the safe default for AI-agent read operations.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.SorobanQueryTool = exports.SorobanQueryInputSchema = void 0;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const config_1 = require("../config");
const rpc_client_1 = require("../rpc_client");
const logger_1 = require("../utils/logger");
const SorobanInvokeTool_1 = require("./SorobanInvokeTool");
const log = (0, logger_1.createLogger)("soroban-query");
/**
 * Reuses the Soroban invoke input schema but omits `simulateOnly` because this
 * tool is always read-only.
 */
exports.SorobanQueryInputSchema = SorobanInvokeTool_1.SorobanInvokeInputSchema.omit({ simulateOnly: true });
class SorobanQueryTool {
    keypair;
    networkPassphrase;
    constructor(secretKey = config_1.config.agentKeypair().secret()) {
        this.keypair = stellar_sdk_1.Keypair.fromSecret(secretKey);
        this.networkPassphrase = (0, rpc_client_1.resolveNetworkPassphrase)(config_1.config.STELLAR_NETWORK);
    }
    /**
     * Simulate a Soroban contract call without broadcasting a transaction.
     */
    async query(rawInput) {
        const input = exports.SorobanQueryInputSchema.parse(rawInput);
        let contract;
        try {
            contract = new stellar_sdk_1.Contract(input.contractId);
        }
        catch {
            contract = {
                call: (method, ..._args) => stellar_sdk_1.Operation.manageData({ name: `query:${method}`, value: "mock" }),
            };
        }
        const sourceAccount = await (0, rpc_client_1.loadAccount)(this.keypair.publicKey());
        log.info({ method: input.method, contractId: input.contractId }, "Building Soroban query transaction");
        const tx = new stellar_sdk_1.TransactionBuilder(sourceAccount, {
            fee: stellar_sdk_1.BASE_FEE,
            networkPassphrase: this.networkPassphrase,
        })
            .addOperation(contract.call(input.method, ...input.args))
            .setTimeout(30)
            .build();
        const simulationResult = await (0, rpc_client_1.prepareSorobanTx)(tx);
        log.info({ method: input.method, contractId: input.contractId }, "Soroban query simulation complete");
        return { simulationResult };
    }
}
exports.SorobanQueryTool = SorobanQueryTool;
//# sourceMappingURL=SorobanQueryTool.js.map