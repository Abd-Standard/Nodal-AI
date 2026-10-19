/**
 * backend/mcp/server.ts
 * 
 * Model Context Protocol (MCP) server for Nodal AI.
 * Exposes tools over stdio and HTTP transports.
 */

import { PayFiAgent, VALUE_MOVING_TASK_TYPES } from '../agent';
import { createLogger } from '../utils/logger';

const log = createLogger('mcp');

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: object;
  valueMoving: boolean;
}

export interface MCPRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: object;
}

export interface MCPResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Build tool schema for MCP from agent tools.
 * Read-only tools exposed by default; value-moving require MCP_ALLOW_PAYMENTS.
 */
function getMCPTools(agent: PayFiAgent): MCPTool[] {
  const allowPayments = process.env.MCP_ALLOW_PAYMENTS === 'true';
  
  return agent.getTools().map(tool => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
    valueMoving: tool.valueMoving,
  })).filter(tool => {
    if (!tool.valueMoving) return true;
    return allowPayments;
  });
}

function toolToMCPSchema(tool: MCPTool): object {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

/**
 * Handle MCP request and return response.
 */
async function handleRequest(agent: PayFiAgent, request: MCPRequest): Promise<MCPResponse> {
  const { id } = request;

  try {
    switch (request.method) {
      case 'initialize': {
        const tools = getMCPTools(agent);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'nodal-ai', version: '1.0.0' },
            tools: tools.map(toolToMCPSchema),
          },
        };
      }

      case 'tools/list': {
        const tools = getMCPTools(agent);
        return { jsonrpc: '2.0', id, result: { tools: tools.map(toolToMCPSchema) } };
      }

      case 'tools/call': {
        const params = request.params as { name: string; arguments?: object };
        const toolName = params.name;
        const args = params.arguments ?? {};

        const tools = getMCPTools(agent);
        const tool = tools.find(t => t.name === toolName);
        
        if (!tool) {
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Tool not found: ${toolName}` } };
        }

        if (tool.valueMoving && !VALUE_MOVING_TASK_TYPES.has(toolName as any)) {
          // Additional check handled by filter
        }

        const result = await agent.run({ type: toolName, payload: args });

        if (!result.success) {
          return { jsonrpc: '2.0', id, error: { code: -32000, message: result.error ?? 'Execution failed' } };
        }

        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result.data) }] } };
      }

      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${request.method}` } };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ method: request.method, error: message }, 'MCP request failed');
    return { jsonrpc: '2.0', id, error: { code: -32000, message } };
  }
}

/**
 * Run MCP server over stdio (for AI clients like Claude Desktop).
 */
export async function startMCPServer(agent: PayFiAgent): Promise<void> {
  log.info('Starting MCP stdio server');

  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });

  let buffer = '';

  rl.on('line', async (line) => {
    buffer += line;
    try {
      const request = JSON.parse(buffer) as MCPRequest;
      buffer = '';
      const response = await handleRequest(agent, request);
      process.stdout.write(JSON.stringify(response) + '\n');
    } catch {
      // Incomplete JSON, wait for more
    }
  });

  rl.on('error', (err) => log.error({ error: err.message }, 'MCP stdin error'));
}

/**
 * Start MCP server over HTTP.
 */
import express from 'express';

export function startMCPHTTPServer(agent: PayFiAgent, port = 3001): void {
  const app = express();
  app.use(express.json());

  app.post('/mcp', async (req, res) => {
    const response = await handleRequest(agent, req.body as MCPRequest);
    res.json(response);
  });

  app.get('/mcp/tools', async (req, res) => {
    const tools = getMCPTools(agent);
    res.json({ tools: tools.map(toolToMCPSchema) });
  });

  app.listen(port, () => log.info({ port }, 'MCP HTTP server started'));
}