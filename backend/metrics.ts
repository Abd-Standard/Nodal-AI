/**
 * backend/metrics.ts
 *
 * Prometheus metrics, served in text exposition format by GET /metrics on the
 * health server (backend/server.ts).
 *
 * Metrics live on a dedicated registry rather than prom-client's global one so
 * that importing this module twice (tests, hot reload) never throws a
 * "metric already registered" error and so only Nodal metrics are exposed.
 *
 *   nodal_tasks_total{type,status}        counter   tasks finished, by outcome
 *   nodal_task_duration_seconds{type}     histogram wall-clock task latency
 *   nodal_spending_window_total{asset}    gauge     spend inside the rolling window
 *   nodal_queue_depth                     gauge     tasks waiting for a slot
 *   nodal_rpc_breaker_state{circuit}      gauge     0 closed, 1 half-open, 2 open
 *   nodal_webhook_failures_total          counter   webhooks that were never delivered
 */

import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export const metricsRegistry = new Registry();

collectDefaultMetrics({ register: metricsRegistry, prefix: 'nodal_process_' });

export type TaskStatus = 'success' | 'failure' | 'rejected';

export const tasksTotal = new Counter<'type' | 'status'>({
  name: 'nodal_tasks_total',
  help: 'Agent tasks processed, labelled by task type and outcome',
  labelNames: ['type', 'status'],
  registers: [metricsRegistry],
});

export const taskDurationSeconds = new Histogram<'type'>({
  name: 'nodal_task_duration_seconds',
  help: 'Wall-clock duration of agent task execution in seconds',
  labelNames: ['type'],
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [metricsRegistry],
});

export const spendingWindowTotal = new Gauge<'asset'>({
  name: 'nodal_spending_window_total',
  help: 'Cumulative amount spent inside the rolling spending window',
  labelNames: ['asset'],
  registers: [metricsRegistry],
});

export const queueDepth = new Gauge({
  name: 'nodal_queue_depth',
  help: 'Tasks queued waiting for a free concurrency slot',
  registers: [metricsRegistry],
});

/** Numeric encoding of an opossum circuit state for nodal_rpc_breaker_state. */
export const BREAKER_STATE = {
  closed: 0,
  halfOpen: 1,
  open: 2,
} as const;

export const rpcBreakerState = new Gauge<'circuit'>({
  name: 'nodal_rpc_breaker_state',
  help: 'RPC circuit breaker state: 0 = closed, 1 = half-open, 2 = open',
  labelNames: ['circuit'],
  registers: [metricsRegistry],
});

export const webhookFailuresTotal = new Counter({
  name: 'nodal_webhook_failures_total',
  help: 'Webhook deliveries abandoned after a non-retryable error or exhausted retries',
  registers: [metricsRegistry],
});

/** Record a finished task's outcome and, when known, its duration. */
export function recordTask(type: string, status: TaskStatus, durationSeconds?: number): void {
  tasksTotal.inc({ type, status });
  if (durationSeconds !== undefined) {
    taskDurationSeconds.observe({ type }, durationSeconds);
  }
}

/** Render every registered metric in Prometheus text exposition format. */
export function renderMetrics(): Promise<string> {
  return metricsRegistry.metrics();
}
