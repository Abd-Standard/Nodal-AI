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
