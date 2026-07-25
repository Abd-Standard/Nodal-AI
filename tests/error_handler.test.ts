/**
 * tests/error_handler.test.ts
 * Unit tests for the centralised Zod error handler middleware.
 */

import { describe, it, expect } from "vitest";
import { z, ZodError } from "zod";
import { handleError } from "../backend/middleware/error_handler";

function parseWithSchema(schema: z.ZodTypeAny, value: unknown): ZodError {
  const result = schema.safeParse(value);
  if (result.success) throw new Error("Expected parse to fail");
  return result.error;
}

describe("handleError", () => {
  describe("ZodError input", () => {
    it("returns status 400 for a ZodError", () => {
      const err = parseWithSchema(z.string(), 42);
      expect(handleError(err).status).toBe(400);
    });

    it("returns type ValidationError for a ZodError", () => {
      const err = parseWithSchema(z.string(), 42);
      expect(handleError(err).type).toBe("ValidationError");
    });

    it("maps the field path correctly for a top-level field", () => {
      const schema = z.object({ name: z.string() });
      const err = parseWithSchema(schema, { name: 123 });
      const detail = handleError(err).details[0]!;
      expect(detail.field).toBe("name");
    });

    it("maps a nested field path using dot notation", () => {
      const schema = z.object({ user: z.object({ email: z.string().email() }) });
      const err = parseWithSchema(schema, { user: { email: "not-an-email" } });
      const detail = handleError(err).details[0]!;
      expect(detail.field).toBe("user.email");
    });

    it("includes the message from the ZodIssue", () => {
      const schema = z.string().min(5, "Too short");
      const err = parseWithSchema(schema, "ab");
      const detail = handleError(err).details[0]!;
      expect(detail.message).toBe("Too short");
    });

    it("includes the code from the ZodIssue", () => {
      const schema = z.string();
      const err = parseWithSchema(schema, 99);
      const detail = handleError(err).details[0]!;
      expect(detail.code).toBeDefined();
    });

    it("returns 'root' as field when path is empty", () => {
      const schema = z.string();
      const err = parseWithSchema(schema, null);
      const detail = handleError(err).details[0]!;
      expect(detail.field).toBe("root");
    });

    it("does not leak a stack trace in the response", () => {
      const err = parseWithSchema(z.number(), "text");
      const response = JSON.stringify(handleError(err));
      expect(response).not.toContain("at ");
    });
  });

  describe("non-ZodError input", () => {
    it("returns status 500 for a generic Error", () => {
      expect(handleError(new Error("boom")).status).toBe(500);
    });

    it("returns type InternalServerError for a generic Error", () => {
      expect(handleError(new Error("boom")).type).toBe("InternalServerError");
    });

    it("returns status 500 for an unknown thrown value", () => {
      expect(handleError("something went wrong").status).toBe(500);
    });

    it("does not leak the error message in the details", () => {
      const response = JSON.stringify(handleError(new Error("secret details")));
      expect(response).not.toContain("secret details");
    });
  });
});
