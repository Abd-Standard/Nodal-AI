"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const ContractEventListener_1 = require("../backend/tools/ContractEventListener");
const rpcClient = __importStar(require("../backend/rpc_client"));
vitest_1.vi.mock("../backend/rpc_client", () => ({
    sorobanServer: {
        getEvents: vitest_1.vi.fn(),
        getLatestLedger: vitest_1.vi.fn(),
    },
}));
vitest_1.vi.mock("../backend/config", () => ({
    config: {
        RETRY_DELAY_MS: 100,
        CONTRACT_EVENT_POLL_MS: 300,
    },
}));
vitest_1.vi.mock("../backend/logger", () => ({
    logger: {
        error: vitest_1.vi.fn(),
        info: vitest_1.vi.fn(),
        warn: vitest_1.vi.fn(),
        debug: vitest_1.vi.fn(),
    },
}));
const VALID_CONTRACT = "CDPVBHPSVYKWSI5ECEA4DASBG3RBNU5EHEE3DHNFX7RMBCZV66CSC7NH";
function makeEvent(topicStr, pagingToken) {
    return {
        topic: [{ toString: () => topicStr }],
        pagingToken,
    };
}
(0, vitest_1.describe)("ContractEventListener", () => {
    let stopListening;
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
        vitest_1.vi.useFakeTimers();
        vitest_1.vi.mocked(rpcClient.sorobanServer.getLatestLedger).mockResolvedValue({
            sequence: 1000,
        });
    });
    (0, vitest_1.afterEach)(() => {
        stopListening?.();
        vitest_1.vi.useRealTimers();
    });
    (0, vitest_1.it)("invokes onEvent for matching events on poll", async () => {
        const event = makeEvent("released", "tok-1");
        vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
            events: [event],
        });
        const onEvent = vitest_1.vi.fn();
        stopListening = (0, ContractEventListener_1.listen)(VALID_CONTRACT, ["released"], onEvent);
        await vitest_1.vi.advanceTimersByTimeAsync(200);
        (0, vitest_1.expect)(onEvent).toHaveBeenCalledWith(event);
    });
    (0, vitest_1.it)("does not invoke onEvent when topic does not match eventTypes", async () => {
        const event = makeEvent("cancelled", "tok-1");
        vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
            events: [event],
        });
        const onEvent = vitest_1.vi.fn();
        stopListening = (0, ContractEventListener_1.listen)(VALID_CONTRACT, ["released"], onEvent);
        await vitest_1.vi.advanceTimersByTimeAsync(200);
        (0, vitest_1.expect)(onEvent).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("stops polling after stopListening is called", async () => {
        vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
            events: [],
        });
        const onEvent = vitest_1.vi.fn();
        stopListening = (0, ContractEventListener_1.listen)(VALID_CONTRACT, [], onEvent);
        await vitest_1.vi.advanceTimersByTimeAsync(200);
        const callsBeforeStop = vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mock.calls.length;
        stopListening();
        await vitest_1.vi.advanceTimersByTimeAsync(500);
        (0, vitest_1.expect)(vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mock.calls.length).toBe(callsBeforeStop);
    });
    (0, vitest_1.it)("logs an error and keeps polling when getEvents rejects", async () => {
        const { logger } = await Promise.resolve().then(() => __importStar(require("../backend/logger")));
        vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mockRejectedValueOnce(new Error("RPC unavailable"));
        const onEvent = vitest_1.vi.fn();
        stopListening = (0, ContractEventListener_1.listen)(VALID_CONTRACT, [], onEvent);
        await vitest_1.vi.advanceTimersByTimeAsync(200);
        (0, vitest_1.expect)(logger.error).toHaveBeenCalled();
    });
    (0, vitest_1.it)("polls sorobanServer.getEvents() at the configured interval", async () => {
        vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
            events: [],
        });
        const onEvent = vitest_1.vi.fn();
        stopListening = (0, ContractEventListener_1.listen)(VALID_CONTRACT, [], onEvent);
        await vitest_1.vi.advanceTimersByTimeAsync(600);
        (0, vitest_1.expect)(rpcClient.sorobanServer.getEvents).toHaveBeenCalledTimes(3);
    });
    (0, vitest_1.it)("emits parsed events to registered callback", async () => {
        const event = makeEvent("released", "tok-1");
        vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
            events: [event],
        });
        const onEvent = vitest_1.vi.fn();
        stopListening = (0, ContractEventListener_1.listen)(VALID_CONTRACT, ["released"], onEvent);
        await vitest_1.vi.advanceTimersByTimeAsync(200);
        (0, vitest_1.expect)(onEvent).toHaveBeenCalledWith(event);
    });
    (0, vitest_1.it)("handles sorobanServer.getEvents() rejection without crashing", async () => {
        vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents)
            .mockRejectedValueOnce(new Error("RPC unavailable"))
            .mockResolvedValue({ events: [] });
        const onEvent = vitest_1.vi.fn();
        stopListening = (0, ContractEventListener_1.listen)(VALID_CONTRACT, [], onEvent);
        // The listener should keep polling on subsequent ticks rather than dying.
        await vitest_1.vi.advanceTimersByTimeAsync(600);
        (0, vitest_1.expect)(rpcClient.sorobanServer.getEvents).toHaveBeenCalledTimes(3);
    });
    (0, vitest_1.it)("stops polling when stop() is called", async () => {
        vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
            events: [],
        });
        const onEvent = vitest_1.vi.fn();
        stopListening = (0, ContractEventListener_1.listen)(VALID_CONTRACT, [], onEvent);
        await vitest_1.vi.advanceTimersByTimeAsync(200);
        const callsBeforeStop = vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mock.calls.length;
        stopListening();
        await vitest_1.vi.advanceTimersByTimeAsync(600);
        (0, vitest_1.expect)(vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mock.calls.length).toBe(callsBeforeStop);
    });
    (0, vitest_1.it)("does not emit events after stop() is called", async () => {
        const event = makeEvent("released", "tok-1");
        vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
            events: [event],
        });
        const onEvent = vitest_1.vi.fn();
        stopListening = (0, ContractEventListener_1.listen)(VALID_CONTRACT, ["released"], onEvent);
        await vitest_1.vi.advanceTimersByTimeAsync(200);
        (0, vitest_1.expect)(onEvent).toHaveBeenCalledTimes(1);
        stopListening();
        await vitest_1.vi.advanceTimersByTimeAsync(1000);
        (0, vitest_1.expect)(onEvent).toHaveBeenCalledTimes(1);
    });
});
//# sourceMappingURL=contract_event_listener.test.js.map