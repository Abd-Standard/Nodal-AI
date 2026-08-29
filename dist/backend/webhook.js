"use strict";
/**
 * backend/webhook.ts
 * Fire-and-forget webhook dispatcher called after every agent task.
 * Signs the payload with HMAC-SHA256 if WEBHOOK_SECRET is set.
 */
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.signPayload = signPayload;
exports.verifyWebhookSignature = verifyWebhookSignature;
exports.dispatchWebhook = dispatchWebhook;
const crypto_1 = __importStar(require("crypto"));
const axios_1 = __importDefault(require("axios"));
const config_1 = require("./config");
const rpc_client_1 = require("./rpc_client");
const logger_1 = require("./utils/logger");
const log = (0, logger_1.createLogger)("webhook");
function signPayload(payload, secret) {
    return (0, crypto_1.createHmac)("sha256", secret).update(payload).digest("hex");
}
function verifyWebhookSignature(payload, sig, secret) {
    const expected = Buffer.from(signPayload(payload, secret), "hex");
    const received = Buffer.from(sig, "hex");
    if (expected.length !== received.length)
        return false;
    return crypto_1.default.timingSafeEqual(expected, received);
}
async function dispatchWebhook(result) {
    if (!config_1.config.WEBHOOK_URL)
        return;
    const body = JSON.stringify(result);
    const headers = { "Content-Type": "application/json" };
    if (config_1.config.WEBHOOK_SECRET) {
        headers["X-Nodal-Signature"] = signPayload(body, config_1.config.WEBHOOK_SECRET);
    }
    try {
        await (0, rpc_client_1.withRetry)(() => axios_1.default.post(config_1.config.WEBHOOK_URL, body, { headers }), 3, 200);
        log.info({ taskType: result.taskType }, "Webhook delivered");
    }
    catch (err) {
        log.warn({
            taskType: result.taskType,
            error: err instanceof Error ? err.message : String(err),
        }, "Webhook delivery failed");
    }
}
//# sourceMappingURL=webhook.js.map