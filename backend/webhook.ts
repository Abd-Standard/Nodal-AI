/**
 * backend/webhook.ts
 * Fire-and-forget webhook dispatcher called after every agent task.
 * Signs the payload with HMAC-SHA256 if WEBHOOK_SECRET is set.
 *
 * Signature scheme: X-Nodal-Signature = hex(HMAC-SHA256(secret, `${timestamp}.${body}`)),
 * where `timestamp` is the Unix-seconds value sent in X-Nodal-Timestamp. Receivers
 * should reject timestamps outside a tolerance window and dedupe on X-Nodal-Delivery-Id.
 * Setting WEBHOOK_LEGACY_SIGNATURE=true keeps the old body-only signature for one release.
 */

import crypto, { createHmac } from 'crypto';
import axios from 'axios';
import { config } from './config';
import { AgentResult } from './agent';
import { createLogger } from './utils/logger';
import { handleRateLimitResponse } from './network';

const log = createLogger('webhook');

export function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export const DEFAULT_WEBHOOK_TOLERANCE_SEC = 300;

export function signWebhookPayload(
  timestamp: number | string,
  payload: string,
  secret: string
): string {
  return signPayload(`${timestamp}.${payload}`, secret);
}

export interface VerifyWebhookOptions {
  /** Value of the X-Nodal-Timestamp header (Unix seconds). Omit only for legacy body-only signatures. */
  timestamp?: number | string;
  /** Maximum allowed clock skew between sender and receiver, in seconds. Defaults to 300. */
  toleranceSec?: number;
  /** Current time in Unix seconds — overridable for tests. */
  nowSec?: number;
}

export function verifyWebhookSignature(
  payload: string,
  sig: string,
  secret: string,
  options: VerifyWebhookOptions = {}
): boolean {
  if (typeof sig !== 'string' || !/^[0-9a-fA-F]{64}$/.test(sig)) return false;
  const { timestamp, toleranceSec = DEFAULT_WEBHOOK_TOLERANCE_SEC } = options;
  let signed: string;
  if (timestamp === undefined) {
    // Legacy body-only signature (WEBHOOK_LEGACY_SIGNATURE) — no replay protection.
    signed = signPayload(payload, secret);
  } else {
    const ts = Number(timestamp);
    if (!Number.isInteger(ts)) return false;
    const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - ts) > toleranceSec) return false;
    signed = signWebhookPayload(ts, payload, secret);
  }
  const expected = Buffer.from(signed, 'hex');
  const received = Buffer.from(sig, 'hex');
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(expected, received);
}

interface HttpResponseLike {
  status?: number;
  headers?: Record<string, string>;
}

interface HttpErrorLike {
  status?: number;
  response?: HttpResponseLike;
}

export function isRetryableWebhookError(errOrStatus: unknown): boolean {
  let status: number | undefined;
  if (typeof errOrStatus === 'number') {
    status = errOrStatus;
  } else if (errOrStatus && typeof errOrStatus === 'object') {
    const httpErr = errOrStatus as HttpErrorLike;
    status = httpErr.response?.status ?? httpErr.status;
  }

  if (status !== undefined) {
    if (status >= 200 && status < 300) return false;
    if (status === 429) return true;
    if (status >= 400 && status < 500) return false;
    if (status >= 500 && status < 600) return true;
  }
  // Connection errors, network drops, or unclassified errors default to retryable
  return true;
}

export interface WebhookDispatchOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
}

export async function dispatchWebhook(
  result: AgentResult,
  options?: WebhookDispatchOptions
): Promise<void> {
  if (!config.WEBHOOK_URL) return;

  const maxAttempts = options?.maxAttempts ?? 3;
  const initialDelayMs = options?.initialDelayMs ?? 1000;

  const body = JSON.stringify(result);
  const timestamp = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Nodal-Timestamp': String(timestamp),
    // Stable across retries so receivers can dedupe redeliveries.
    'X-Nodal-Delivery-Id': crypto.randomUUID(),
  };

  if (config.WEBHOOK_SECRET) {
    headers['X-Nodal-Signature'] = config.WEBHOOK_LEGACY_SIGNATURE
      ? signPayload(body, config.WEBHOOK_SECRET)
      : signWebhookPayload(timestamp, body, config.WEBHOOK_SECRET);
  }

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await axios.post(config.WEBHOOK_URL, body, { headers });
      const status = response?.status;
      if (status !== undefined && (status < 200 || status >= 300)) {
        const error = Object.assign(new Error(`Webhook responded with status ${status}`), {
          status,
          response,
        });
        throw error;
      }
      log.info({ taskType: result.taskType }, 'Webhook delivered');
      return;
    } catch (err) {
      lastError = err;
      const httpErr = (err && typeof err === 'object' ? err : {}) as HttpErrorLike;
      const status = httpErr.response?.status ?? httpErr.status;
      if (status === 429) {
        const retryAfter = httpErr.response?.headers?.['retry-after'];
        handleRateLimitResponse(retryAfter);
      }

      if (!isRetryableWebhookError(err)) {
        log.warn(
          {
            taskType: result.taskType,
            status,
            attempt,
            error: err instanceof Error ? err.message : String(err),
          },
          'Webhook delivery failed (non-retryable)'
        );
        return;
      }

      log.warn(
        {
          taskType: result.taskType,
          status,
          attempt,
          maxAttempts,
          error: err instanceof Error ? err.message : String(err),
        },
        'Webhook delivery attempt failed'
      );

      if (attempt < maxAttempts) {
        const delay = initialDelayMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  log.warn(
    {
      taskType: result.taskType,
      attempts: maxAttempts,
      error: lastError instanceof Error ? lastError.message : String(lastError),
    },
    'Webhook delivery failed after max retries'
  );
}
