/**
 * backend/executor.ts
 * 
 * ExecutePlan: Human-readable summary generation with confirm/deny flow.
 * AI-generated payments must never execute silently.
 */

import { PayFiAgent, AgentTask, AgentResult, Plan, VALUE_MOVING_TASK_TYPES } from './agent';
import { createLogger } from './utils/logger';

const log = createLogger('executor');

/**
 * Confirmation callback type.
 */
export type ConfirmHandler = (summary: string) => Promise<boolean>;

export interface ExecutePlanOptions {
  /** Callback to confirm/deny execution. If not provided, auto-confirms. */
  confirm?: ConfirmHandler;
  /** Timeout in ms for unconfirmed plans (default: 5 minutes) */
  confirmationTimeoutMs?: number;
}

/**
 * Generate human-readable summary from validated tasks.
 * Built deterministically from task data, not LLM text.
 */
function generateTaskSummary(task: AgentTask): string {
  const p = task.payload as Record<string, unknown>;
  
  switch (task.type) {
    case 'stellar_payment': {
      const dest = String(p.destination ?? '').slice(0, 8) + '...';
      const amt = String(p.amount ?? '0');
      const code = String(p.assetCode ?? 'XLM');
      return `Send ${amt} ${code} to ${dest}`;
    }
    case 'x402_respond': {
      const dest = String(p.payTo ?? '').slice(0, 8) + '...';
      const amt = String(p.amount ?? '0');
      const code = String(p.assetCode ?? 'XLM');
      return `Pay ${amt} ${code} to ${dest} (x402 response)`;
    }
    case 'soroban_invoke': {
      const cid = String(p.contractId ?? '').slice(0, 8) + '...';
      const method = String(p.method ?? '');
      return `Invoke ${method} on contract ${cid}`;
    }
    case 'batch_payment': {
      const payments = (p.payments as Array<Record<string, unknown>>) ?? [];
      return `Batch payment: ${payments.length} payments`;
    }
    case 'path_payment': {
      const send = String(p.sendAmount ?? '0');
      const sendAsset = String(p.sendAsset ?? '');
      const destAsset = String(p.destAsset ?? '');
      return `Swap ${send} ${sendAsset} to ${destAsset}`;
    }
    case 'dex_offer': {
      const action = String(p.action ?? '');
      const amount = String(p.amount ?? '0');
      return `DEX offer: ${action} ${amount}`;
    }
    case 'swap': {
      const sell = String(p.sellAmount ?? '0');
      const sellAsset = (p.sellAsset as { code: string })?.code ?? '';
      const buyAsset = (p.buyAsset as { code: string })?.code ?? '';
      return `Swap ${sell} ${sellAsset} to ${buyAsset}`;
    }
    case 'multisig_payment': {
      const dest = String(p.destination ?? '').slice(0, 8) + '...';
      const amt = String(p.amount ?? '0');
      return `Multi-sig payment: ${amt} to ${dest}`;
    }
    case 'soroban_deploy': {
      return `Deploy Soroban contract`;
    }
    case 'liquidity_pool': {
      const action = String(p.action ?? '');
      return `Liquidity pool: ${action}`;
    }
    default:
      return `${task.type}`;
  }
}

/**
 * Generate full plan summary from tasks.
 */
export function generatePlanSummary(tasks: AgentTask[]): string {
  return tasks.map(generateTaskSummary).join('; ');
}

/**
 * Create a Plan object from tasks.
 */
export function createPlan(tasks: AgentTask[], expirationMs = 300000): Plan {
  const now = new Date();
  const expires = new Date(now.getTime() + expirationMs);
  
  return {
    id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    tasks,
    summary: generatePlanSummary(tasks),
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
  };
}

/**
 * Check if plan has value-moving tasks.
 */
export function planHasValueMovingTasks(plan: Plan): boolean {
  return plan.tasks.some(t => VALUE_MOVING_TASK_TYPES.has(t.type));
}

/**
 * Execute a plan with optional confirmation.
 * 
 * @param agent - The PayFiAgent instance
 * @param plan - The plan to execute
 * @param options - Execution options including confirm callback
 */
export async function executePlan(
  agent: PayFiAgent,
  plan: Plan,
  options: ExecutePlanOptions = {}
): Promise<AgentResult[]> {
  const { confirm, confirmationTimeoutMs = 5 * 60 * 1000 } = options;
  
  // Check plan expiration
  if (new Date(plan.expiresAt) < new Date()) {
    log.warn({ planId: plan.id }, 'Plan expired');
    return [{
      success: false,
      taskType: 'stellar_payment' as any,
      error: 'Plan has expired',
      errorType: 'PLAN_EXPIRED',
    }];
  }
  
  // Check if confirmation is needed (plan has value-moving tasks)
  const needsConfirmation = planHasValueMovingTasks(plan);
  
  if (needsConfirmation && confirm) {
    const approved = await Promise.race([
      confirm(plan.summary),
      new Promise<false>((_, reject) => 
        setTimeout(() => reject(new Error('Confirmation timeout')), confirmationTimeoutMs)
      )
    ]).catch(() => false);
    
    if (!approved) {
      log.info({ planId: plan.id }, 'Plan denied by user');
      return [{
        success: false,
        taskType: 'stellar_payment' as any,
        error: 'Plan denied by user',
        errorType: 'PLAN_DENIED',
      }];
    }
  }
  
  // Execute the plan
  log.info({ planId: plan.id, summary: plan.summary }, 'Executing plan');
  const results = await agent.runSequence(plan.tasks);
  
  return results;
}

export { PayFiAgent, AgentTask, AgentResult, Plan, VALUE_MOVING_TASK_TYPES };