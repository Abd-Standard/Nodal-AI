/**
 * backend/planner.ts
 * 
 * AI-powered planner using function calling.
 * agent.plan("swap 50 XLM to USDC and send half to GB...") returns a structured Plan.
 */

import { z } from 'zod';
import { PayFiAgent, AgentTask, TaskType, VALUE_MOVING_TASK_TYPES, Plan } from './agent';
import { createLogger } from './utils/logger';

const log = createLogger('planner');

// Tool schemas for the LLM
const TOOL_SCHEMAS = {
  stellar_payment: {
    name: 'stellar_payment',
    description: 'Send a payment in XLM or any Stellar asset',
    inputSchema: z.object({
      destination: z.string().describe('Recipient Stellar address'),
      amount: z.string().describe('Amount to send'),
      assetCode: z.string().optional().describe('Asset code (e.g., USDC)'),
      assetIssuer: z.string().optional().describe('Asset issuer'),
      memo: z.string().optional().describe('Memo to attach'),
    }),
  },
  x402_respond: {
    name: 'x402_respond',
    description: 'Respond to an x402 payment challenge',
    inputSchema: z.object({
      resource: z.string(),
      amount: z.string(),
      assetCode: z.string().optional(),
      assetIssuer: z.string().optional(),
      payTo: z.string(),
      nonce: z.string(),
      expiresAt: z.string(),
    }),
  },
  soroban_invoke: {
    name: 'soroban_invoke',
    description: 'Invoke a Soroban smart contract',
    inputSchema: z.object({
      contractId: z.string(),
      method: z.string(),
      args: z.array(z.unknown()),
      simulateOnly: z.boolean().optional(),
    }),
  },
  soroban_query: {
    name: 'soroban_query',
    description: 'Read-only query to a Soroban contract',
    inputSchema: z.object({
      contractId: z.string(),
      method: z.string(),
      args: z.array(z.unknown()).optional(),
    }),
  },
  account_info: {
    name: 'account_info',
    description: 'Get account balances and details',
    inputSchema: z.object({
      publicKey: z.string().optional(),
    }),
  },
  balance_check: {
    name: 'balance_check',
    description: 'Check balance for a specific asset',
    inputSchema: z.object({
      assetCode: z.string(),
      assetIssuer: z.string().optional(),
      publicKey: z.string().optional(),
    }),
  },
  path_payment: {
    name: 'path_payment',
    description: 'Cross-asset path payment through Stellar DEX',
    inputSchema: z.object({
      destination: z.string(),
      sendAsset: z.union([z.string(), z.object({ code: z.string(), issuer: z.string() })]),
      sendMax: z.string(),
      destAsset: z.union([z.string(), z.object({ code: z.string(), issuer: z.string() })]),
      destAmount: z.string(),
    }),
  },
  swap: {
    name: 'swap',
    description: 'Swap one asset for another via DEX',
    inputSchema: z.object({
      sellAsset: z.object({ code: z.string(), issuer: z.string().optional() }),
      buyAsset: z.object({ code: z.string(), issuer: z.string().optional() }),
      sellAmount: z.string(),
      maxSlippagePct: z.number().min(0).max(100),
    }),
  },
  offer_book: {
    name: 'offer_book',
    description: 'Query Stellar DEX order book',
    inputSchema: z.object({
      sellingAsset: z.union([z.string(), z.object({ code: z.string(), issuer: z.string().optional() })]),
      buyingAsset: z.union([z.string(), z.object({ code: z.string(), issuer: z.string().optional() })]),
      limit: z.number().min(1).max(200).optional(),
    }),
  },
  dex_offer: {
    name: 'dex_offer',
    description: 'Place, update, or delete a DEX offer',
    inputSchema: z.object({
      action: z.enum(['create', 'update', 'delete']),
      selling: z.object({ code: z.string(), issuer: z.string().optional() }),
      buying: z.object({ code: z.string(), issuer: z.string().optional() }),
      amount: z.string(),
      price: z.string(),
      offerId: z.union([z.string(), z.number()]).optional(),
    }),
  },
} as const;

// Read-only tools that can run during planning
const READONLY_TOOLS = new Set([
  'account_info',
  'balance_check',
  'soroban_query',
  'offer_book',
  'ledger_info',
  'network_status',
]);

/**
 * Prompt template for the planner.
 */
const PLANNER_PROMPT = `You are a financial planning assistant for the Stellar blockchain. 
Given a user request, produce a sequence of tasks to execute.

Available tools:
${Object.values(TOOL_SCHEMAS).map(t => `- ${t.name}: ${t.description}`).join('\n')}

Rules:
1. Only use value-moving tools (payment, swap, invoke) if explicitly requested
2. For financial swaps, first check the offer_book to find the best path
3. Validate all amounts are positive numbers
4. Output a JSON array of tasks, each with 'type' and 'payload'
5. Do NOT execute transactions during planning - only plan them

User request: {request}

Respond with JSON array of tasks:`;

