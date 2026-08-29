/**
 * backend/webhook.ts
 * Fire-and-forget webhook dispatcher called after every agent task.
 * Signs the payload with HMAC-SHA256 if WEBHOOK_SECRET is set.
 */
import { AgentResult } from "./agent";
export declare function signPayload(payload: string, secret: string): string;
export declare function verifyWebhookSignature(payload: string, sig: string, secret: string): boolean;
export declare function dispatchWebhook(result: AgentResult): Promise<void>;
//# sourceMappingURL=webhook.d.ts.map