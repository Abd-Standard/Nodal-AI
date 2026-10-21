/**
 * backend/server.ts
 *
 * Health-check HTTP server for container orchestration (ECS, Kubernetes, etc.).
 *
 * Endpoints:
 *   GET /health  → 200 { status: "ok", components: { horizon, soroban, database } }
 *                  503 { status: "degraded", components: { ... } } when a dependency is down
 *   GET /status  → 200 { results: PersistedResult[] }   (paginated via ?limit=&offset=,
 *                  default last 10; Bearer auth when ADMIN_API_TOKEN is set)
 *   GET /spending → 200 { total, limit, windowMs, percentUsed } (Bearer auth)
 *   GET /metrics → Prometheus text exposition (Bearer auth)
 *   GET /approvals → 200 { approvals: PendingApproval[] } (Bearer auth)
 *   POST /approvals/:id { "decision": "approve" | "deny" } → 200 { approval, result? } (Bearer auth)
 *   GET /stream → SSE stream for real-time dashboard updates (Bearer auth)
 *   POST /admin/pause → 200 { paused: true } halt value-moving tasks (Bearer auth)
 *   POST /admin/resume → 200 { paused: false } resume them (Bearer auth)
 *
 * ADMIN_API_TOKEN is the API bearer token. WEBHOOK_SECRET is still accepted in
 * its place when ADMIN_API_TOKEN is unset, but that fallback is deprecated.
 *
 * Uses only the Node.js built-in `http` module — no additional dependencies.
 * Port is read from config.HEALTH_PORT (env var HEALTH_PORT, default 3000).
 */

import * as http from 'http';
import { createHash, timingSafeEqual } from 'crypto';
import { config } from './config';
import { getResults } from './persistence';
import { horizonServer, sorobanServer } from './rpc_client';
import { db } from './db/client';
import { handleError } from './middleware/error_handler';
import { createLogger } from './utils/logger';
import { spendingTracker, type PayFiAgent } from './agent';
import { llmUsage } from './ai/llm';
import { metricsRegistry, renderMetrics, spendingWindowTotal } from './metrics';
import { pauseAgent, resumeAgent, isPaused } from './kill_switch';

const log = createLogger('health-server');

// ─── Health types & component probes ─────────────────────────────────────────

/** Reachability of a single dependency. */
export type ComponentStatus = 'up' | 'down';

export interface HealthResponse {
  status: 'ok' | 'degraded';
  components: {
    horizon: ComponentStatus;
    soroban: ComponentStatus;
    database: ComponentStatus;
  };
}

/**
 * Bound on a single probe.
 *
 * Without it an unreachable endpoint hangs until the socket's own timeout,
 * and an orchestrator's liveness probe times out first — reporting the agent
 * as dead rather than degraded, which triggers a restart instead of a
 * failover.
 */
const PROBE_TIMEOUT_MS = 3_000;

async function withTimeout<T>(work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('probe timed out')), PROBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Probe Horizon. */
export async function checkHorizon(): Promise<ComponentStatus> {
  try {
    await withTimeout(horizonServer.fetchBaseFee());
    return 'up';
  } catch (err) {
    log.warn({ msg: 'Horizon health probe failed', err: String(err) });
    return 'down';
  }
}

/**
 * Probe Soroban RPC (#233).
 *
 * Previously unchecked, so an agent whose Soroban RPC was down still reported
 * `status: "ok"` — while every `soroban_invoke` and `soroban_query` task
 * failed. Horizon being reachable says nothing about Soroban; they are
 * separate services on separate hosts.
 */
export async function checkSoroban(): Promise<ComponentStatus> {
  try {
    await withTimeout(sorobanServer.getNetwork());
    return 'up';
  } catch (err) {
    log.warn({ msg: 'Soroban RPC health probe failed', err: String(err) });
    return 'down';
  }
}

export async function checkDatabase(): Promise<ComponentStatus> {
  try {
    return (await withTimeout(db.healthCheck())) ? 'up' : 'down';
  } catch (err) {
    log.warn({ msg: 'Database health probe failed', err: String(err) });
    return 'down';
  }
}

// ─── Auth helper ──────────────────────────────────────────────────────────────

/**
 * The bearer token the HTTP API accepts: ADMIN_API_TOKEN, falling back to the
 * deprecated WEBHOOK_SECRET so existing deployments keep working. Read per
 * request so a rotated value takes effect without re-importing the module.
 */
function apiToken(): string | undefined {
  return process.env.ADMIN_API_TOKEN || process.env.WEBHOOK_SECRET || undefined;
}

