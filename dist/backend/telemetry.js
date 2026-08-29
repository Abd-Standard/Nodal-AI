"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.initTelemetry = initTelemetry;
exports.getTracer = getTracer;
exports.withSpan = withSpan;
exports.shutdownTelemetry = shutdownTelemetry;
const sdk_node_1 = require("@opentelemetry/sdk-node");
const exporter_trace_otlp_http_1 = require("@opentelemetry/exporter-trace-otlp-http");
const exporter_metrics_otlp_http_1 = require("@opentelemetry/exporter-metrics-otlp-http");
const sdk_metrics_1 = require("@opentelemetry/sdk-metrics");
const api_1 = require("@opentelemetry/api");
const config_1 = require("./config");
const logger_1 = require("./utils/logger");
const log = (0, logger_1.createLogger)("telemetry");
let tracer = api_1.trace.getTracer("stellar-agent-kit");
let sdk = null;
/**
 * Initialise the OpenTelemetry SDK with OTLP HTTP exporters if
 * config.OTLP_ENDPOINT is defined.  Idempotent — subsequent calls
 * are no-ops.
 */
function initTelemetry() {
    const otlpEndpoint = config_1.config.OTLP_ENDPOINT;
    if (!otlpEndpoint) {
        log.info("OTLP_ENDPOINT not configured, skipping OpenTelemetry initialisation");
        return;
    }
    if (sdk) {
        log.warn("initTelemetry called but SDK is already running");
        return;
    }
    const traceExporter = new exporter_trace_otlp_http_1.OTLPTraceExporter({
        url: `${otlpEndpoint}/v1/traces`,
    });
    const metricReader = new sdk_metrics_1.PeriodicExportingMetricReader({
        exporter: new exporter_metrics_otlp_http_1.OTLPMetricExporter({
            url: `${otlpEndpoint}/v1/metrics`,
        }),
        exportIntervalMillis: 10_000,
    });
    sdk = new sdk_node_1.NodeSDK({
        traceExporter,
        metricReaders: [metricReader],
        serviceName: "stellar-agent-kit",
    });
    sdk.start();
    log.info({ endpoint: otlpEndpoint }, "OpenTelemetry initialised");
}
/**
 * Return the active tracer (no-op tracer when telemetry is disabled).
 */
function getTracer() {
    return tracer;
}
/**
 * Create a trace span wrapping an async operation.
 *
 * @param name      - The span name (e.g. "withRetry")
 * @param fn        - The async function to instrument
 * @param attrs     - Optional key-value attributes to set on the span
 * @returns         - The return value of `fn`
 */
async function withSpan(name, fn, attrs = {}) {
    const span = tracer.startSpan(name);
    try {
        for (const [key, value] of Object.entries(attrs)) {
            span.setAttribute(key, value);
        }
        const result = await fn();
        span.setStatus({ code: api_1.SpanStatusCode.OK });
        return result;
    }
    catch (err) {
        span.setStatus({
            code: api_1.SpanStatusCode.ERROR,
            message: err instanceof Error ? err.message : String(err),
        });
        span.recordException(err instanceof Error ? err : new Error(String(err)));
        throw err;
    }
    finally {
        span.end();
    }
}
/**
 * Gracefully shut down telemetry, flushing pending spans.
 * Safe to call even when telemetry was never initialised.
 */
async function shutdownTelemetry() {
    if (sdk) {
        await sdk.shutdown();
        sdk = null;
        log.info("OpenTelemetry shut down");
    }
}
//# sourceMappingURL=telemetry.js.map