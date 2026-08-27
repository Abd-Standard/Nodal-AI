/**
 * backend/middleware/error_handler.ts
 * Centralised error handler. Converts ZodError instances into structured
 * JSON payloads and distinguishes validation errors (400) from internal
 * errors (500). Register this after all route handlers.
 */
export interface ErrorDetail {
    field: string;
    message: string;
    code: string;
}
export interface ErrorResponse {
    status: number;
    type: string;
    details: ErrorDetail[];
}
/**
 * Converts any caught error into a structured ErrorResponse.
 * Stack traces are never included in the returned payload.
 */
export declare function handleError(err: unknown): ErrorResponse;
//# sourceMappingURL=error_handler.d.ts.map