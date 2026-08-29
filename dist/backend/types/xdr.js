"use strict";
/**
 * backend/types/xdr.ts
 * Zod schema validation for Stellar XDR payloads.
 * Validates structure before any network call is initiated.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.XDRPayloadSchema = exports.InvalidXDRFormat = void 0;
exports.validateXDR = validateXDR;
const zod_1 = require("zod");
class InvalidXDRFormat extends Error {
    constructor(message) {
        super(message);
        this.name = "InvalidXDRFormat";
    }
}
exports.InvalidXDRFormat = InvalidXDRFormat;
// 64 KB ceiling — largest realistic Stellar transaction envelope
const MAX_XDR_BYTES = 65_536;
exports.XDRPayloadSchema = zod_1.z
    .string()
    .min(1, "XDR payload must not be empty")
    .max(MAX_XDR_BYTES, `Payload exceeds maximum XDR size of ${MAX_XDR_BYTES} bytes`)
    .base64({ message: "Invalid base64 encoding" });
/**
 * Validate a raw value as a base64-encoded XDR payload.
 * Throws InvalidXDRFormat with a clear, actionable message on failure.
 */
function validateXDR(raw) {
    const result = exports.XDRPayloadSchema.safeParse(raw);
    if (!result.success) {
        const firstIssue = result.error.issues[0];
        throw new InvalidXDRFormat(firstIssue ? firstIssue.message : "Invalid XDR payload");
    }
    return result.data;
}
//# sourceMappingURL=xdr.js.map