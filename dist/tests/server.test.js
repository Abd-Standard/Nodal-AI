"use strict";
/**
 * tests/server.test.ts
 *
 * Tests for backend/server.ts — the health-check HTTP server.
 *
 * Strategy:
 *   - Mock `http.createServer` so we can capture the request handler
 *     without opening a real TCP port.
 *   - Mock `config` to provide deterministic values for STELLAR_NETWORK
 *     and AGENT_PUBLIC_KEY.
 *   - Mock `getResults` from persistence to inject controlled data for
 *     the /status endpoint.
 *   - Invoke the captured handler with mock req/res objects and assert
 *     the response shapes.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
// ── Mock modules before importing the module under test ──────────────────────
// Mock http module to capture the request handler
let capturedHandler = null;
vitest_1.vi.mock("http", () => ({
    createServer: vitest_1.vi.fn((handler) => {
        capturedHandler = handler;
        return {
            listen: vitest_1.vi.fn(),
            close: vitest_1.vi.fn(),
        };
    }),
}));
// Mock config module with deterministic values
vitest_1.vi.mock("../backend/config", () => ({
    config: {
        STELLAR_NETWORK: "testnet",
        AGENT_PUBLIC_KEY: "GTEST1234567890123456789012345678901234567890123456",
        HEALTH_PORT: 3000,
    },
}));
// Mock persistence module — getResults returns controlled data
let mockResults = [];
vitest_1.vi.mock("../backend/persistence", () => ({
    getResults: vitest_1.vi.fn((limit) => {
        return mockResults.slice(0, limit ?? 100);
    }),
}));
const server_1 = require("../backend/server");
const persistence_1 = require("../backend/persistence");
// ── Helpers ──────────────────────────────────────────────────────────────────
function makeReq(method, url) {
    return { method, url };
}
function makeRes() {
    const res = {
        _statusCode: 0,
        _body: "",
        _headers: {},
        writeHead: vitest_1.vi.fn(function (statusCode, headers) {
            this._statusCode = statusCode;
            if (headers)
                Object.assign(this._headers, headers);
        }),
        end: vitest_1.vi.fn(function (body) {
            this._body = body ?? "";
        }),
    };
    return res;
}
// ── Tests ────────────────────────────────────────────────────────────────────
(0, vitest_1.describe)("backend/server.ts — health check HTTP server", () => {
    (0, vitest_1.beforeEach)(() => {
        capturedHandler = null;
        mockResults = [];
        vitest_1.vi.clearAllMocks();
    });
    (0, vitest_1.it)("creates an http server via http.createServer", () => {
        (0, server_1.createHealthServer)();
        // If createServer was called, our mock would have captured the handler
        (0, vitest_1.expect)(capturedHandler).toBeTypeOf("function");
    });
    (0, vitest_1.describe)("GET /health", () => {
        (0, vitest_1.it)("returns 200 with { status: 'ok', network, publicKey }", () => {
            (0, server_1.createHealthServer)();
            const req = makeReq("GET", "/health");
            const res = makeRes();
            capturedHandler(req, res);
            (0, vitest_1.expect)(res._statusCode).toBe(200);
            const body = JSON.parse(res._body);
            (0, vitest_1.expect)(body).toEqual({
                status: "ok",
                network: "testnet",
                publicKey: "GTEST1234567890123456789012345678901234567890123456",
            });
            (0, vitest_1.expect)(res._headers["Content-Type"]).toBe("application/json");
        });
        (0, vitest_1.it)("includes the correct network value from config", () => {
            (0, server_1.createHealthServer)();
            const req = makeReq("GET", "/health");
            const res = makeRes();
            capturedHandler(req, res);
            const body = JSON.parse(res._body);
            (0, vitest_1.expect)(body.network).toBe("testnet");
            (0, vitest_1.expect)(body).toHaveProperty("status");
            (0, vitest_1.expect)(body).toHaveProperty("network");
            (0, vitest_1.expect)(body).toHaveProperty("publicKey");
        });
    });
    (0, vitest_1.describe)("GET /status", () => {
        (0, vitest_1.it)("returns 200 with { results: [] } when no persisted results exist", () => {
            (0, server_1.createHealthServer)();
            const req = makeReq("GET", "/status");
            const res = makeRes();
            capturedHandler(req, res);
            (0, vitest_1.expect)(res._statusCode).toBe(200);
            const body = JSON.parse(res._body);
            (0, vitest_1.expect)(body).toHaveProperty("results");
            (0, vitest_1.expect)(Array.isArray(body.results)).toBe(true);
            (0, vitest_1.expect)(body.results).toEqual([]);
            (0, vitest_1.expect)(persistence_1.getResults).toHaveBeenCalledWith(10);
        });
        (0, vitest_1.it)("returns 200 with the last 10 AgentResult records from persistence", () => {
            const fakeResults = Array.from({ length: 15 }, (_, i) => ({
                timestamp: `2026-07-24T10:0${i}:00.000Z`,
                taskType: "stellar_payment",
                success: true,
                data: { txHash: `hash_${i}` },
            }));
            mockResults = fakeResults;
            (0, server_1.createHealthServer)();
            const req = makeReq("GET", "/status");
            const res = makeRes();
            capturedHandler(req, res);
            (0, vitest_1.expect)(res._statusCode).toBe(200);
            const body = JSON.parse(res._body);
            (0, vitest_1.expect)(body).toHaveProperty("results");
            (0, vitest_1.expect)(Array.isArray(body.results)).toBe(true);
            (0, vitest_1.expect)(body.results).toHaveLength(10);
            // Should be the first 10 from our mock (getResults returns newest-first)
            (0, vitest_1.expect)(body.results[0].data.txHash).toBe("hash_0");
        });
        (0, vitest_1.it)("returns 500 when persistence throws an error", () => {
            vitest_1.vi.mocked(persistence_1.getResults).mockImplementationOnce(() => {
                throw new Error("Database unavailable");
            });
            (0, server_1.createHealthServer)();
            const req = makeReq("GET", "/status");
            const res = makeRes();
            capturedHandler(req, res);
            (0, vitest_1.expect)(res._statusCode).toBe(500);
            const body = JSON.parse(res._body);
            (0, vitest_1.expect)(body).toHaveProperty("error");
            (0, vitest_1.expect)(body.error).toContain("Database unavailable");
        });
    });
    (0, vitest_1.describe)("404 handling", () => {
        (0, vitest_1.it)("returns 404 for unknown routes", () => {
            (0, server_1.createHealthServer)();
            const req = makeReq("GET", "/unknown");
            const res = makeRes();
            capturedHandler(req, res);
            (0, vitest_1.expect)(res._statusCode).toBe(404);
        });
        (0, vitest_1.it)("returns 404 for POST /health", () => {
            (0, server_1.createHealthServer)();
            const req = makeReq("POST", "/health");
            const res = makeRes();
            capturedHandler(req, res);
            (0, vitest_1.expect)(res._statusCode).toBe(404);
        });
    });
});
//# sourceMappingURL=server.test.js.map