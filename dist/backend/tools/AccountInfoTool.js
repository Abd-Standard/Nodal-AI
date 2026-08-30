"use strict";
/**
 * backend/tools/AccountInfoTool.ts
 * Fetch agent account balances, sequence number, and trustlines from Horizon.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.AccountInfoTool = void 0;
const config_1 = require("../config");
const rpc_client_1 = require("../rpc_client");
class AccountInfoTool {
    async fetch() {
        const account = await (0, rpc_client_1.loadAccount)(config_1.config.AGENT_PUBLIC_KEY);
        const balances = account.balances.map((b) => ({
            asset: b.asset_type === "native" ? "XLM" : `${b.asset_code}:${b.asset_issuer}`,
            balance: b.balance,
        }));
        return {
            publicKey: config_1.config.AGENT_PUBLIC_KEY,
            balances,
            sequenceNumber: account.sequenceNumber(),
            subentryCount: account.subentry_count,
        };
    }
}
exports.AccountInfoTool = AccountInfoTool;
//# sourceMappingURL=AccountInfoTool.js.map