/**
 * Constant-time token comparison. Both sides are hashed first so the buffers
 * handed to timingSafeEqual are always the same length, and the comparison
 * leaks neither the token's contents nor its length.
 */
function tokensMatch(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/**
 * Returns true if the request passes Bearer-token authentication.
 * When no API token is configured, requests are allowed on testnet/futurenet
 * only; on mainnet they are always rejected.
 * Also checks for token in URL query parameter (for SSE support).
 */
function isAuthenticated(req: http.IncomingMessage): boolean {
  const secret = apiToken();
  if (!secret) return config.STELLAR_NETWORK !== 'mainnet';
  
  // Check Authorization header first
  const auth = req.headers['authorization'];
  if (auth) {
    const [scheme, token] = auth.split(' ');
    if (scheme?.toLowerCase() === 'bearer' && token !== undefined && tokensMatch(token, secret)) {
      return true;
    }
  }
  
  // Check URL query parameter (for SSE, which doesn't support custom headers)
  const url = req.url;
  if (url) {
    try {
      const parsed = new URL(url, `http://${req.headers.host ?? 'localhost'}`);
      const token = parsed.searchParams.get('token');
      if (token && tokensMatch(token, secret)) {
        return true;
      }
    } catch {
      // Invalid URL, continue to return false
    }
  }
  
  return false;
}

const HEALTH_PATH = '/health';
const STATUS_PATH = '/status';
const SPENDING_PATH = '/spending';
const METRICS_PATH = '/metrics';
const APPROVALS_PATH = '/approvals';
const STREAM_PATH = '/stream';
const ADMIN_PAUSE_PATH = '/admin/pause';
const ADMIN_RESUME_PATH = '/admin/resume';

/**
 * Creates and returns the health-check HTTP server.
 * Does NOT call `.listen()` — the caller (typically `index.ts`) is responsible
 * for binding to `config.HEALTH_PORT`. The approval routes need `agent`; they
 * answer 503 without one.
 */
export function createHealthServer(agent?: PayFiAgent): http.Server {
  const server = http.createServer((req, res) => {
    // ── GET /health ────────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === HEALTH_PATH) {
      // Delegate to the real implementation: it probes Horizon, Soroban and
      // the database concurrently and reports 503 / "degraded" when any
      // dependency is down. The previous inline branch hardcoded
      // `status: "ok"` and never checked anything.
      void handleHealth(req, res);
      return;
    }

    // ── GET /status ────────────────────────────────────────────────────────
    // Delegates to handleResults(), which enforces Bearer-token auth when
    // ADMIN_API_TOKEN is set and honours `limit`/`offset` query parameters.
    // The previous inline branch served persisted results with no auth guard
    // and a hardcoded `getResults(10)`.
    if (req.method === 'GET' && req.url?.split('?')[0] === STATUS_PATH) {
      const parsedUrl = new URL(
        req.url ?? STATUS_PATH,
        `http://${req.headers.host ?? 'localhost'}`
      );
      void handleResults(req, res, parsedUrl);
      return;
    }

    // ── GET /spending ──────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === SPENDING_PATH) {
      if (!isAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      const total = spendingTracker.total();
      const limit = parseFloat(config.AGENT_SPENDING_LIMIT);
      const body = JSON.stringify({
        total,
        limit,
        windowMs: config.SPENDING_WINDOW_MS,
        percentUsed: (total / limit) * 100,
      });

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    // ── GET /metrics ───────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === METRICS_PATH) {
      if (!isStrictlyAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      // Prometheus scrapers send `text/plain` / OpenMetrics Accept headers;
      // only an explicit JSON request gets the legacy JSON snapshot.
      if (!req.headers['accept']?.includes('application/json')) {
        void handlePrometheusMetrics(res);
        return;
      }

      const llmMetrics = llmUsage.getMetrics();
      const spendingStatus = spendingTracker.getWindowStatus();

      const body = JSON.stringify({
        llm: llmMetrics,
        spending: {
          ...spendingStatus,
          limit: parseFloat(config.AGENT_SPENDING_LIMIT),
          percentUsed:
            spendingStatus.total > 0
              ? (spendingStatus.total / parseFloat(config.AGENT_SPENDING_LIMIT)) * 100
              : 0,
        },
      });

      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    // ── GET /approvals ─────────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === APPROVALS_PATH) {
      if (!isAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      if (!agent) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Agent not available' }));
        return;
      }

      const body = JSON.stringify({ approvals: agent.listApprovals() });
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    // ── POST /approvals/:id ────────────────────────────────────────────────
    if (req.method === 'POST' && req.url?.startsWith(`${APPROVALS_PATH}/`)) {
      const id = decodeURIComponent(req.url.slice(APPROVALS_PATH.length + 1));
      void handleApprovalDecision(req, res, agent, id);
      return;
    }

    // ── GET /stream ────────────────────────────────────────────────────────
    // SSE stream for real-time dashboard updates
    if (req.method === 'GET' && req.url === STREAM_PATH) {
      if (!isAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      void handleStream(req, res, agent);
      return;
    }

    // ── POST /admin/pause ──────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === ADMIN_PAUSE_PATH) {
      if (!isAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      pauseAgent('Paused via HTTP API');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ paused: true }));
      return;
    }

    // ── POST /admin/resume ─────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === ADMIN_RESUME_PATH) {
      if (!isAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      resumeAgent('Resumed via HTTP API');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ paused: false }));
      return;
    }

    // ── 404 for everything else ────────────────────────────────────────────
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  return server;
}

