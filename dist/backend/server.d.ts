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
/** Reachability of a single dependency. */
export type ComponentStatus = "up" | "down";
export interface HealthResponse {
    status: "ok" | "degraded";
    components: {
        horizon: ComponentStatus;
        soroban: ComponentStatus;
        database: ComponentStatus;
    };
}
/** Probe Horizon. */
export declare function checkHorizon(): Promise<ComponentStatus>;
/**
 * Probe Soroban RPC (#233).
 *
 * Previously unchecked, so an agent whose Soroban RPC was down still reported
 * `status: "ok"` — while every `soroban_invoke` and `soroban_query` task
 * failed. Horizon being reachable says nothing about Soroban; they are
 * separate services on separate hosts.
 */
export declare function checkSoroban(): Promise<ComponentStatus>;
export declare function checkDatabase(): Promise<ComponentStatus>;
/**
 * Creates and returns the health-check HTTP server.
 * Does NOT call `.listen()` — the caller (typically `index.ts`) is responsible
 * for binding to `config.HEALTH_PORT`.
 */
export declare function createHealthServer(): http.Server;
/**
 * Convenience: create the server and immediately start listening.
 * Returns the bound server instance.
 */
export declare function startHealthServer(): http.Server;
//# sourceMappingURL=server.d.ts.map