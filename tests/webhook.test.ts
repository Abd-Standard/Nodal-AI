/**
 * tests/webhook.test.ts
 * Tests for dispatchWebhook: delivery, HMAC signature, retry, and no-op when unconfigured.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHmac } from "crypto";
import { signPayload, dispatchWebhook, verifyWebhookSignature } from "../backend/webhook";
import type { AgentResult } from "../backend/agent";

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("axios", () => ({
  default: { post: vi.fn() },
}));

vi.mock("../backend/rpc_client", () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
  DEFAULT_IS_RETRYABLE: vi.fn(() => true),
}));

// ─── Config mock — overridden per test ───────────────────────────────────────

vi.mock("../backend/config", () => ({
  config: {
    get WEBHOOK_URL() { return (globalThis as any).__webhookUrl; },
    get WEBHOOK_SECRET() { return (globalThis as any).__webhookSecret; },
  },
}));

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const successResult: AgentResult = {
  success: true,
  taskType: "stellar_payment",
  data: { txHash: "abc123", ledger: 10 },
};

const failureResult: AgentResult = {
  success: false,
  taskType: "x402_respond",
  error: "insufficient funds",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("signPayload", () => {
  it("produces a valid HMAC-SHA256 hex string", () => {
    const payload = '{"foo":"bar"}';
    const secret = "mysecret";
    const expected = createHmac("sha256", secret).update(payload).digest("hex");
    expect(signPayload(payload, secret)).toBe(expected);
  });
});

describe("verifyWebhookSignature", () => {
  it("returns true for a valid signature", () => {
    const payload = '{"foo":"bar"}';
    const secret = "mysecret";
    const sig = signPayload(payload, secret);
    expect(verifyWebhookSignature(payload, sig, secret)).toBe(true);
  });

  it("returns false for an invalid signature", () => {
    const payload = '{"foo":"bar"}';
    const secret = "mysecret";
    const sig = "incorrectsignature";
    expect(verifyWebhookSignature(payload, sig, secret)).toBe(false);
  });

  it("returns false for a signature with incorrect length", () => {
    const payload = '{"foo":"bar"}';
    const secret = "mysecret";
    const sig = "abc";
    expect(verifyWebhookSignature(payload, sig, secret)).toBe(false);
  });

  it("returns false for a valid signature signed with a different secret", () => {
    const payload = '{"foo":"bar"}';
    const sig = signPayload(payload, "wrongsecret");
    expect(verifyWebhookSignature(payload, sig, "mysecret")).toBe(false);
  });

  it("returns false for a tampered payload", () => {
    const payload = '{"foo":"bar"}';
    const secret = "mysecret";
    const sig = signPayload(payload, secret);
    const tamperedPayload = '{"foo":"baz"}';
    expect(verifyWebhookSignature(tamperedPayload, sig, secret)).toBe(false);
  });

  it("returns false for a wrong secret", () => {
    const payload = '{"foo":"bar"}';
    const correctSecret = "mysecret";
    const wrongSecret = "incorrectsecret";
    const sig = signPayload(payload, correctSecret);
    expect(verifyWebhookSignature(payload, sig, wrongSecret)).toBe(false);
  });

  it("returns false for signatures of different lengths without throwing", () => {
    const payload = '{"foo":"bar"}';
    const secret = "mysecret";
    const shortSig = "short";
    const longSig = signPayload(payload, secret) + "extra";
    expect(() => verifyWebhookSignature(payload, shortSig, secret)).not.toThrow();
    expect(verifyWebhookSignature(payload, shortSig, secret)).toBe(false);
    expect(() => verifyWebhookSignature(payload, longSig, secret)).not.toThrow();
    expect(verifyWebhookSignature(payload, longSig, secret)).toBe(false);
  });
});

describe("dispatchWebhook", () => {
  let axiosPost: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    (globalThis as any).__webhookUrl = undefined;
    (globalThis as any).__webhookSecret = undefined;
    const axios = (await import("axios")).default;
    axiosPost = axios.post as ReturnType<typeof vi.fn>;
  });

  it("does nothing when WEBHOOK_URL is not set", async () => {
    (globalThis as any).__webhookUrl = undefined;
    await dispatchWebhook(successResult);
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it("POSTs the AgentResult as JSON when WEBHOOK_URL is set", async () => {
    (globalThis as any).__webhookUrl = "https://example.com/webhook";
    axiosPost.mockResolvedValueOnce({ status: 200 });

    await dispatchWebhook(successResult);

    expect(axiosPost).toHaveBeenCalledOnce();
    const calls = axiosPost.mock.calls;
    const call = calls[0];
    expect(call).toBeDefined();
    if (!call) return;
    const [url, body] = call;
    expect(url).toBe("https://example.com/webhook");
    expect(JSON.parse(body as string)).toMatchObject({ success: true, taskType: "stellar_payment" });
  });

  it("includes X-Nodal-Signature header when WEBHOOK_SECRET is set", async () => {
    (globalThis as any).__webhookUrl = "https://example.com/webhook";
    (globalThis as any).__webhookSecret = "supersecret";
    axiosPost.mockResolvedValueOnce({ status: 200 });

    await dispatchWebhook(successResult);

    const call = axiosPost.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) return;
    const [, body, opts] = call;
    const expectedSig = signPayload(body as string, "supersecret");
    expect(opts.headers["X-Nodal-Signature"]).toBe(expectedSig);
  });

  it("POSTs on task failure result as well", async () => {
    (globalThis as any).__webhookUrl = "https://example.com/webhook";
    axiosPost.mockResolvedValueOnce({ status: 200 });

    await dispatchWebhook(failureResult);

    const call = axiosPost.mock.calls[0];
    expect(call).toBeDefined();
    if (!call) return;
    const [, body] = call;
    expect(JSON.parse(body as string)).toMatchObject({ success: false, taskType: "x402_respond" });
  });

  it("does not throw when axios.post rejects (swallows delivery errors)", async () => {
    (globalThis as any).__webhookUrl = "https://example.com/webhook";
    axiosPost.mockRejectedValue(new Error("network error"));

    vi.useFakeTimers();
    try {
      const promise = dispatchWebhook(successResult);
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries 503 responses with exponential backoff and delivers on 200 (503 -> 503 -> 200)", async () => {
    (globalThis as any).__webhookUrl = "https://example.com/webhook";
    axiosPost
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce({ status: 200 });

    vi.useFakeTimers();
    try {
      const promise = dispatchWebhook(successResult);
      await vi.runAllTimersAsync();
      await promise;

      expect(axiosPost).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries when subscriber resolves with non-2xx status (503 -> 503 -> 200)", async () => {
    (globalThis as any).__webhookUrl = "https://example.com/webhook";
    axiosPost
      .mockResolvedValueOnce({ status: 503 })
      .mockResolvedValueOnce({ status: 503 })
      .mockResolvedValueOnce({ status: 200 });

    vi.useFakeTimers();
    try {
      const promise = dispatchWebhook(successResult);
      await vi.runAllTimersAsync();
      await promise;

      expect(axiosPost).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry on HTTP 4xx (e.g. 400, 404) responses", async () => {
    (globalThis as any).__webhookUrl = "https://example.com/webhook";
    axiosPost.mockRejectedValueOnce({ response: { status: 404 } });

    vi.useFakeTimers();
    try {
      const promise = dispatchWebhook(successResult);
      await vi.runAllTimersAsync();
      await promise;

      expect(axiosPost).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries on HTTP 429 rate limit responses", async () => {
    (globalThis as any).__webhookUrl = "https://example.com/webhook";
    axiosPost
      .mockRejectedValueOnce({ response: { status: 429, headers: { "retry-after": "1" } } })
      .mockResolvedValueOnce({ status: 200 });

    vi.useFakeTimers();
    try {
      const promise = dispatchWebhook(successResult);
      await vi.runAllTimersAsync();
      await promise;

      expect(axiosPost).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ceases retrying after 3 failed attempts on persistent 5xx errors", async () => {
    (globalThis as any).__webhookUrl = "https://example.com/webhook";
    axiosPost.mockRejectedValue({ response: { status: 500 } });

    vi.useFakeTimers();
    try {
      const promise = dispatchWebhook(successResult);
      await vi.runAllTimersAsync();
      await promise;

      expect(axiosPost).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