/**
 * Convenience: create the server and immediately start listening.
 * Returns the bound server instance.
 */
export function startHealthServer(agent?: PayFiAgent): http.Server {
  const server = createHealthServer(agent);
  const port = config.HEALTH_PORT;

  server.listen(port, () => {
    process.stdout.write(`✅ [HealthServer] Listening on port ${port}\n`);
    process.stdout.write(
      `   GET /health → { status, components }\n` +
        `   GET /status → { results: AgentResult[] }\n` +
        `   GET /metrics → Prometheus text exposition (Bearer auth)\n`
    );
  });

  return server;
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  try {
    // Probed concurrently: run serially and a slow Horizon delays the Soroban
    // answer, so the endpoint's latency becomes the sum of every dependency.
    const [horizon, soroban, database] = await Promise.all([
      checkHorizon(),
      checkSoroban(),
      checkDatabase(),
    ]);

    const allUp = horizon === 'up' && soroban === 'up' && database === 'up';
    const statusCode = allUp ? 200 : 503;
    const body: HealthResponse = {
      status: allUp ? 'ok' : 'degraded',
      components: { horizon, soroban, database },
    };

    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
  } catch (err) {
    const errorResponse = handleError(err);
    log.error({
      msg: 'Unhandled request error',
      status: errorResponse.status,
      type: errorResponse.type,
    });
    const body = JSON.stringify(errorResponse);
    res.writeHead(errorResponse.status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...errorResponse.headers,
    });
    res.end(body);
  }
}

/** GET /metrics — Prometheus text exposition of the nodal_* metrics. */
async function handlePrometheusMetrics(res: http.ServerResponse): Promise<void> {
  try {
    // Gauges derived from live state are refreshed at scrape time rather than
    // on every mutation, so the value is never staler than the scrape itself.
    spendingWindowTotal.set({ asset: config.X402_ASSET_CODE }, spendingTracker.total());

    const body = await renderMetrics();
    res.writeHead(200, {
      'Content-Type': metricsRegistry.contentType,
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  } catch (err) {
    const errorResponse = handleError(err);
    log.error({
      msg: 'Failed to render Prometheus metrics',
      status: errorResponse.status,
      type: errorResponse.type,
    });
    const body = JSON.stringify(errorResponse);
    res.writeHead(errorResponse.status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...errorResponse.headers,
    });
    res.end(body);
  }
}

const DEFAULT_RESULTS_LIMIT = 10;
const MAX_RESULTS_LIMIT = 100;

/** Parses a non-negative integer query parameter, falling back when absent or invalid. */
function parseNonNegativeInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * GET /status — paginated persisted AgentResult records, newest first.
 * Requires a matching Bearer token when ADMIN_API_TOKEN is set.
 * Query parameters: `limit` (default 10, max 100) and `offset` (default 0).
 */
function handleResults(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  if (!isAuthenticated(req)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  try {
    const limit = Math.min(
      parseNonNegativeInt(url.searchParams.get('limit'), DEFAULT_RESULTS_LIMIT),
      MAX_RESULTS_LIMIT
    );
    const offset = parseNonNegativeInt(url.searchParams.get('offset'), 0);
    const body = JSON.stringify({ results: getResults(limit, offset) });

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  } catch (err) {
    // Route through the shared handler so a StructuredError gets the status
    // code that describes it instead of a blanket 500 - and so an internal
    // fault's message is not echoed to the caller.
    const errorResponse = handleError(err);
    log.error({
      msg: 'Failed to read persisted results',
      status: errorResponse.status,
      type: errorResponse.type,
    });
    const body = JSON.stringify({ error: 'Failed to read results', ...errorResponse });
    res.writeHead(errorResponse.status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      ...errorResponse.headers,
    });
    res.end(body);
  }
}

/** Reads and JSON-parses a request body; an empty body parses to `{}`. */
function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

/**
 * POST /approvals/:id — approve (execute once) or deny a pending task (#736).
 * Moves money, so a Bearer token is always required — even on testnet.
 */
async function handleApprovalDecision(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  agent: PayFiAgent | undefined,
  id: string
): Promise<void> {
  const send = (status: number, payload: unknown): void => {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    });
    res.end(body);
  };

  if (!apiToken() || !isAuthenticated(req)) {
    send(401, { error: 'Unauthorized' });
    return;
  }
  if (!agent) {
    send(503, { error: 'Agent not available' });
    return;
  }

  let decision: unknown;
  try {
    decision = ((await readJsonBody(req)) as { decision?: unknown } | null)?.decision;
  } catch {
    send(400, { error: 'Request body must be JSON' });
    return;
  }
  if (decision !== 'approve' && decision !== 'deny') {
    send(400, { error: 'decision must be "approve" or "deny"' });
    return;
  }

  try {
    if (decision === 'approve') {
      const outcome = await agent.approve(id);
      if (!outcome) send(404, { error: 'Approval not found' });
      else send(200, outcome);
    } else {
      const approval = agent.deny(id);
      if (!approval) send(404, { error: 'Approval not found' });
      else send(200, { approval });
    }
  } catch (err) {
    const errorResponse = handleError(err);
    log.error({
      msg: 'Failed to process approval decision',
      status: errorResponse.status,
      type: errorResponse.type,
    });
    send(errorResponse.status, errorResponse);
  }
}

