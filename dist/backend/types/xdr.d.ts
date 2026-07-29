/**
 * backend/types/xdr.ts
 * Zod schema validation for Stellar XDR payloads.
 * Validates structure before any network call is initiated.
 */
import { z } from "zod";
export declare class InvalidXDRFormat extends Error {
    constructor(message: string);
}
export declare const XDRPayloadSchema: z.ZodString;
export type XDRPayload = z.infer<typeof XDRPayloadSchema>;
/**
 * Validate a raw value as a base64-encoded XDR payload.
 * Throws InvalidXDRFormat with a clear, actionable message on failure.
 */
export declare function validateXDR(raw: unknown): XDRPayload;
//# sourceMappingURL=xdr.d.ts.map