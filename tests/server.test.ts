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
 *   - Mock the dependency probes (checkHorizon/checkSoroban/checkDatabase)
 *     so /health can be exercised for both the healthy and degraded paths.
 *   - Invoke the captured handler with mock req/res objects and assert
 *     the response shapes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock modules before importing the module under test ──────────────────────

// Mock http module to capture the request handler
let capturedHandler: http.RequestListener | null = null;
vi.mock('http', () => ({
  createServer: vi.fn((handler: http.RequestListener) => {
    capturedHandler = handler;
    return {
      listen: vi.fn(),
      close: vi.fn(),
    };
  }),
}));

// Mock config module with deterministic values
vi.mock('../backend/config', () => ({
  config: {
    STELLAR_NETWORK: 'testnet',
    AGENT_PUBLIC_KEY: 'GTEST1234567890123456789012345678901234567890123456',
    HEALTH_PORT: 3000,
    // server.ts pulls in rpc_client, which builds a Horizon.Server at import
    // time; without these the URI constructor throws and the suite cannot load.
    HORIZON_URL: 'https://horizon-testnet.stellar.org',
    SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
  },
}));

// Mock persistence module — getResults returns controlled data, or throws
// when a test wants to exercise the error path.
let mockResults: any[] = [];
let mockResultsError: unknown = null;
vi.mock('../backend/persistence', () => ({
  getResults: vi.fn((limit?: number) => {
    if (mockResultsError) throw mockResultsError;
    return mockResults.slice(0, limit ?? 100);
  }),
}));

// Mock the dependency probes used by handleHealth(). Each defaults to a
// healthy result; individual tests override them to exercise the degraded
// path. The real implementations are never invoked in this suite.
let horizonOk = true;
let sorobanOk = true;
let databaseOk = true;
vi.mock('../backend/health', () => ({
  checkHorizon: vi.fn(async () => (horizonOk ? { ok: true } : { ok: false, error: 'horizon down' })),
  checkSoroban: vi.fn(async () => (sorobanOk ? { ok: true } : { ok: false, error: 'soroban down' })),
  checkDatabase: vi.fn(async () => (databaseOk ? { ok: true } : { ok: false, error: 'database down' })),
}));

// Mock the kill switch with an in-memory flag so the admin routes can be
// exercised without a database or webhook.
let mockPaused = false;
vi.mock('../backend/kill_switch', () => ({
  isPaused: vi.fn(() => mockPaused),
  pauseAgent: vi.fn(() => {
    mockPaused = true;
  }),
  resumeAgent: vi.fn(() => {
    mockPaused = false;
  }),
}));

import type * as http from 'http';
import { Readable } from 'stream';
import { createHealthServer } from '../backend/server';
import { pauseAgent, resumeAgent } from '../backend/kill_switch';
import {
  ContractError,
  NetworkTimeoutError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
} from '../backend/errors';
import { getResults } from '../backend/persistence';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(method: string, url: string, headers: Record<string, string> = {}): http.IncomingMessage {
  return { method, url, headers } as http.IncomingMessage;
}

function makeBodyReq(
  method: string,
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): http.IncomingMessage {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method,
    url,
    headers,
  }) as unknown as http.IncomingMessage;
}

