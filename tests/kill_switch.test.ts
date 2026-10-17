/**
 * tests/kill_switch.test.ts
 * Tests for the global kill switch (#743): PAUSED env flag, persistence across
 * restarts, and pause/resume webhook events.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { _setDb, loadAgentState } from '../backend/persistence';
import { dispatchWebhook } from '../backend/webhook';
import { _resetKillSwitch, isPaused, pauseAgent, resumeAgent } from '../backend/kill_switch';

vi.mock('../backend/config', () => ({
  config: {
    get PAUSED() {
      return (globalThis as any).__pausedEnv ?? false;
    },
  },
}));

vi.mock('../backend/webhook', () => ({
  dispatchWebhook: vi.fn().mockResolvedValue(undefined),
}));

describe('kill switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).__pausedEnv = undefined;
    _setDb(new Database(':memory:'));
    _resetKillSwitch();
  });

  afterEach(() => {
    _setDb(null);
  });

  it('is not paused by default', () => {
    expect(isPaused()).toBe(false);
  });

  it('starts paused when PAUSED=true', () => {
    (globalThis as any).__pausedEnv = true;
    expect(isPaused()).toBe(true);
  });

  it('pauses and resumes', () => {
    pauseAgent();
    expect(isPaused()).toBe(true);
    resumeAgent();
    expect(isPaused()).toBe(false);
  });

  it('persists the paused state across a restart', () => {
    pauseAgent();
    expect(loadAgentState('paused')).toBe('true');

    // Simulate a process restart: drop the in-memory state, keep the DB.
    _resetKillSwitch();
    expect(isPaused()).toBe(true);

    resumeAgent();
    _resetKillSwitch();
    expect(isPaused()).toBe(false);
  });

  it('emits an agent.paused webhook event on pause', () => {
    pauseAgent('incident #42');

    expect(dispatchWebhook).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispatchWebhook).mock.calls[0]![0]).toMatchObject({
      event: 'agent.paused',
      paused: true,
      reason: 'incident #42',
    });
  });

  it('emits an agent.resumed webhook event on resume', () => {
    pauseAgent();
    vi.mocked(dispatchWebhook).mockClear();

    resumeAgent();

    expect(dispatchWebhook).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispatchWebhook).mock.calls[0]![0]).toMatchObject({
      event: 'agent.resumed',
      paused: false,
    });
  });

  it('does not emit duplicate events when the state does not change', () => {
    resumeAgent();
    pauseAgent();
    pauseAgent();

    expect(dispatchWebhook).toHaveBeenCalledTimes(1);
  });
});
