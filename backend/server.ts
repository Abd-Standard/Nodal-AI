/**
 * backend/server.ts
 *
 * Health-check HTTP server for container orchestration (ECS, Kubernetes, etc.).
 *
 * Endpoints:
 *   GET /health  → 200 { status: "ok", network: string, publicKey: string }
 *   GET /status  → 200 { results: PersistedResult[] }   (last 10 AgentResult records)
 *
 * Uses only the Node.js built-in `http` module — no additional dependencies.
 * Port is read from config.HEALTH_PORT (env var HEALTH_PORT, default 3000).
 */

import * as http from "http";
import { config } from "./config";
import { getResults } from "./persistence";

// ─── Auth helper ──────────────────────────────────────────────────────────────

const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;

/**
 * Returns true if the request passes Bearer-token authentication.
 * When WEBHOOK_SECRET is unset, all requests are allowed.
 */
function isAuthenticated(req: http.IncomingMessage): boolean {
  if (!WEBHOOK_SECRET) return true;
  const auth = req.headers["authorization"];
  if (!auth) return false;
  const [scheme, token] = auth.split(" ");
  return scheme?.toLowerCase() === "bearer" && token === WEBHOOK_SECRET;
}

const HEALTH_PATH = "/health";
const STATUS_PATH = "/status";

/**
 * Creates and returns the health-check HTTP server.
 * Does NOT call `.listen()` — the caller (typically `index.ts`) is responsible
 * for binding to `config.HEALTH_PORT`.
 */
export function createHealthServer(): http.Server {
  const server = http.createServer((req, res) => {
    // ── GET /health ────────────────────────────────────────────────────────
    if (req.method === "GET" && req.url === HEALTH_PATH) {
      const body = JSON.stringify({
        status: "ok",
        network: config.STELLAR_NETWORK,
        publicKey: config.AGENT_PUBLIC_KEY,
      });

      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    // ── GET /status ────────────────────────────────────────────────────────
    if (req.method === "GET" && req.url === STATUS_PATH) {
      try {
        const results = getResults(10);
        const body = JSON.stringify({ results });

        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const body = JSON.stringify({ error: message });

        res.writeHead(500, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        });
        res.end(body);
      }
      return;
    }

    // ── 404 for everything else ────────────────────────────────────────────
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not Found" }));
  });

  return server;
}

/**
 * Convenience: create the server and immediately start listening.
 * Returns the bound server instance.
 */
export function startHealthServer(): http.Server {
  const server = createHealthServer();
  const port = config.HEALTH_PORT;

  server.listen(port, () => {
    process.stdout.write(`✅ [HealthServer] Listening on port ${port}\n`);
    process.stdout.write(
      `   GET /health → { status, network, publicKey }\n` +
      `   GET /status → { results: AgentResult[] }\n`
    );
  });

  return server;
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function handleHealth(
  _req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  try {
    const [rpc, database] = await Promise.all([checkRpc(), checkDatabase()]);

    const allUp = rpc === "up" && database === "up";
    const statusCode = allUp ? 200 : 503;
    const body: HealthResponse = {
      status: allUp ? "ok" : "degraded",
      components: { rpc, database },
    };

    const payload = JSON.stringify(body);
    res.writeHead(statusCode, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  } catch (err) {
    const errorResponse = handleError(err);
    log.error({ msg: "Unhandled request error", status: errorResponse.status, type: errorResponse.type });
    const payload = JSON.stringify(errorResponse);
    res.writeHead(errorResponse.status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }
}

async function handleResults(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsedUrl: URL
): Promise<void> {
  // Auth guard — skipped when WEBHOOK_SECRET is not configured
  if (!isAuthenticated(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  try {
    const limitParam = parsedUrl.searchParams.get("limit");
    const offsetParam = parsedUrl.searchParams.get("offset");

    const limit = limitParam ? Math.max(1, Math.min(1000, parseInt(limitParam, 10) || 100)) : 100;
    const offset = offsetParam ? Math.max(0, parseInt(offsetParam, 10) || 0) : 0;

    const results = getResults(limit, offset);
    const payload = JSON.stringify(results);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  } catch (err) {
    const errorResponse = handleError(err);
    log.error({ msg: "Results endpoint error", status: errorResponse.status, type: errorResponse.type });
    const payload = JSON.stringify(errorResponse);
    res.writeHead(errorResponse.status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }
}