/**
 * Parse LLM response into validated tasks.
 */
function parseTasks(response: string): AgentTask[] {
  try {
    const parsed = JSON.parse(response);
    const tasks = Array.isArray(parsed) ? parsed : [parsed];
    
    return tasks.map((task: { type: string; payload: unknown }) => {
      const taskType = task.type as TaskType;
      const schema = TOOL_SCHEMAS[taskType as keyof typeof TOOL_SCHEMAS];
      
      if (schema) {
        // Validate with schema
        const validated = schema.inputSchema.parse(task.payload);
        return { type: taskType, payload: validated };
      }
      
      // Unknown type - still include but won't be validated
      return { type: taskType, payload: task.payload };
    });
  } catch (err) {
    log.error({ error: err, response }, 'Failed to parse planner response');
    throw new Error('Failed to parse planner response');
  }
}

/**
 * Validate a task against policy.
 */
function validateTaskPolicy(task: AgentTask): { valid: boolean; reason?: string } {
  // Check if value-moving tool is being used during planning
  if (VALUE_MOVING_TASK_TYPES.has(task.type)) {
    return { valid: false, reason: `Value-moving tool ${task.type} cannot execute during planning` };
  }
  
  // Validate task type is known
  const knownTypes = Object.keys(TOOL_SCHEMAS);
  if (!knownTypes.includes(task.type) && !READONLY_TOOLS.has(task.type)) {
    return { valid: false, reason: `Unknown task type: ${task.type}` };
  }
  
  return { valid: true };
}

/**
 * Planner class - generates structured plans from natural language.
 */
export class Planner {
  private agent: PayFiAgent;
  private llmEndpoint?: string;
  private llmApiKey?: string;

  constructor(agent: PayFiAgent, options: { llmEndpoint?: string; llmApiKey?: string } = {}) {
    this.agent = agent;
    this.llmEndpoint = options.llmEndpoint ?? process.env.LLM_ENDPOINT;
    this.llmApiKey = options.llmApiKey ?? process.env.LLM_API_KEY;
  }

  /**
   * Generate a plan from natural language request.
   * 
   * @param request - User's request in natural language
   * @param options.runReadonly - Whether to run read-only tools during planning (default: true)
   */
  async plan(request: string, options: { runReadonly?: boolean } = {}): Promise<Plan> {
    const { runReadonly = true } = options;
    
    log.info({ request }, 'Generating plan');
    
    // Build prompt
    const prompt = PLANNER_PROMPT.replace('{request}', request);
    
    // Call LLM
    let tasks: AgentTask[];
    
    if (this.llmEndpoint) {
      tasks = await this.callLLM(prompt);
    } else {
      // No LLM configured - return empty plan
      throw new Error('LLM not configured. Set LLM_ENDPOINT environment variable.');
    }
    
    // Validate each task
    const validatedTasks: AgentTask[] = [];
    for (const task of tasks) {
      const policy = validateTaskPolicy(task);
      if (!policy.valid) {
        log.warn({ taskType: task.type, reason: policy.reason }, 'Task failed policy check');
        continue;
      }
      
      // Run read-only tools during planning if enabled
      if (runReadonly && READONLY_TOOLS.has(task.type)) {
        try {
          const result = await this.agent.run(task);
          if (result.success) {
            log.debug({ taskType: task.type, data: result.data }, 'Read-only tool executed during planning');
          }
        } catch (err) {
          log.warn({ taskType: task.type, error: err }, 'Read-only tool failed during planning');
        }
      }
      
      validatedTasks.push(task);
    }
    
    // Create plan
    const plan: Plan = {
      id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      tasks: validatedTasks,
      summary: validatedTasks.map(t => `${t.type}`).join('; '),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    };
    
    log.info({ planId: plan.id, taskCount: validatedTasks.length }, 'Plan generated');
    return plan;
  }

  /**
   * Call LLM endpoint with prompt.
   */
  private async callLLM(prompt: string): Promise<AgentTask[]> {
    if (!this.llmEndpoint) {
      throw new Error('LLM endpoint not configured');
    }

    const response = await fetch(this.llmEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.llmApiKey ? { 'Authorization': `Bearer ${this.llmApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL ?? 'gpt-4',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM call failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? '';
    
    return parseTasks(content);
  }
}

export { PayFiAgent, AgentTask, Plan, TaskType };