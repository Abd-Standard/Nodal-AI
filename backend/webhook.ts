/**
 * backend/webhook.ts
 * Fire-and-forget webhook dispatcher called after every agent task.
 * Signs the payload with HMAC-SHA256 if WEBHOOK_SECRET is set.
 */

import crypto, { createHmac } from "crypto";
import axios from "axios";
import { config } from "./config";
import { withRetry } from "./rpc_client";
import { AgentResult } from "./agent";
import { createLogger } from "./utils/logger";

const log = createLogger("webhook");

export function signPayload(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function verifyWebhookSignature(payload: string, sig: string, secret: string): boolean {
  const expected = Buffer.from(signPayload(payload, secret), "hex");
  const received = Buffer.from(sig, "hex");
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(expected, received);
}

export async function dispatchWebhook(result: AgentResult): Promise<void> {
  if (!config.WEBHOOK_URL) return;

  const body = JSON.stringify(result);
  const headers: Record<string, string> = { "Content-Type": "application/json" };

  if (config.WEBHOOK_SECRET) {
    headers["X-Nodal-Signature"] = signPayload(body, config.WEBHOOK_SECRET);
  }

  try {
    await withRetry(
      () => axios.post(config.WEBHOOK_URL!, body, { headers }),
      3,
      200
    );
    log.info({ taskType: result.taskType }, "Webhook delivered");
  } catch (err) {
    log.warn(
      {
        taskType: result.taskType,
        error: err instanceof Error ? err.message : String(err),
      },
      "Webhook delivery failed"
    );
  }
}
