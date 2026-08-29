/**
 * backend/telemetry.ts
 *
 * Optional OpenTelemetry setup module.
 *
 * Reads config.OTLP_ENDPOINT — if set, initialises an OTLP trace/metric
 * exporter and instruments `withRetry` calls with trace spans.
 *
 * Called once from backend/index.ts at startup.
 */
import { Tracer } from "@opentelemetry/api";
/**
 * Initialise the OpenTelemetry SDK with OTLP HTTP exporters if
 * config.OTLP_ENDPOINT is defined.  Idempotent — subsequent calls
 * are no-ops.
 */
export declare function initTelemetry(): void;
/**
 * Return the active tracer (no-op tracer when telemetry is disabled).
 */
export declare function getTracer(): Tracer;
/**
 * Create a trace span wrapping an async operation.
 *
 * @param name      - The span name (e.g. "withRetry")
 * @param fn        - The async function to instrument
 * @param attrs     - Optional key-value attributes to set on the span
 * @returns         - The return value of `fn`
 */
export declare function withSpan<T>(name: string, fn: () => Promise<T>, attrs?: Record<string, string | number | boolean>): Promise<T>;
/**
 * Gracefully shut down telemetry, flushing pending spans.
 * Safe to call even when telemetry was never initialised.
 */
export declare function shutdownTelemetry(): Promise<void>;
//# sourceMappingURL=telemetry.d.ts.map