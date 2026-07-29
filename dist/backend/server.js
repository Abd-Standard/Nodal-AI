"use strict";
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
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkHorizon = checkHorizon;
exports.checkSoroban = checkSoroban;
exports.checkDatabase = checkDatabase;
exports.createHealthServer = createHealthServer;
exports.startHealthServer = startHealthServer;
const http = __importStar(require("http"));
const config_1 = require("./config");
const persistence_1 = require("./persistence");
const rpc_client_1 = require("./rpc_client");
const client_1 = require("./db/client");
const error_handler_1 = require("./middleware/error_handler");
const logger_1 = require("./utils/logger");
const agent_1 = require("./agent");
const log = (0, logger_1.createLogger)("health-server");
/**
 * Bound on a single probe.
 *
 * Without it an unreachable endpoint hangs until the socket's own timeout,
 * and an orchestrator's liveness probe times out first — reporting the agent
 * as dead rather than degraded, which triggers a restart instead of a
 * failover.
 */
const PROBE_TIMEOUT_MS = 3_000;
async function withTimeout(work) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("probe timed out")), PROBE_TIMEOUT_MS);
    });
    try {
        return await Promise.race([work, timeout]);
    }
    finally {
        clearTimeout(timer);
    }
}
/** Probe Horizon. */
async function checkHorizon() {
    try {
        await withTimeout(rpc_client_1.horizonServer.fetchBaseFee());
        return "up";
    }
    catch (err) {
        log.warn({ msg: "Horizon health probe failed", err: String(err) });
        return "down";
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
async function checkSoroban() {
    try {
        await withTimeout(rpc_client_1.sorobanServer.getNetwork());
        return "up";
    }
    catch (err) {
        log.warn({ msg: "Soroban RPC health probe failed", err: String(err) });
        return "down";
    }
}
async function checkDatabase() {
    try {
        return (await withTimeout(client_1.db.healthCheck())) ? "up" : "down";
    }
    catch (err) {
        log.warn({ msg: "Database health probe failed", err: String(err) });
        return "down";
    }
}
// ─── Auth helper ──────────────────────────────────────────────────────────────
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET;
/**
 * Returns true if the request passes Bearer-token authentication.
 * When WEBHOOK_SECRET is unset, all requests are allowed.
 */
function isAuthenticated(req) {
    if (!WEBHOOK_SECRET)
        return true;
    const auth = req.headers["authorization"];
    if (!auth)
        return false;
    const [scheme, token] = auth.split(" ");
    return scheme?.toLowerCase() === "bearer" && token === WEBHOOK_SECRET;
}
const HEALTH_PATH = "/health";
const STATUS_PATH = "/status";
const SPENDING_PATH = "/spending";
/**
 * Creates and returns the health-check HTTP server.
 * Does NOT call `.listen()` — the caller (typically `index.ts`) is responsible
 * for binding to `config.HEALTH_PORT`.
 */
function createHealthServer() {
    const server = http.createServer((req, res) => {
        // ── GET /health ────────────────────────────────────────────────────────
        if (req.method === "GET" && req.url === HEALTH_PATH) {
            const body = JSON.stringify({
                status: "ok",
                network: config_1.config.STELLAR_NETWORK,
                publicKey: config_1.config.AGENT_PUBLIC_KEY,
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
                const results = (0, persistence_1.getResults)(10);
                const body = JSON.stringify({ results });
                res.writeHead(200, {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                });
                res.end(body);
            }
            catch (err) {
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
        // ── GET /spending ──────────────────────────────────────────────────────
        if (req.method === "GET" && req.url === SPENDING_PATH) {
            if (!isAuthenticated(req)) {
                res.writeHead(401, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Unauthorized" }));
                return;
            }
            const total = agent_1.spendingTracker.total();
            const limit = parseFloat(config_1.config.AGENT_SPENDING_LIMIT);
            const body = JSON.stringify({
                total,
                limit,
                windowMs: config_1.config.SPENDING_WINDOW_MS,
                percentUsed: total / limit * 100,
            });
            res.writeHead(200, {
                "Content-Type": "application/json",
                "Content-Length": Buffer.byteLength(body),
            });
            res.end(body);
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
function startHealthServer() {
    const server = createHealthServer();
    const port = config_1.config.HEALTH_PORT;
    server.listen(port, () => {
        process.stdout.write(`✅ [HealthServer] Listening on port ${port}\n`);
        process.stdout.write(`   GET /health → { status, network, publicKey }\n` +
            `   GET /status → { results: AgentResult[] }\n`);
    });
    return server;
}
// ─── Route handlers ───────────────────────────────────────────────────────────
async function handleHealth(_req, res) {
    try {
        // Probed concurrently: run serially and a slow Horizon delays the Soroban
        // answer, so the endpoint's latency becomes the sum of every dependency.
        const [horizon, soroban, database] = await Promise.all([
            checkHorizon(),
            checkSoroban(),
            checkDatabase(),
        ]);
        const allUp = horizon === "up" && soroban === "up" && database === "up";
        const statusCode = allUp ? 200 : 503;
        const body = {
            status: allUp ? "ok" : "degraded",
            components: { horizon, soroban, database },
        };
        const payload = JSON.stringify(body);
        res.writeHead(statusCode, {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
        });
        res.end(payload);
    }
    catch (err) {
        const errorResponse = (0, error_handler_1.handleError)(err);
        log.error({ msg: "Unhandled request error", status: errorResponse.status, type: errorResponse.type });
        const payload = JSON.stringify(errorResponse);
        res.writeHead(errorResponse.status, {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
        });
        res.end(payload);
    }
}
async function handleResults(req, res, parsedUrl) {
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
        const results = (0, persistence_1.getResults)(limit, offset);
        const payload = JSON.stringify(results);
        res.writeHead(200, {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
        });
        res.end(payload);
    }
    catch (err) {
        const errorResponse = (0, error_handler_1.handleError)(err);
        log.error({ msg: "Results endpoint error", status: errorResponse.status, type: errorResponse.type });
        const payload = JSON.stringify(errorResponse);
        res.writeHead(errorResponse.status, {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
        });
        res.end(payload);
    }
}
//# sourceMappingURL=server.js.map