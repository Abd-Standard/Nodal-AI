/**
 * backend/server.ts
 * Health check and spending report HTTP server for container orchestration
 * (Kubernetes, Docker Swarm) and observability.
 *
 * Endpoints:
 *   GET /health   — 200 when all dependencies are up, 503 otherwise.
 *   GET /spending — per-asset spending usage for the current window (#733).
 */

import * as http from "http";
import { horizonServer } from "./rpc_client";
import { db } from "./db/client";
import { SpendingTracker } from "./spending_tracker";
import { createLogger } from "./utils/logger";
import { handleError } from "./middleware/error_handler";

const log = createLogger("health-server");

const HEALTH_PATH   = "/health";
const SPENDING_PATH = "/spending";

type ComponentStatus = "up" | "down";

interface HealthResponse {
  status: "ok" | "degraded";
  components: {
    rpc:      ComponentStatus;
    database: ComponentStatus;
  };
}

/** Per-asset usage entry returned by GET /spending. */
interface SpendingEntry {
  asset:     string;
  total:     string;
  limit:     string;
  remaining: string;
}

interface SpendingResponse {
  windowMs: number;
  assets:   SpendingEntry[];
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

/**
 * Create and start the HTTP server.
 *
 * @param port        - Port to listen on (default 3001).
 * @param tracker     - SpendingTracker instance to query for /spending.
 *                      Defaults to a new SpendingTracker(); inject in tests.
 */
export function createHealthServer(
  port = 3001,
  tracker: SpendingTracker = new SpendingTracker()
): http.Server {
  const server = http.createServer(async (req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end();
      return;
    }

    // ── GET /health ──────────────────────────────────────────────────────────
    if (req.url === HEALTH_PATH) {
      try {
        const [rpc, database] = await Promise.all([checkRpc(), checkDatabase()]);
        const allUp     = rpc === "up" && database === "up";
        const statusCode = allUp ? 200 : 503;
        const body: HealthResponse = {
          status:     allUp ? "ok" : "degraded",
          components: { rpc, database },
        };
        const payload = JSON.stringify(body);
        res.writeHead(statusCode, {
          "Content-Type":   "application/json",
          "Content-Length": Buffer.byteLength(payload),
        });
        res.end(payload);
      } catch (err) {
        const errorResponse = handleError(err);
        log.error({ msg: "Unhandled /health error", status: errorResponse.status, type: errorResponse.type });
        const payload = JSON.stringify(errorResponse);
        res.writeHead(errorResponse.status, {
          "Content-Type":   "application/json",
          "Content-Length": Buffer.byteLength(payload),
        });
        res.end(payload);
      }
      return;
    }

    // ── GET /spending ────────────────────────────────────────────────────────
    // Issue #733: report per-asset usage so operators can see how much of each
    // asset's limit has been consumed in the current rolling window.
    if (req.url === SPENDING_PATH) {
      try {
        const assets = tracker.report();
        const body: SpendingResponse = {
          windowMs: tracker.getWindowMs(),
          assets,
        };
        const payload = JSON.stringify(body);
        res.writeHead(200, {
          "Content-Type":   "application/json",
          "Content-Length": Buffer.byteLength(payload),
        });
        res.end(payload);
      } catch (err) {
        const errorResponse = handleError(err);
        log.error({ msg: "Unhandled /spending error", status: errorResponse.status, type: errorResponse.type });
        const payload = JSON.stringify(errorResponse);
        res.writeHead(errorResponse.status, {
          "Content-Type":   "application/json",
          "Content-Length": Buffer.byteLength(payload),
        });
        res.end(payload);
      }
      return;
    }

    // Exclude health endpoint from standard request logging to prevent log spam
    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => {
    log.info({ msg: "Health server listening", port, paths: [HEALTH_PATH, SPENDING_PATH] });
  });

  return server;
}
