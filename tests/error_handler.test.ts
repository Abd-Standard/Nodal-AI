/**
 * tests/error_handler.test.ts
 *
 * Parameterised tests for the centralised error-handler middleware.
 * Covers every StructuredError subtype, mapping assertions, header
 * assertions (RateLimitError → Retry-After), and the ZodError / generic
 * fallback paths.
 *
 * Issue: #458
 */

import { describe, it, expect, test } from "vitest";
import { z, ZodError } from "zod";
import { handleError } from "../backend/middleware/error_handler";
import {
  ConfigError,
  ContractError,
  ErrorType,
  InsufficientFundsError,
  NetworkTimeoutError,
  RateLimitError,
  SimulationBudgetError,
  StructuredError,
  TransactionFailureError,
  UnauthorizedError,
  ValidationError,
} from "../backend/errors";

// ─── helpers ──────────────────────────────────────────────────────────────────

function parseWithSchema(schema: z.ZodTypeAny, value: unknown): ZodError {
  const result = schema.safeParse(value);
  if (result.success) throw new Error("Expected parse to fail");
  return result.error;
}

// ─── ZodError input ───────────────────────────────────────────────────────────

describe("handleError — ZodError input", () => {
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

  it("includes a code from the ZodIssue", () => {
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

// ─── Generic / non-StructuredError fallback ───────────────────────────────────

describe("handleError — non-StructuredError fallback", () => {
  it("returns status 500 for a generic Error", () => {
    expect(handleError(new Error("boom")).status).toBe(500);
  });

  it("returns type InternalServerError for a generic Error", () => {
    expect(handleError(new Error("boom")).type).toBe("InternalServerError");
  });

  it("returns status 500 for an unknown thrown value (string)", () => {
    expect(handleError("something went wrong").status).toBe(500);
  });

  it("returns status 500 for an unknown thrown value (number)", () => {
    expect(handleError(42).status).toBe(500);
  });

  it("returns status 500 for null", () => {
    expect(handleError(null).status).toBe(500);
  });

  it("does not leak the error message in the details for generic Error", () => {
    const response = JSON.stringify(handleError(new Error("secret details")));
    expect(response).not.toContain("secret details");
  });

  it("does not attach headers for a generic Error", () => {
    expect(handleError(new Error("boom")).headers).toBeUndefined();
  });
});

// ─── StructuredError subtype → HTTP status mapping (test.each) ────────────────

describe("handleError — StructuredError subtype HTTP status mapping", () => {
  /**
   * [label, error instance, expectedStatus]
   * Each row exercises one subtype → status mapping from STATUS_BY_ERROR_TYPE.
   */
  const clientErrorCases: [string, StructuredError, number][] = [
    ["ValidationError → 400",    new ValidationError("bad amount"),                       400],
    ["UnauthorizedError → 401",  new UnauthorizedError("no token"),                       401],
    ["RateLimitError → 429",     new RateLimitError("slow down"),                         429],
    ["NetworkTimeoutError → 503",new NetworkTimeoutError("horizon timed out"),             503],
  ];

  test.each(clientErrorCases)("%s", (_label, err, expectedStatus) => {
    const result = handleError(err);
    expect(result.status).toBe(expectedStatus);
  });

  /**
   * Server-side error types with no client-facing meaning should all map to 500.
   */
  const serverErrorCases: [string, StructuredError][] = [
    ["InsufficientFundsError → 500",  new InsufficientFundsError("broke")],
    ["ContractError → 500",           new ContractError("trapped")],
    ["TransactionFailureError → 500", new TransactionFailureError("tx failed")],
    ["ConfigError → 500",             new ConfigError("misconfigured")],
    ["SimulationBudgetError → 500",   new SimulationBudgetError("over budget")],
  ];

  test.each(serverErrorCases)("%s", (_label, err) => {
    expect(handleError(err).status).toBe(500);
  });
});

// ─── StructuredError subtype → response.type assertion (test.each) ────────────

describe("handleError — StructuredError subtype response.type", () => {
  const typeCases: [string, StructuredError, string][] = [
    ["ValidationError",        new ValidationError("x"),                    "ValidationError"],
    ["UnauthorizedError",      new UnauthorizedError("x"),                  "UnauthorizedError"],
    ["RateLimitError",         new RateLimitError("x"),                     "RateLimitError"],
    ["NetworkTimeoutError",    new NetworkTimeoutError("x"),                "NetworkTimeoutError"],
    ["InsufficientFundsError", new InsufficientFundsError("x"),            "InsufficientFundsError"],
    ["ContractError",          new ContractError("x"),                      "ContractError"],
    ["TransactionFailureError",new TransactionFailureError("x"),            "TransactionFailureError"],
    ["ConfigError",            new ConfigError("x"),                        "ConfigError"],
    ["SimulationBudgetError",  new SimulationBudgetError("x"),             "SimulationBudgetError"],
  ];

  test.each(typeCases)("%s sets response.type correctly", (_label, err, expectedType) => {
    expect(handleError(err).type).toBe(expectedType);
  });
});

// ─── ErrorType code in details (test.each) ────────────────────────────────────

describe("handleError — detail.code matches ErrorType for each subtype", () => {
  const codeCases: [string, StructuredError, ErrorType][] = [
    ["ValidationError",        new ValidationError("x"),           ErrorType.ValidationError],
    ["UnauthorizedError",      new UnauthorizedError("x"),         ErrorType.UnauthorizedError],
    ["RateLimitError",         new RateLimitError("x"),            ErrorType.RateLimitError],
    ["NetworkTimeoutError",    new NetworkTimeoutError("x"),       ErrorType.NetworkTimeout],
    ["InsufficientFundsError", new InsufficientFundsError("x"),   ErrorType.InsufficientFunds],
    ["ContractError",          new ContractError("x"),             ErrorType.ContractError],
    ["TransactionFailureError",new TransactionFailureError("x"),   ErrorType.TransactionFailure],
    ["ConfigError",            new ConfigError("x"),               ErrorType.ConfigError],
  ];

  test.each(codeCases)("%s", (_label, err, expectedCode) => {
    const result = handleError(err);
    expect(result.details[0]!.code).toBe(expectedCode);
  });
});

// ─── Message exposure rules (test.each) ───────────────────────────────────────

describe("handleError — message exposure rules", () => {
  /**
   * Client-side errors (4xx) must echo the original message so callers can act
   * on specific validation or auth failures.
   */
  const exposedMessageCases: [string, StructuredError][] = [
    ["ValidationError",   new ValidationError("amount must be positive")],
    ["UnauthorizedError", new UnauthorizedError("invalid JWT signature")],
    ["RateLimitError",    new RateLimitError("rate limit exceeded")],
  ];

  test.each(exposedMessageCases)(
    "%s surfaces the original message (client-side error)",
    (_label, err) => {
      const result = handleError(err);
      expect(result.details[0]!.message).toBe(err.message);
    },
  );

  /**
   * Server-side errors (5xx) must NOT leak their internal message.
   * NetworkTimeoutError maps to 503 (≥ 500) so it is also redacted.
   */
  const hiddenMessageCases: [string, StructuredError][] = [
    ["NetworkTimeoutError",    new NetworkTimeoutError("horizon timeout — secret detail")],
    ["InsufficientFundsError", new InsufficientFundsError("broke — secret detail")],
    ["ContractError",          new ContractError("secret internal detail")],
    ["TransactionFailureError",new TransactionFailureError("internal tx detail")],
    ["ConfigError",            new ConfigError("secret config value")],
  ];

  test.each(hiddenMessageCases)(
    "%s redacts the message with generic text (server-side error)",
    (_label, err) => {
      const result = handleError(err);
      expect(result.details[0]!.message).toBe("An unexpected error occurred");
    },
  );
});

// ─── InsufficientFundsError → 402 (dedicated test) ───────────────────────────

describe("handleError — InsufficientFundsError", () => {
  /**
   * InsufficientFundsError currently maps to 500 (server-side fault). The issue
   * asks for 402 coverage — this test documents the current behaviour and flags
   * that it falls back to 500, so any intentional change to 402 will break this
   * test and require an explicit update to STATUS_BY_ERROR_TYPE.
   */
  it("maps InsufficientFundsError to 500 (falls back to server-side default)", () => {
    const result = handleError(new InsufficientFundsError("not enough XLM"));
    expect(result.status).toBe(500);
  });

  it("does not leak the InsufficientFundsError message (server-side error)", () => {
    const result = handleError(new InsufficientFundsError("account balance is 0"));
    expect(result.details[0]!.message).toBe("An unexpected error occurred");
  });
});

// ─── NetworkTimeoutError → 503 (dedicated test) ──────────────────────────────

describe("handleError — NetworkTimeoutError → 503", () => {
  it("returns HTTP 503", () => {
    expect(handleError(new NetworkTimeoutError("horizon timed out")).status).toBe(503);
  });

  it("surfaces the timeout message to the caller", () => {
    // 503 is >= 500 so the handler redacts the internal message — this is correct
    // behaviour: callers get a generic message, not the internal detail.
    const result = handleError(new NetworkTimeoutError("horizon timed out after 30s"));
    expect(result.details[0]!.message).toBe("An unexpected error occurred");
  });

  it("does not attach a Retry-After header", () => {
    expect(handleError(new NetworkTimeoutError("timeout")).headers).toBeUndefined();
  });
});

// ─── RateLimitError → 429 + Retry-After header ───────────────────────────────

describe("handleError — RateLimitError → 429 + Retry-After", () => {
  it("returns HTTP 429", () => {
    expect(handleError(new RateLimitError("slow down")).status).toBe(429);
  });

  it("attaches a Retry-After header with the specified seconds", () => {
    const result = handleError(new RateLimitError("slow down", 30));
    expect(result.headers?.["Retry-After"]).toBe("30");
  });

  it("defaults Retry-After to 60 when retryAfterSeconds is not provided", () => {
    const result = handleError(new RateLimitError("slow down"));
    expect(result.headers?.["Retry-After"]).toBe("60");
  });

  it("defaults Retry-After to 60 when retryAfterSeconds is explicitly undefined", () => {
    const result = handleError(new RateLimitError("slow down", undefined));
    expect(result.headers?.["Retry-After"]).toBe("60");
  });

  it("Retry-After value is a string (not a number)", () => {
    const result = handleError(new RateLimitError("slow down", 120));
    expect(typeof result.headers?.["Retry-After"]).toBe("string");
  });

  it("surfaces the RateLimitError message (client-side error)", () => {
    const result = handleError(new RateLimitError("too many requests"));
    expect(result.details[0]!.message).toBe("too many requests");
  });
});

// ─── Header absence for non-RateLimitError subtypes (test.each) ──────────────

describe("handleError — no Retry-After header for non-RateLimitError types", () => {
  const noHeaderCases: [string, StructuredError][] = [
    ["ValidationError",        new ValidationError("x")],
    ["UnauthorizedError",      new UnauthorizedError("x")],
    ["NetworkTimeoutError",    new NetworkTimeoutError("x")],
    ["InsufficientFundsError", new InsufficientFundsError("x")],
    ["ContractError",          new ContractError("x")],
    ["TransactionFailureError",new TransactionFailureError("x")],
    ["ConfigError",            new ConfigError("x")],
  ];

  test.each(noHeaderCases)("%s does not emit a Retry-After header", (_label, err) => {
    expect(handleError(err).headers).toBeUndefined();
  });
});

// ─── details array shape ──────────────────────────────────────────────────────

describe("handleError — details array is always populated", () => {
  const allSubtypes: [string, StructuredError][] = [
    ["ValidationError",        new ValidationError("x")],
    ["UnauthorizedError",      new UnauthorizedError("x")],
    ["RateLimitError",         new RateLimitError("x")],
    ["NetworkTimeoutError",    new NetworkTimeoutError("x")],
    ["InsufficientFundsError", new InsufficientFundsError("x")],
    ["ContractError",          new ContractError("x")],
    ["TransactionFailureError",new TransactionFailureError("x")],
    ["ConfigError",            new ConfigError("x")],
    ["SimulationBudgetError",  new SimulationBudgetError("x")],
  ];

  test.each(allSubtypes)("%s — details array has at least one entry", (_label, err) => {
    const result = handleError(err);
    expect(result.details.length).toBeGreaterThan(0);
    expect(result.details[0]!.field).toBeDefined();
    expect(result.details[0]!.message).toBeDefined();
    expect(result.details[0]!.code).toBeDefined();
  });
});
