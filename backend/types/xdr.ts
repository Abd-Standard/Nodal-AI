/**
 * backend/types/xdr.ts
 * Zod schema validation for Stellar XDR payloads.
 * Validates structure before any network call is initiated.
 */

import { z } from 'zod';

export class InvalidXDRFormat extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidXDRFormat';
  }
}

// 64 KB ceiling — largest realistic Stellar transaction envelope
const MAX_XDR_BYTES = 65_536;

export const XDRPayloadSchema = z
  .string()
  .min(1, 'XDR payload must not be empty')
  .max(MAX_XDR_BYTES, `Payload exceeds maximum XDR size of ${MAX_XDR_BYTES} bytes`)
  .base64({ message: 'Invalid base64 encoding' });

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
