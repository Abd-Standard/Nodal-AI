/**
 * backend/server.ts
 * HTTP server for container orchestration (Kubernetes, Docker Swarm).
 *
 * Endpoints:
 *   GET /health            — 200 when all dependencies are up, 503 otherwise
 *   GET /results?limit=N&offset=M — paginated audit log (JSON); optional Bearer auth
 */

import * as http from "http";
import { URL } from "url";
import { horizonServer } from "./rpc_client";
import { db } from "./db/client";
import { getResults } from "./persistence";
import { createLogger } from "./utils/logger";
import { handleError } from "./middleware/error_handler";

const log = createLogger("health-server");

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
const RESULTS_PATH = "/results";

type ComponentStatus = "up" | "down";

interface HealthResponse {
  status: "ok" | "degraded";
  components: {
    rpc: ComponentStatus;
    database: ComponentStatus;
  };
}

async function checkRpc(): Promise<ComponentStatus> {
  try {
    await horizonServer.fetchBaseFee();
    return "up";
  } catch {
    return "down";
  }
}

async function checkDatabase(): Promise<ComponentStatus> {
  try {
    const ok = await db.healthCheck();
    return ok ? "up" : "down";
  } catch {
    return "down";
  }
}

export function createHealthServer(port = 3001): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }

    // ── Routing ────────────────────────────────────────────────────────────
    const parsedUrl = req.url ? new URL(req.url, `http://${req.headers.host ?? "localhost"}`) : null;
    const pathname = parsedUrl?.pathname ?? "";

    if (pathname === HEALTH_PATH) {
      return handleHealth(req, res);
    }

    if (pathname === RESULTS_PATH) {
      return handleResults(req, res, parsedUrl!);
    }

    // Unknown route
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  server.listen(port, () => {
    log.info({ msg: "HTTP server listening", port, paths: [HEALTH_PATH, RESULTS_PATH] });
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