/** Lets the async route handlers finish reading the body and responding. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeRes(): http.ServerResponse & {
  _statusCode: number;
  _body: string;
  _headers: Record<string, any>;
} {
  const res: any = {
    _statusCode: 0,
    _body: '',
    _headers: {},
    writeHead: vi.fn(function (this: any, statusCode: number, headers?: Record<string, any>) {
      this._statusCode = statusCode;
      if (headers) Object.assign(this._headers, headers);
    }),
    end: vi.fn(function (this: any, body?: string) {
      this._body = body ?? '';
    }),
  };
  return res;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('backend/server.ts — health check HTTP server', () => {
  beforeEach(() => {
    capturedHandler = null;
    mockResults = [];
    mockResultsError = null;
    horizonOk = true;
    sorobanOk = true;
    databaseOk = true;
    delete process.env.WEBHOOK_SECRET;
    vi.clearAllMocks();
  });

  it('creates an http server via http.createServer', () => {
    createHealthServer();
    // If createServer was called, our mock would have captured the handler
    expect(capturedHandler).toBeTypeOf('function');
  });

  describe('GET /health', () => {
    it("returns 200 with { status: 'ok', components } when all probes pass", async () => {
      createHealthServer();
      const req = makeReq('GET', '/health');
      const res = makeRes();

      await capturedHandler!(req, res);

      expect(res._statusCode).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.status).toBe('ok');
      expect(body.components).toEqual({
        horizon: { ok: true },
        soroban: { ok: true },
        database: { ok: true },
      });
      expect(res._headers['Content-Type']).toBe('application/json');
    });

    it('health response matches expected shape', async () => {
      createHealthServer();
      const req = makeReq('GET', '/health');
      const res = makeRes();

      await capturedHandler!(req, res);

      expect(res._statusCode).toBe(200);
      const body = JSON.parse(res._body);
      expect(body).toMatchSnapshot();
    });

    it('returns 503 with status "degraded" when Horizon is down', async () => {
      horizonOk = false;
      createHealthServer();
      const req = makeReq('GET', '/health');
      const res = makeRes();

      await capturedHandler!(req, res);

      expect(res._statusCode).toBe(503);
      const body = JSON.parse(res._body);
      expect(body.status).toBe('degraded');
      expect(body.components.horizon.ok).toBe(false);
    });

    it('returns 503 with status "degraded" when Soroban is down', async () => {
      sorobanOk = false;
      createHealthServer();
      const req = makeReq('GET', '/health');
      const res = makeRes();

      await capturedHandler!(req, res);

      expect(res._statusCode).toBe(503);
      const body = JSON.parse(res._body);
      expect(body.status).toBe('degraded');
      expect(body.components.soroban.ok).toBe(false);
    });

    it('returns 503 with status "degraded" when the database is down', async () => {
      databaseOk = false;
      createHealthServer();
      const req = makeReq('GET', '/health');
      const res = makeRes();

      await capturedHandler!(req, res);

      expect(res._statusCode).toBe(503);
      const body = JSON.parse(res._body);
      expect(body.status).toBe('degraded');
      expect(body.components.database.ok).toBe(false);
    });
  });

  describe('GET /status', () => {
    it('returns 200 with { results: [] } when no persisted results exist', () => {
      createHealthServer();
      const req = makeReq('GET', '/status');
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(200);
      const body = JSON.parse(res._body);
      expect(body).toHaveProperty('results');
      expect(Array.isArray(body.results)).toBe(true);
      expect(body.results).toEqual([]);
      expect(getResults).toHaveBeenCalledWith(10, 0);
    });

    it('returns 200 with the last 10 AgentResult records from persistence', () => {
      const fakeResults = Array.from({ length: 15 }, (_, i) => ({
        timestamp: `2026-07-24T10:0${i}:00.000Z`,
        taskType: 'stellar_payment',
        success: true,
        data: { txHash: `hash_${i}` },
      }));
      mockResults = fakeResults;

      createHealthServer();
      const req = makeReq('GET', '/status');
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(200);
      const body = JSON.parse(res._body);
      expect(body).toHaveProperty('results');
      expect(Array.isArray(body.results)).toBe(true);
      expect(body.results).toHaveLength(10);
      // Should be the first 10 from our mock (getResults returns newest-first)
      expect(body.results[0].data.txHash).toBe('hash_0');
    });

    it('honours the limit and offset query parameters', () => {
      const fakeResults = Array.from({ length: 15 }, (_, i) => ({
        timestamp: `2026-07-24T10:0${i}:00.000Z`,
        taskType: 'stellar_payment',
        success: true,
        data: { txHash: `hash_${i}` },
      }));
      mockResults = fakeResults;

      createHealthServer();
      const req = makeReq('GET', '/status?limit=5&offset=2');
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.results).toHaveLength(5);
      expect(getResults).toHaveBeenCalledWith(5, 2);
    });

    it('returns 401 when WEBHOOK_SECRET is set and no Bearer token is supplied', () => {
      process.env.WEBHOOK_SECRET = 'super-secret';
      createHealthServer();
      const req = makeReq('GET', '/status');
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(401);
      expect(getResults).not.toHaveBeenCalled();
    });

    it('returns 200 when WEBHOOK_SECRET is set and a matching Bearer token is supplied', () => {
      process.env.WEBHOOK_SECRET = 'super-secret';
      createHealthServer();
      const req = makeReq('GET', '/status', { authorization: 'Bearer super-secret' });
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(200);
      const body = JSON.parse(res._body);
      expect(body).toHaveProperty('results');
    });

    it('returns 500 when persistence throws an error', () => {
      vi.mocked(getResults).mockImplementation(() => {
        throw new Error('db down');
      });

      createHealthServer();
      const req = makeReq('GET', '/status');
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(500);
      const body = JSON.parse(res._body);
      // The raw failure message is deliberately not echoed back to the caller.
      expect(body).toHaveProperty('error');
      expect(body.error).not.toContain('db down');
    });
  });

  describe('POST /admin/pause and /admin/resume (#743)', () => {
    beforeEach(() => {
      mockPaused = false;
    });

    it('returns 401 and does not pause when WEBHOOK_SECRET is unset', () => {
      createHealthServer();
      const res = makeRes();

      capturedHandler!(makeReq('POST', '/admin/pause'), res);

      expect(res._statusCode).toBe(401);
      expect(pauseAgent).not.toHaveBeenCalled();
      expect(mockPaused).toBe(false);
    });

    it('returns 401 for a missing or wrong bearer token', () => {
      process.env.WEBHOOK_SECRET = 'admin-secret';
      createHealthServer();

      const noAuth = makeRes();
      capturedHandler!(makeReq('POST', '/admin/pause'), noAuth);
      const wrongAuth = makeRes();
      capturedHandler!(
        makeReq('POST', '/admin/pause', { authorization: 'Bearer nope' }),
        wrongAuth
      );

      expect(noAuth._statusCode).toBe(401);
      expect(wrongAuth._statusCode).toBe(401);
      expect(pauseAgent).not.toHaveBeenCalled();
    });

    it('pauses the agent with a valid bearer token', () => {
      process.env.WEBHOOK_SECRET = 'admin-secret';
      createHealthServer();
      const res = makeRes();

      capturedHandler!(
        makeReq('POST', '/admin/pause', { authorization: 'Bearer admin-secret' }),
        res
      );

      expect(res._statusCode).toBe(200);
      expect(JSON.parse(res._body)).toEqual({ paused: true });
      expect(pauseAgent).toHaveBeenCalledTimes(1);
    });

    it('resumes the agent with a valid bearer token', () => {
      process.env.WEBHOOK_SECRET = 'admin-secret';
      mockPaused = true;
      createHealthServer();
      const res = makeRes();

      capturedHandler!(
        makeReq('POST', '/admin/resume', { authorization: 'Bearer admin-secret' }),
        res
      );

      expect(res._statusCode).toBe(200);
      expect(JSON.parse(res._body)).toEqual({ paused: false });
      expect(resumeAgent).toHaveBeenCalledTimes(1);
    });

    it('does not expose the admin routes over GET', () => {
      process.env.WEBHOOK_SECRET = 'admin-secret';
      createHealthServer();
      const res = makeRes();

      capturedHandler!(
        makeReq('GET', '/admin/pause', { authorization: 'Bearer admin-secret' }),
        res
      );

      expect(res._statusCode).toBe(404);
      expect(pauseAgent).not.toHaveBeenCalled();
    });
  });

  describe('approvals (#736)', () => {
    const approval = { id: 'appr-1', status: 'pending_approval' };
    let agent: any;

    beforeEach(() => {
      agent = {
        listApprovals: vi.fn(() => [approval]),
        approve: vi.fn(async () => ({
          approval: { ...approval, status: 'approved' },
          result: { success: true, taskType: 'stellar_payment' },
        })),
        deny: vi.fn(() => ({ ...approval, status: 'denied' })),
      };
    });

    it('lists pending approvals', () => {
      createHealthServer(agent);
      const res = makeRes();

      capturedHandler!(makeReq('GET', '/approvals'), res);

      expect(res._statusCode).toBe(200);
      expect(JSON.parse(res._body)).toEqual({ approvals: [approval] });
    });

    it('returns 401 for a decision when WEBHOOK_SECRET is unset', async () => {
      createHealthServer(agent);
      const res = makeRes();

      capturedHandler!(makeBodyReq('POST', '/approvals/appr-1', { decision: 'approve' }), res);
      await flush();

      expect(res._statusCode).toBe(401);
      expect(agent.approve).not.toHaveBeenCalled();
    });

    it('returns 401 for a decision with a wrong bearer token', async () => {
      process.env.WEBHOOK_SECRET = 'admin-secret';
      createHealthServer(agent);
      const res = makeRes();

      capturedHandler!(
        makeBodyReq('POST', '/approvals/appr-1', { decision: 'approve' }, {
          authorization: 'Bearer nope',
        }),
        res
      );
      await flush();

      expect(res._statusCode).toBe(401);
      expect(agent.approve).not.toHaveBeenCalled();
    });

    it('approves a pending task with a valid bearer token', async () => {
      process.env.WEBHOOK_SECRET = 'admin-secret';
      createHealthServer(agent);
      const res = makeRes();

      capturedHandler!(
        makeBodyReq('POST', '/approvals/appr-1', { decision: 'approve' }, {
          authorization: 'Bearer admin-secret',
        }),
        res
      );
      await flush();

      expect(res._statusCode).toBe(200);
      expect(agent.approve).toHaveBeenCalledWith('appr-1');
      expect(JSON.parse(res._body).approval.status).toBe('approved');
    });

    it('denies a pending task with a valid bearer token', async () => {
      process.env.WEBHOOK_SECRET = 'admin-secret';
      createHealthServer(agent);
      const res = makeRes();

      capturedHandler!(
        makeBodyReq('POST', '/approvals/appr-1', { decision: 'deny' }, {
          authorization: 'Bearer admin-secret',
        }),
        res
      );
      await flush();

      expect(res._statusCode).toBe(200);
      expect(agent.deny).toHaveBeenCalledWith('appr-1');
      expect(JSON.parse(res._body).approval.status).toBe('denied');
    });

    it('returns 400 for an unknown decision and 404 for an unknown id', async () => {
      process.env.WEBHOOK_SECRET = 'admin-secret';
      agent.deny = vi.fn(() => null);
      createHealthServer(agent);
      const auth = { authorization: 'Bearer admin-secret' };

      const bad = makeRes();
      capturedHandler!(makeBodyReq('POST', '/approvals/appr-1', { decision: 'maybe' }, auth), bad);
      const missing = makeRes();
      capturedHandler!(makeBodyReq('POST', '/approvals/nope', { decision: 'deny' }, auth), missing);
      await flush();

      expect(bad._statusCode).toBe(400);
      expect(missing._statusCode).toBe(404);
    });
  });
});
