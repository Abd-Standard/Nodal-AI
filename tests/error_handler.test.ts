/**
 * tests/error_handler.test.ts
 * Unit tests for the centralised Zod error handler middleware.
 */

import { describe, it, expect } from "vitest";
import { z, ZodError } from "zod";
import { handleError } from "../backend/middleware/error_handler";
import {
  ConfigError,
  ContractError,
  ErrorType,
  InsufficientFundsError,
  NetworkTimeoutError,
  RateLimitError,
  TransactionFailureError,
  UnauthorizedError,
  ValidationError,
} from "../backend/errors";

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

describe("StructuredError input", () => {
  it("maps ValidationError to 400", () => {
    const result = handleError(new ValidationError("bad amount"));
    expect(result.status).toBe(400);
    expect(result.type).toBe("ValidationError");
  });

  it("maps UnauthorizedError to 401", () => {
    const result = handleError(new UnauthorizedError("no token"));
    expect(result.status).toBe(401);
    expect(result.type).toBe("UnauthorizedError");
  });

  it("maps RateLimitError to 429", () => {
    const result = handleError(new RateLimitError("slow down"));
    expect(result.status).toBe(429);
    expect(result.type).toBe("RateLimitError");
  });

  it("maps NetworkTimeoutError to 503", () => {
    const result = handleError(new NetworkTimeoutError("horizon timed out"));
    expect(result.status).toBe(503);
    expect(result.type).toBe("NetworkTimeoutError");
  });

  it("falls back to 500 for error types with no client-side meaning", () => {
    expect(handleError(new ContractError("trapped")).status).toBe(500);
    expect(handleError(new TransactionFailureError("tx failed")).status).toBe(500);
    expect(handleError(new InsufficientFundsError("broke")).status).toBe(500);
    expect(handleError(new ConfigError("misconfigured")).status).toBe(500);
  });

  it("includes a Retry-After header for RateLimitError", () => {
    const result = handleError(new RateLimitError("slow down", 30));
    expect(result.headers?.["Retry-After"]).toBe("30");
  });

  it("defaults Retry-After to 60 seconds when the error carries no hint", () => {
    const result = handleError(new RateLimitError("slow down"));
    expect(result.headers?.["Retry-After"]).toBe("60");
  });

  it("does not attach headers to errors other than RateLimitError", () => {
    expect(handleError(new ValidationError("bad")).headers).toBeUndefined();
  });

  it("surfaces the message for client-side errors", () => {
    const result = handleError(new ValidationError("amount must be positive"));
    expect(result.details[0]!.message).toBe("amount must be positive");
  });

  it("does not leak the message of a server-side error", () => {
    const result = handleError(new ContractError("secret internal detail"));
    expect(result.details[0]!.message).toBe("An unexpected error occurred");
  });

  it("reports the ErrorType as the detail code", () => {
    const result = handleError(new UnauthorizedError("nope"));
    expect(result.details[0]!.code).toBe(ErrorType.UnauthorizedError);
  });

  it("still returns 500 for a plain Error", () => {
    const result = handleError(new Error("boom"));
    expect(result.status).toBe(500);
    expect(result.type).toBe("InternalServerError");
  });
});
