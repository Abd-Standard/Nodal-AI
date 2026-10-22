/**
 * backend/events.ts
 *
 * Typed lifecycle events emitted by PayFiAgent (#757). See ARCHITECTURE.md.
 */

import { AsyncLocalStorage } from 'async_hooks';
import type { AgentResult, TaskType } from './agent';

interface TaskRef {
  taskType: TaskType;
  correlationId: string;
}

export interface AgentEvents {
  'task:queued': [TaskRef & { queueLength: number }];
  'task:started': [TaskRef];
  'task:retry': [TaskRef & { attempt: number; maxRetries: number; error: string }];
  'task:retry_exhausted': [{ taskType: TaskType; attempts: number }];
  'task:complete': [AgentResult];
  'task:failed': [AgentResult];
  'tx:submitted': [TaskRef & { hash: string }];
  'tx:confirmed': [TaskRef & { hash: string; ledger?: number }];
  error: [Error];
}

interface TaskContext extends TaskRef {
  emit<K extends keyof AgentEvents>(event: K, ...args: AgentEvents[K]): boolean;
}

/** Carries the running task through tool and RPC calls. */
export const taskContext = new AsyncLocalStorage<TaskContext>();

type TaskScopedEvent = 'task:retry' | 'tx:submitted' | 'tx:confirmed';

/**
 * Emit a task-scoped event on the agent running the current task. A no-op when
 * called outside an agent task (e.g. a tool used standalone).
 */
export function emitTaskEvent<K extends TaskScopedEvent>(
  event: K,
  detail: Omit<AgentEvents[K][0], keyof TaskRef>
): void {
  const ctx = taskContext.getStore();
  if (!ctx) return;
  const payload = { ...detail, taskType: ctx.taskType, correlationId: ctx.correlationId };
  ctx.emit(event, ...([payload] as unknown as AgentEvents[K]));
}
