/**
 * tests/telemetry.test.ts
 *
 * Closes #454 — withSpan() had no test coverage confirming it actually
 * creates spans with the right name/attributes, or that nested calls relate
 * correctly. Uses the OTel in-memory span exporter so spans are asserted
 * directly rather than inferred from mocked SDK calls.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";

// telemetry.ts imports config at module load, and loadConfig() calls
// process.exit(1) when required env vars are absent — so importing the
// module under test would kill the run before a single assertion. withSpan()
// only reads config.OTLP_ENDPOINT (and only inside initTelemetry(), which
// these tests never call), so an otherwise-empty mock is enough.
vi.mock("../backend/config", () => ({
  config: {
    HORIZON_URL: "https://horizon-testnet.stellar.org",
    SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
    STELLAR_NETWORK: "testnet",
  },
}));

import { withSpan } from "../backend/telemetry";

// `trace.getTracer()` (called once at module load inside telemetry.ts) returns
// a ProxyTracer that delegates to whatever provider is *currently* registered
// globally at call time — so registering the in-memory provider here, after
// telemetry.ts has already been imported, still lets us capture its spans.
let exporter: InMemorySpanExporter;

beforeAll(() => {
  exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
});

beforeEach(() => {
  exporter.reset();
});

describe("withSpan", () => {
  it("creates a span named after the given operation", async () => {
    await withSpan("myOp", async () => "result");

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("myOp");
  });

  it("returns the wrapped function's result and marks the span OK", async () => {
    const result = await withSpan("myOp", async () => 42);

    expect(result).toBe(42);
    const [span] = exporter.getFinishedSpans();
    expect(span!.status.code).toBe(1); // SpanStatusCode.OK
  });

  it("records an exception and ERROR status when the wrapped function throws", async () => {
    await expect(
      withSpan("failingOp", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");

    const [span] = exporter.getFinishedSpans();
    expect(span!.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span!.status.message).toBe("boom");
  });

  it("applies custom attributes passed as the third argument", async () => {
    await withSpan("myOp", async () => "result", {
      "http.method": "GET",
      "retry.count": 3,
      cached: true,
    });

    const [span] = exporter.getFinishedSpans();
    expect(span!.attributes["http.method"]).toBe("GET");
    expect(span!.attributes["retry.count"]).toBe(3);
    expect(span!.attributes.cached).toBe(true);
  });

  it("creates no attributes when none are passed", async () => {
    await withSpan("myOp", async () => "result");

    const [span] = exporter.getFinishedSpans();
    expect(Object.keys(span!.attributes)).toHaveLength(0);
  });

  // NOTE: withSpan() currently calls `tracer.startSpan(name)` without ever
  // entering the started span's context (no `context.with(trace.setSpan(...))`
  // / no `startActiveSpan`). That means nested withSpan() calls do NOT
  // currently pick up the outer span as their parent — each becomes its own
  // root span. This test documents that actual, current behaviour; it is not
  // asserting this is desirable. See PR description for a flagged follow-up.
  it("does not currently link nested calls as parent/child (documents existing gap)", async () => {
    await withSpan("outer", async () => {
      await withSpan("inner", async () => "done");
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);

    const outer = spans.find((s) => s.name === "outer")!;
    const inner = spans.find((s) => s.name === "inner")!;

    expect(outer.parentSpanContext).toBeUndefined();
    expect(inner.parentSpanContext).toBeUndefined();
    expect(inner.spanContext().traceId).not.toBe(outer.spanContext().traceId);
  });
});
