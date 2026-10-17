/**
 * tests/shutdown.test.ts
 *
 * Tests for the graceful shutdown sequence in backend/index.ts (issue #705).
 *
 * Strategy:
 *   - Mock every dependency of backend/index.ts (agent, health server, db,
 *     telemetry, config, logger) so importing the entry point opens no
 *     sockets and touches no real resources.
 *   - Spy on process.on to capture the SIGTERM/SIGINT handlers registered by
 *     start() without attaching them to the real test process.
 *   - Stub process.exit so the shutdown pipeline can run to completion.
 *   - vi.resetModules() before each test gives every import a fresh copy of
 *     the module-level state (agent, healthServer, isShuttingDown).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Implementations are passed directly to vi.fn() so they survive the
// restoreMocks: true setting in vitest.config.ts.
const mocks = vi.hoisted(() => ({
  drain: vi.fn(),
  waitForPendingTasks: vi.fn(async () => {}),
  healthServerClose: vi.fn((cb: (err?: Error) => void) => cb()),
  dbClose: vi.fn(async () => {}),
  initTelemetry: vi.fn(),
  shutdownTelemetry: vi.fn(async () => {}),
}));

vi.mock('../backend/agent', () => ({
  PayFiAgent: vi.fn(function (this: any) {
    this.drain = mocks.drain;
    this.waitForPendingTasks = mocks.waitForPendingTasks;
  }),
}));

vi.mock('../backend/server', () => ({
  startHealthServer: vi.fn(() => ({ close: mocks.healthServerClose })),
}));

vi.mock('../backend/db/client', () => ({
  db: { close: mocks.dbClose },
}));

vi.mock('../backend/telemetry', () => ({
  initTelemetry: mocks.initTelemetry,
  shutdownTelemetry: mocks.shutdownTelemetry,
}));

vi.mock('../backend/config', () => ({
  configPromise: Promise.resolve({}),
}));

vi.mock('../backend/utils/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() })),
}));

type SignalHandler = () => void;

describe('backend/index.ts graceful shutdown', () => {
  let handlers: Record<string, SignalHandler>;
  let exitSpy: any;

  async function bootEntryPoint(): Promise<void> {
    await import('../backend/index');
    await vi.waitFor(() => {
      expect(handlers.SIGTERM).toBeDefined();
      expect(handlers.SIGINT).toBeDefined();
    });
  }

  beforeEach(() => {
    vi.resetModules();
    handlers = {};

    vi.spyOn(process, 'on').mockImplementation(((event: string, listener: SignalHandler) => {
      handlers[event] = listener;
      return process;
    }) as any);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
  });

  it.each(['SIGTERM', 'SIGINT'])(
    'runs the full shutdown pipeline on %s and closes the health server exactly once',
    async (signal) => {
      await bootEntryPoint();

      handlers[signal]();
      await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled());

      expect(mocks.drain).toHaveBeenCalledTimes(1);
      expect(mocks.waitForPendingTasks).toHaveBeenCalledTimes(1);
      expect(mocks.healthServerClose).toHaveBeenCalledTimes(1);
      expect(mocks.healthServerClose).toHaveBeenCalledWith(expect.any(Function));
      expect(mocks.dbClose).toHaveBeenCalledTimes(1);
      expect(mocks.shutdownTelemetry).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledTimes(1);
      expect(exitSpy).toHaveBeenCalledWith(0);
    }
  );

  it('tears resources down in order: drain → pending tasks → health server → db → telemetry', async () => {
    await bootEntryPoint();

    handlers.SIGTERM();
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));

    const order = [
      mocks.drain,
      mocks.waitForPendingTasks,
      mocks.healthServerClose,
      mocks.dbClose,
      mocks.shutdownTelemetry,
      exitSpy,
    ].map((fn) => fn.mock.invocationCallOrder[0]);

    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('ignores repeated signals once shutdown has started', async () => {
    await bootEntryPoint();

    handlers.SIGTERM();
    handlers.SIGINT();
    handlers.SIGTERM();
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled());

    expect(mocks.healthServerClose).toHaveBeenCalledTimes(1);
    expect(mocks.dbClose).toHaveBeenCalledTimes(1);
    expect(mocks.shutdownTelemetry).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledTimes(1);
  });

  it('exits with code 1 and skips later steps when healthServer.close() reports an error', async () => {
    mocks.healthServerClose.mockImplementationOnce((cb: (err?: Error) => void) =>
      cb(new Error('close failed'))
    );
    await bootEntryPoint();

    handlers.SIGTERM();
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalled());

    expect(mocks.healthServerClose).toHaveBeenCalledTimes(1);
    expect(mocks.dbClose).not.toHaveBeenCalled();
    expect(mocks.shutdownTelemetry).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
