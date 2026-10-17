/**
 * backend/types/xdr.ts
 * Zod schema validation for Stellar XDR payloads.
 * Validates structure before any network call is initiated.
 */

import { z } from 'zod';

/**
 * Thrown when a raw value fails XDR payload validation.
 */
export class InvalidXDRFormat extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidXDRFormat';
  }
}

// 64 KB ceiling — largest realistic Stellar transaction envelope (decoded bytes)
const MAX_XDR_BYTES = 65_536;

export const XDRPayloadSchema = z
  .string()
  .min(1, 'XDR payload must not be empty')
  .base64({ message: 'Invalid base64 encoding' })
  .refine(
    (raw) => Buffer.byteLength(raw, 'base64') <= MAX_XDR_BYTES,
    { message: `Payload exceeds maximum XDR size of ${MAX_XDR_BYTES} bytes` },
  );

export type XDRPayload = z.infer<typeof XDRPayloadSchema>;

/**
 * Validate a raw value as a base64-encoded XDR payload.
 * Throws InvalidXDRFormat with a clear, actionable message on failure.
 */
export function validateXDR(raw: unknown): XDRPayload {
  const result = XDRPayloadSchema.safeParse(raw);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    throw new InvalidXDRFormat(firstIssue ? firstIssue.message : 'Invalid XDR payload');
  }
  return result.data;
}
