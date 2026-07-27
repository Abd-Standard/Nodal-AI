/**
 * backend/index.ts
 * Agent process entry point.
 * Registers SIGTERM/SIGINT handlers and orchestrates graceful shutdown.
 */

import { PayFiAgent } from "./agent";
import { startHealthServer } from "./server";
import { db } from "./db/client";
import { createLogger } from "./utils/logger";
import { initTelemetry, shutdownTelemetry } from "./telemetry";

const log = createLogger("process");

// Initialise OpenTelemetry export (no-op when OTLP_ENDPOINT is unset)
initTelemetry();

const agent = new PayFiAgent();
const healthServer = startHealthServer();

const HARD_KILL_MS = 10_000;
let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info({ msg: "Graceful shutdown initiated", signal });

  // Hard kill: force exit if shutdown hangs beyond 10 seconds
  const hardKill = setTimeout(() => {
    log.error({ msg: "Hard kill: graceful shutdown exceeded 10s, forcing exit" });
    process.exit(1);
  }, HARD_KILL_MS);

  try {
    // 1. Stop accepting new tasks
    agent.drain();

    // 2. Wait for in-flight tasks to settle
    await agent.waitForPendingTasks();

    // 3. Stop the health check server
    await new Promise<void>((resolve, reject) =>
      healthServer.close((err) => (err ? reject(err) : resolve()))
    );

    // 4. Close database connection
    await db.close();

    // 5. Shut down telemetry (flushes pending spans)
    await shutdownTelemetry();

    clearTimeout(hardKill);
    log.info({ msg: "All resources released, exiting cleanly" });
    process.exit(0);
  } catch (err) {
    log.error({ msg: "Error during shutdown sequence", error: err instanceof Error ? err.message : String(err) });
    clearTimeout(hardKill);
    process.exit(1);
  }
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT",  () => shutdown("SIGINT"));

export { agent };
