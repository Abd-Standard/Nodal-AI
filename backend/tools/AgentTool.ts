/**
 * backend/tools/AgentTool.ts
 *
 * Self-describing tool contract used by PayFiAgent's tool registry.
 *
 * Every task type the agent can run is an AgentTool registered under its
 * `name`. The agent parses the task payload with `inputSchema` before calling
 * `execute`, so a tool always receives a validated, typed input.
 */

import type { ZodType, ZodTypeDef } from 'zod';
import type { TaskType } from '../agent';
import type { createLogger } from '../utils/logger';

/** Per-execution services the agent hands to a tool. */
export interface ToolContext {
  /** Correlation ID shared by every log line, result and webhook of this task. */
  correlationId: string;
  /** Logger already bound to this task's correlation ID. */
  logger: ReturnType<typeof createLogger>;
  /** Stellar network the agent is configured for. */
  network: string;
  /**
   * Enforce AGENT_SPENDING_LIMIT and the mainnet spending cap for `amount`,
   * and record it in the rolling spending window. Throws when over a limit.
   */
  assertWithinSpendingLimit(amount: unknown): void;
}

export interface AgentTool<I = unknown, O = unknown> {
  /** Task type this tool handles — the value of `AgentTask.type`. */
  name: TaskType;
  /** One-line, human/LLM-readable description of what the tool does. */
  description: string;
  /** Schema the task payload is parsed with before `execute` is called. */
  inputSchema: ZodType<I, ZodTypeDef, unknown>;
  /** True when the tool can move funds out of the agent's account. */
  valueMoving: boolean;
  /** Run the tool with the parsed payload. */
  execute(input: I, ctx: ToolContext): Promise<O>;
}
