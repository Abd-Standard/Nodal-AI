"use strict";
/**
 * tests/webhook.test.ts
 * Tests for dispatchWebhook: delivery, HMAC signature, retry, and no-op when unconfigured.
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
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const crypto_1 = require("crypto");
const webhook_1 = require("../backend/webhook");
// ─── Mocks ────────────────────────────────────────────────────────────────────
vitest_1.vi.mock("axios", () => ({
    default: { post: vitest_1.vi.fn() },
}));
vitest_1.vi.mock("../backend/rpc_client", () => ({
    withRetry: vitest_1.vi.fn(async (fn) => fn()),
    DEFAULT_IS_RETRYABLE: vitest_1.vi.fn(() => true),
}));
// ─── Config mock — overridden per test ───────────────────────────────────────
vitest_1.vi.mock("../backend/config", () => ({
    config: {
        get WEBHOOK_URL() { return globalThis.__webhookUrl; },
        get WEBHOOK_SECRET() { return globalThis.__webhookSecret; },
    },
}));
// ─── Fixtures ─────────────────────────────────────────────────────────────────
const successResult = {
    success: true,
    taskType: "stellar_payment",
    data: { txHash: "abc123", ledger: 10 },
};
const failureResult = {
    success: false,
    taskType: "x402_respond",
    error: "insufficient funds",
};
// ─── Tests ────────────────────────────────────────────────────────────────────
(0, vitest_1.describe)("signPayload", () => {
    (0, vitest_1.it)("produces a valid HMAC-SHA256 hex string", () => {
        const payload = '{"foo":"bar"}';
        const secret = "mysecret";
        const expected = (0, crypto_1.createHmac)("sha256", secret).update(payload).digest("hex");
        (0, vitest_1.expect)((0, webhook_1.signPayload)(payload, secret)).toBe(expected);
    });
});
(0, vitest_1.describe)("verifyWebhookSignature", () => {
    (0, vitest_1.it)("returns true for a valid signature", () => {
        const payload = '{"foo":"bar"}';
        const secret = "mysecret";
        const sig = (0, webhook_1.signPayload)(payload, secret);
        (0, vitest_1.expect)((0, webhook_1.verifyWebhookSignature)(payload, sig, secret)).toBe(true);
    });
    (0, vitest_1.it)("returns false for an invalid signature", () => {
        const payload = '{"foo":"bar"}';
        const secret = "mysecret";
        const sig = "incorrectsignature";
        (0, vitest_1.expect)((0, webhook_1.verifyWebhookSignature)(payload, sig, secret)).toBe(false);
    });
    (0, vitest_1.it)("returns false for a signature with incorrect length", () => {
        const payload = '{"foo":"bar"}';
        const secret = "mysecret";
        const sig = "abc";
        (0, vitest_1.expect)((0, webhook_1.verifyWebhookSignature)(payload, sig, secret)).toBe(false);
    });
    (0, vitest_1.it)("returns false for a valid signature signed with a different secret", () => {
        const payload = '{"foo":"bar"}';
        const sig = (0, webhook_1.signPayload)(payload, "wrongsecret");
        (0, vitest_1.expect)((0, webhook_1.verifyWebhookSignature)(payload, sig, "mysecret")).toBe(false);
    });
});
(0, vitest_1.describe)("dispatchWebhook", () => {
    let axiosPost;
    (0, vitest_1.beforeEach)(async () => {
        vitest_1.vi.clearAllMocks();
        globalThis.__webhookUrl = undefined;
        globalThis.__webhookSecret = undefined;
        const axios = (await Promise.resolve().then(() => __importStar(require("axios")))).default;
        axiosPost = axios.post;
    });
    (0, vitest_1.it)("does nothing when WEBHOOK_URL is not set", async () => {
        globalThis.__webhookUrl = undefined;
        await (0, webhook_1.dispatchWebhook)(successResult);
        (0, vitest_1.expect)(axiosPost).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)("POSTs the AgentResult as JSON when WEBHOOK_URL is set", async () => {
        globalThis.__webhookUrl = "https://example.com/webhook";
        axiosPost.mockResolvedValueOnce({ status: 200 });
        await (0, webhook_1.dispatchWebhook)(successResult);
        (0, vitest_1.expect)(axiosPost).toHaveBeenCalledOnce();
        const calls = axiosPost.mock.calls;
        const call = calls[0];
        (0, vitest_1.expect)(call).toBeDefined();
        if (!call)
            return;
        const [url, body] = call;
        (0, vitest_1.expect)(url).toBe("https://example.com/webhook");
        (0, vitest_1.expect)(JSON.parse(body)).toMatchObject({ success: true, taskType: "stellar_payment" });
    });
    (0, vitest_1.it)("includes X-Nodal-Signature header when WEBHOOK_SECRET is set", async () => {
        globalThis.__webhookUrl = "https://example.com/webhook";
        globalThis.__webhookSecret = "supersecret";
        axiosPost.mockResolvedValueOnce({ status: 200 });
        await (0, webhook_1.dispatchWebhook)(successResult);
        const call = axiosPost.mock.calls[0];
        (0, vitest_1.expect)(call).toBeDefined();
        if (!call)
            return;
        const [, body, opts] = call;
        const expectedSig = (0, webhook_1.signPayload)(body, "supersecret");
        (0, vitest_1.expect)(opts.headers["X-Nodal-Signature"]).toBe(expectedSig);
    });
    (0, vitest_1.it)("POSTs on task failure result as well", async () => {
        globalThis.__webhookUrl = "https://example.com/webhook";
        axiosPost.mockResolvedValueOnce({ status: 200 });
        await (0, webhook_1.dispatchWebhook)(failureResult);
        const call = axiosPost.mock.calls[0];
        (0, vitest_1.expect)(call).toBeDefined();
        if (!call)
            return;
        const [, body] = call;
        (0, vitest_1.expect)(JSON.parse(body)).toMatchObject({ success: false, taskType: "x402_respond" });
    });
    (0, vitest_1.it)("does not throw when axios.post rejects (swallows delivery errors)", async () => {
        globalThis.__webhookUrl = "https://example.com/webhook";
        axiosPost.mockRejectedValueOnce(new Error("network error"));
        await (0, vitest_1.expect)((0, webhook_1.dispatchWebhook)(successResult)).resolves.toBeUndefined();
    });
});
//# sourceMappingURL=webhook.test.js.map