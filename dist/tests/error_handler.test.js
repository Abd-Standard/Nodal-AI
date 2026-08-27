"use strict";
/**
 * tests/error_handler.test.ts
 * Unit tests for the centralised Zod error handler middleware.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const zod_1 = require("zod");
const error_handler_1 = require("../backend/middleware/error_handler");
function parseWithSchema(schema, value) {
    const result = schema.safeParse(value);
    if (result.success)
        throw new Error("Expected parse to fail");
    return result.error;
}
(0, vitest_1.describe)("handleError", () => {
    (0, vitest_1.describe)("ZodError input", () => {
        (0, vitest_1.it)("returns status 400 for a ZodError", () => {
            const err = parseWithSchema(zod_1.z.string(), 42);
            (0, vitest_1.expect)((0, error_handler_1.handleError)(err).status).toBe(400);
        });
        (0, vitest_1.it)("returns type ValidationError for a ZodError", () => {
            const err = parseWithSchema(zod_1.z.string(), 42);
            (0, vitest_1.expect)((0, error_handler_1.handleError)(err).type).toBe("ValidationError");
        });
        (0, vitest_1.it)("maps the field path correctly for a top-level field", () => {
            const schema = zod_1.z.object({ name: zod_1.z.string() });
            const err = parseWithSchema(schema, { name: 123 });
            const detail = (0, error_handler_1.handleError)(err).details[0];
            (0, vitest_1.expect)(detail.field).toBe("name");
        });
        (0, vitest_1.it)("maps a nested field path using dot notation", () => {
            const schema = zod_1.z.object({ user: zod_1.z.object({ email: zod_1.z.string().email() }) });
            const err = parseWithSchema(schema, { user: { email: "not-an-email" } });
            const detail = (0, error_handler_1.handleError)(err).details[0];
            (0, vitest_1.expect)(detail.field).toBe("user.email");
        });
        (0, vitest_1.it)("includes the message from the ZodIssue", () => {
            const schema = zod_1.z.string().min(5, "Too short");
            const err = parseWithSchema(schema, "ab");
            const detail = (0, error_handler_1.handleError)(err).details[0];
            (0, vitest_1.expect)(detail.message).toBe("Too short");
        });
        (0, vitest_1.it)("includes the code from the ZodIssue", () => {
            const schema = zod_1.z.string();
            const err = parseWithSchema(schema, 99);
            const detail = (0, error_handler_1.handleError)(err).details[0];
            (0, vitest_1.expect)(detail.code).toBeDefined();
        });
        (0, vitest_1.it)("returns 'root' as field when path is empty", () => {
            const schema = zod_1.z.string();
            const err = parseWithSchema(schema, null);
            const detail = (0, error_handler_1.handleError)(err).details[0];
            (0, vitest_1.expect)(detail.field).toBe("root");
        });
        (0, vitest_1.it)("does not leak a stack trace in the response", () => {
            const err = parseWithSchema(zod_1.z.number(), "text");
            const response = JSON.stringify((0, error_handler_1.handleError)(err));
            (0, vitest_1.expect)(response).not.toContain("at ");
        });
    });
    (0, vitest_1.describe)("non-ZodError input", () => {
        (0, vitest_1.it)("returns status 500 for a generic Error", () => {
            (0, vitest_1.expect)((0, error_handler_1.handleError)(new Error("boom")).status).toBe(500);
        });
        (0, vitest_1.it)("returns type InternalServerError for a generic Error", () => {
            (0, vitest_1.expect)((0, error_handler_1.handleError)(new Error("boom")).type).toBe("InternalServerError");
        });
        (0, vitest_1.it)("returns status 500 for an unknown thrown value", () => {
            (0, vitest_1.expect)((0, error_handler_1.handleError)("something went wrong").status).toBe(500);
        });
        (0, vitest_1.it)("does not leak the error message in the details", () => {
            const response = JSON.stringify((0, error_handler_1.handleError)(new Error("secret details")));
            (0, vitest_1.expect)(response).not.toContain("secret details");
        });
    });
});
//# sourceMappingURL=error_handler.test.js.map