/**
 * backend/kill_switch.ts
 *
 * Global kill switch that halts every value-moving task without stopping the
 * process, so health checks and read-only tasks keep working during an incident.
 *
 * The agent starts paused when PAUSED=true or when it was paused before the last
 * restart (the state is persisted in the agent database). Pausing and resuming
 * emit an `agent.paused` / `agent.resumed` webhook event.
 */

import { config } from './config';
import { loadAgentState, saveAgentState } from './persistence';
import { dispatchWebhook } from './webhook';
import { createLogger } from './utils/logger';

const log = createLogger('kill-switch');

const PAUSED_STATE_KEY = 'paused';

let _paused: boolean | null = null;

function loadInitialState(): boolean {
  if (config.PAUSED) return true;
  try {
    return loadAgentState(PAUSED_STATE_KEY) === 'true';
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Could not read persisted paused state — assuming not paused'
    );
    return false;
  }
}

function setPaused(paused: boolean, reason?: string): void {
  _paused = paused;
  try {
    saveAgentState(PAUSED_STATE_KEY, String(paused));
  } catch (err) {
    log.error(
      { paused, error: err instanceof Error ? err.message : String(err) },
      'Failed to persist paused state'
    );
  }
  log.warn({ paused, reason }, paused ? 'Agent paused' : 'Agent resumed');
  void dispatchWebhook({
    event: paused ? 'agent.paused' : 'agent.resumed',
    paused,
    ...(reason ? { reason } : {}),
    timestamp: new Date().toISOString(),
  });
}

/** True while value-moving tasks are halted. */
export function isPaused(): boolean {
  if (_paused === null) _paused = loadInitialState();
  return _paused;
}

/** Halt value-moving tasks. No-op (no event) when already paused. */
export function pauseAgent(reason?: string): void {
  if (isPaused()) return;
  setPaused(true, reason);
}

/** Resume value-moving tasks. No-op (no event) when not paused. */
export function resumeAgent(reason?: string): void {
  if (!isPaused()) return;
  setPaused(false, reason);
}

/** Drop the cached state so the next read reloads it — used in tests. */
export function _resetKillSwitch(): void {
  _paused = null;
}
