"use strict";
/**
 * backend/tools/ContractEventListener.ts
 * Polling-based listener for Soroban contract events.
 *
 * Soroban RPC has no WebSocket stream, so this tool polls getEvents()
 * on an interval and invokes a callback for each new matching event.
 *
 * Architecture: poll getEvents() → filter by eventTypes → invoke onEvent → repeat
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.listen = listen;
const config_1 = require("../config");
const logger_1 = require("../logger");
const rpc_client_1 = require("../rpc_client");
function listen(contractId, eventTypes, onEvent) {
    let cursor;
    let startLedgerPromise;
    const pollIntervalMs = config_1.config.CONTRACT_EVENT_POLL_MS ?? config_1.config.RETRY_DELAY_MS * 2;
    const poll = async () => {
        try {
            if (!cursor && !startLedgerPromise) {
                startLedgerPromise = rpc_client_1.sorobanServer
                    .getLatestLedger()
                    .then((l) => l.sequence);
            }
            const response = await rpc_client_1.sorobanServer.getEvents({
                filters: [{ type: "contract", contractIds: [contractId] }],
                ...(cursor ? { cursor } : { startLedger: await startLedgerPromise }),
            });
            for (const event of response.events) {
                const matches = eventTypes.length === 0 ||
                    event.topic.some((t) => eventTypes.includes(t.toString()));
                if (matches)
                    onEvent(event);
            }
            if (response.events.length > 0) {
                const lastEvent = response.events[response.events.length - 1];
                if (lastEvent) {
                    cursor = lastEvent.pagingToken;
                }
            }
            else if ("cursor" in response && response.cursor) {
                cursor = response.cursor;
            }
        }
        catch (err) {
            logger_1.logger.error("ContractEventListener polling error", {
                contractId,
                error: err.message,
            });
        }
    };
    void poll();
    const intervalId = setInterval(poll, pollIntervalMs);
    return () => clearInterval(intervalId);
}
//# sourceMappingURL=ContractEventListener.js.map