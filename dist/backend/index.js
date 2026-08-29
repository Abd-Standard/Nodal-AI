"use strict";
/**
 * backend/index.ts
 * Agent process entry point.
 * Registers SIGTERM/SIGINT handlers and orchestrates graceful shutdown.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.agent = void 0;
const agent_1 = require("./agent");
const server_1 = require("./server");
const client_1 = require("./db/client");
const logger_1 = require("./utils/logger");
const telemetry_1 = require("./telemetry");
const config_1 = require("./config");
const log = (0, logger_1.createLogger)("process");
let agent;
let healthServer;
const HARD_KILL_MS = 10_000;
let isShuttingDown = false;
async function shutdown(signal) {
    if (isShuttingDown)
        return;
    isShuttingDown = true;
    log.info({ msg: "Graceful shutdown initiated", signal });
    // Hard kill: force exit if shutdown hangs beyond 10 seconds
    const hardKill = setTimeout(() => {
        log.error({ msg: "Hard kill: graceful shutdown exceeded 10s, forcing exit" });
        process.exit(1);
    }, HARD_KILL_MS);
    try {
        // 1. Stop accepting new tasks
        if (agent) {
            agent.drain();
            // 2. Wait for in-flight tasks to settle
            await agent.waitForPendingTasks();
        }
        // 3. Stop the health check server
        if (healthServer) {
            await new Promise((resolve, reject) => healthServer.close((err) => (err ? reject(err) : resolve())));
        }
        // 4. Close database connection
        await client_1.db.close();
        // 5. Shut down telemetry (flushes pending spans)
        await (0, telemetry_1.shutdownTelemetry)();
        clearTimeout(hardKill);
        log.info({ msg: "All resources released, exiting cleanly" });
        process.exit(0);
    }
    catch (err) {
        log.error({ msg: "Error during shutdown sequence", error: err instanceof Error ? err.message : String(err) });
        clearTimeout(hardKill);
        process.exit(1);
    }
}
async function start() {
    await config_1.configPromise;
    // Initialise OpenTelemetry export (no-op when OTLP_ENDPOINT is unset)
    (0, telemetry_1.initTelemetry)();
    exports.agent = agent = new agent_1.PayFiAgent();
    healthServer = (0, server_1.startHealthServer)();
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
}
start().catch((err) => {
    log.error({ msg: "Failed to start agent process", error: err instanceof Error ? err.message : String(err) });
    process.exit(1);
});
//# sourceMappingURL=index.js.map