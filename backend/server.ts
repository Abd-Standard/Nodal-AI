/**
 * backend/server.ts
 *
 * HTTP server for container orchestration (Kubernetes, Docker Swarm).
 *
 * Routes:
 *   GET /health   — 200 when all dependencies are up, 503 otherwise.
 *   GET /spending — Per-asset spending usage within the current rolling window.
 */

import * as http from "http";
import { horizonServer } from "./rpc_client";
import { db } from "./db/client";
import { createLogger } from "./utils/logger";
import { handleError } from "./middleware/error_handler";
import { SpendingTracker, assetKey as makeAssetKey } from "./spending_tracker";
import { config } from "./config";
import { stroopsToString } from "./utils/amount";

const log = createLogger("health-server");

const HEALTH_PATH   = "/health";
const SPENDING_PATH = "/spending";

type ComponentStatus = "up" | "down";

interface HealthResponse {
  status: "ok" | "degraded";
  components: {
    rpc: ComponentStatus;
    database: ComponentStatus;
  };
}

/** Shape returned by GET /spending */
interface SpendingResponse {
  windowMs: number;
  usage: Array<{
    assetKey: string;
    spent: string;   // canonical 7-decimal string (e.g. "50.0000000")
    limit: string;   // canonical 7-decimal string or "global"
  }>;
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
 * Build the /spending response from the shared SpendingTracker singleton.
 * The tracker is imported lazily to avoid circular deps with config.
 */
function buildSpendingResponse(tracker: SpendingTracker): SpendingResponse {
  const totalsMap = tracker.totals();
  const limitsMap = config.SPENDING_LIMITS_MAP;
  const globalLimit = config.AGENT_SPENDING_LIMIT;

  // Collect all asset keys that have been seen OR have an explicit limit configured
  const allKeys = new Set<string>([
    ...totalsMap.keys(),
    ...limitsMap.keys(),
    // Always include the default x402 asset
    makeAssetKey(config.X402_ASSET_CODE, config.X402_ASSET_ISSUER),
  ]);

  const usage: SpendingResponse["usage"] = [];

  for (const key of allKeys) {
    const spentStroops = totalsMap.get(key) ?? 0n;
    const limitStr = limitsMap.size > 0
      ? (limitsMap.get(key) ?? (config.SPENDING_LIMITS_ALLOW_UNKNOWN ? globalLimit : "denied"))
      : globalLimit;

    usage.push({
      assetKey: key,
      spent: stroopsToString(spentStroops),
      limit: limitStr,
    });
  }

  return { windowMs: config.SPENDING_WINDOW_MS, usage };
}

export function createHealthServer(
  port = 3001,
  tracker?: SpendingTracker
): http.Server {
  const server = http.createServer(async (req, res) => {
    // ── /health ───────────────────────────────────────────────────────────────
    if (req.method === "GET" && req.url === HEALTH_PATH) {
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
        return;
      } catch (err) {
        const errorResponse = handleError(err);
        log.error({ msg: "Unhandled /health error", status: errorResponse.status, type: errorResponse.type });
        const payload = JSON.stringify(errorResponse);
        res.writeHead(errorResponse.status, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        });
        res.end(payload);
        return;
      }
    }

    // ── /spending ─────────────────────────────────────────────────────────────
    if (req.method === "GET" && req.url === SPENDING_PATH) {
      try {
        const t = tracker ?? _defaultTracker();
        const body = buildSpendingResponse(t);
        const payload = JSON.stringify(body);
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        });
        res.end(payload);
        return;
      } catch (err) {
        const errorResponse = handleError(err);
        log.error({ msg: "Unhandled /spending error", status: errorResponse.status, type: errorResponse.type });
        const payload = JSON.stringify(errorResponse);
        res.writeHead(errorResponse.status, {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        });
        res.end(payload);
        return;
      }
    }

    // ── 404 ───────────────────────────────────────────────────────────────────
    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => {
    log.info({ msg: "Server listening", port, paths: [HEALTH_PATH, SPENDING_PATH] });
  });

  return server;
}

// Lazy singleton accessor — avoids circular import at module load time
let _tracker: SpendingTracker | null = null;
function _defaultTracker(): SpendingTracker {
  if (!_tracker) _tracker = new SpendingTracker();
  return _tracker;
}
