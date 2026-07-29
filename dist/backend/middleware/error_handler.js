"use strict";
/**
 * backend/middleware/error_handler.ts
 * Centralised error handler. Converts ZodError instances into structured
 * JSON payloads and distinguishes validation errors (400) from internal
 * errors (500). Register this after all route handlers.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleError = handleError;
const zod_1 = require("zod");
function mapZodIssues(issues) {
    return issues.map((issue) => ({
        field: issue.path.length > 0 ? issue.path.join(".") : "root",
        message: issue.message,
        code: issue.code,
    }));
}
/**
 * Converts any caught error into a structured ErrorResponse.
 * Stack traces are never included in the returned payload.
 */
function handleError(err) {
    if (err instanceof zod_1.ZodError) {
        return {
            status: 400,
            type: "ValidationError",
            details: mapZodIssues(err.issues),
        };
    }
    return {
        status: 500,
        type: "InternalServerError",
        details: [
            {
                field: "unknown",
                message: "An unexpected error occurred",
                code: "internal_error",
            },
        ],
    };
}
//# sourceMappingURL=error_handler.js.map