/**
 * GET /stream — SSE stream for real-time dashboard updates.
 * Emits events for: task results, spending changes, approval status, and agent pause/resume.
 */
function handleStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  agent: PayFiAgent | undefined
): void {
  // SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  // Helper to send SSE events
  const sendEvent = (event: string, data: unknown): void => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Send initial state
  try {
    const spendingStatus = spendingTracker.getWindowStatus();
    const approvals = agent?.listApprovals() ?? [];
    const paused = isPaused();

    sendEvent('initial', {
      spending: {
        ...spendingStatus,
        limit: parseFloat(config.AGENT_SPENDING_LIMIT),
        percentUsed:
          spendingStatus.total > 0
            ? (spendingStatus.total / parseFloat(config.AGENT_SPENDING_LIMIT)) * 100
            : 0,
      },
      approvals,
      paused,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    log.error({ msg: 'Failed to send initial SSE state', err: String(err) });
  }

  // Set up polling for updates (simple approach without event emitter changes)
  const POLL_INTERVAL_MS = 2000;
  let lastSpendingTotal = spendingTracker.total();
  let lastApprovalCount = agent?.listApprovals().length ?? 0;
  let lastPausedState = isPaused();

  const interval = setInterval(() => {
    try {
      // Check for spending changes
      const currentSpendingTotal = spendingTracker.total();
      if (currentSpendingTotal !== lastSpendingTotal) {
        lastSpendingTotal = currentSpendingTotal;
        const spendingStatus = spendingTracker.getWindowStatus();
        sendEvent('spending', {
          ...spendingStatus,
          limit: parseFloat(config.AGENT_SPENDING_LIMIT),
          percentUsed:
            spendingStatus.total > 0
              ? (spendingStatus.total / parseFloat(config.AGENT_SPENDING_LIMIT)) * 100
              : 0,
          timestamp: new Date().toISOString(),
        });
      }

      // Check for approval changes
      if (agent) {
        const currentApprovals = agent.listApprovals();
        if (currentApprovals.length !== lastApprovalCount) {
          lastApprovalCount = currentApprovals.length;
          sendEvent('approvals', {
            approvals: currentApprovals,
            timestamp: new Date().toISOString(),
          });
        }
      }

      // Check for pause/resume changes
      const currentPaused = isPaused();
      if (currentPaused !== lastPausedState) {
        lastPausedState = currentPaused;
        sendEvent('pause', {
          paused: currentPaused,
          timestamp: new Date().toISOString(),
        });
      }

      // Send periodic heartbeat
      sendEvent('heartbeat', { timestamp: new Date().toISOString() });
    } catch (err) {
      log.error({ msg: 'SSE polling error', err: String(err) });
    }
  }, POLL_INTERVAL_MS);

  // Clean up on client disconnect
  req.on('close', () => {
    clearInterval(interval);
    log.info('SSE client disconnected');
  });
}
