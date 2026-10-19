/**
 * backend/ai/providers/anthropic.ts
 *
 * Anthropic adapter implementing the LLMProvider interface.
 * Supports Claude 3 (Opus, Sonnet, Haiku) models.
 */

import axios, { AxiosInstance } from 'axios';
import {
  LLMProvider,
  Message,
  GenerationOptions,
  GenerationResponse,
  ToolDefinition,
  ToolChoice,
  LLMError,
  LLMConfig,
  redactApiKey,
} from '../types';
import { createLogger } from '../../utils/logger';

const log = createLogger('llm:anthropic');

// ─── Anthropic-specific types ───────────────────────────────────────────────

interface AnthropicMessage {
  role: Message['role'];
  content: string | Array<AnthropicContentBlock>;
  name?: string;
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface AnthropicResponse {
  id: string;
  type: string;
  role: string;
  content: Array<AnthropicContentBlock>;
  model: string;
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// ─── Anthropic Provider ─────────────────────────────────────────────────────

export class AnthropicProvider implements LLMProvider {
  readonly providerName = 'anthropic';
  readonly defaultModel = 'claude-3-sonnet-20240229';

  private readonly client: AxiosInstance;
  private readonly config: LLMConfig;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(config: LLMConfig) {
    this.config = config;
    this.maxRetries = config.maxRetries ?? 3;
    this.timeoutMs = config.timeoutMs ?? 60_000;

    this.client = axios.create({
      baseURL: 'https://api.anthropic.com/v1',
      timeout: this.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
    });
  }

  isConfigured(): boolean {
    return !!this.config.apiKey && this.config.apiKey.length > 0;
  }

  async generate(
    messages: Message[],
    options: GenerationOptions = {}
  ): Promise<GenerationResponse> {
    if (!this.isConfigured()) {
      throw new LLMError(
        'configuration',
        this.providerName,
        'Anthropic API key not configured'
      );
    }

    const model = this.config.model || this.defaultModel;
    const startTime = Date.now();

    // Convert messages to Anthropic format
    // Anthropic requires the first message to be system (if present)
    const anthropicMessages = this.convertMessages(messages);

    // Build request payload
    const payload: Record<string, unknown> = {
      model,
      messages: anthropicMessages,
      max_tokens: options.maxTokens || 4096,
      temperature: options.temperature,
      top_p: options.topP,
      top_k: options.topP ? undefined : undefined, // Anthropic uses top_p only
      stop_sequences: options.stop,
    };

    // Add tools if provided
    if (options.tools && options.tools.length > 0) {
      payload.tools = options.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: {
          type: 'object',
          properties: tool.parameters.properties || {},
          required: tool.parameters.required || [],
        },
      }));
    }

    // Handle tool choice for Anthropic
    // Note: Anthropic handles tool choice differently - it uses tool_choice parameter
    if (options.toolChoice) {
      if (options.toolChoice.type === 'none') {
        // Anthropic doesn't have a direct "none" option for tool_choice
        // We handle this by not passing tools when none is requested
      } else if (options.toolChoice.type === 'tool') {
        // Force a specific tool
        payload.tool_choice = {
          type: 'tool',
          name: options.toolChoice.name,
        };
      }
      // 'auto' is the default - no tool_choice needed
    }

    // Retry loop with exponential backoff
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const response = await this.makeRequest(payload, startTime);
        return response;
      } catch (err) {
        lastError = err as Error;

        // Check if error is retryable
        if (err instanceof LLMError && err.isRetryable) {
          const delay = this.calculateBackoff(attempt);
          log.warn(
            {
              attempt,
              maxRetries: this.maxRetries,
              delay,
              error: err.message,
            },
            'Anthropic request failed, retrying...'
          );
          await this.sleep(delay);
          continue;
        }

        // Non-retryable error, throw immediately
        throw err;
      }
    }

    // All retries exhausted
    throw lastError || new LLMError(
      'server_error',
      this.providerName,
      'Max retries exhausted'
    );
  }

  private convertMessages(messages: Message[]): AnthropicMessage[] {
    const result: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        // Anthropic handles system messages differently
        // We'll prepend to the first user message or add as first message
        result.push({
          role: 'user',
          content: `[SYSTEM INSTRUCTION]\n${msg.content}`,
        });
      } else if (msg.role === 'tool') {
        // Tool results are represented as tool_result content blocks
        result.push({
          role: 'user',
          content: [
            {
              type: 'tool_result' as const,
              tool_use_id: msg.tool_call_id || 'unknown',
              content: msg.content,
            },
          ],
        });
      } else {
        result.push({
          role: msg.role,
          content: msg.content,
          name: msg.name,
        });
      }
    }

    return result;
  }

  private async makeRequest(
    payload: Record<string, unknown>,
    startTime: number
  ): Promise<GenerationResponse> {
    try {
      const response = await this.client.post<AnthropicResponse>('/messages', payload);

      const data = response.data;
      const latencyMs = Date.now() - startTime;

      // Extract text content
      let content = '';
      const toolCalls: GenerationResponse['toolCalls'] = [];

      for (const block of data.content) {
        if (block.type === 'text') {
          content += block.text;
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input),
          });
        }
      }

      return {
        content,
        model: data.model,
        finishReason: this.mapFinishReason(data.stop_reason),
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        usage: {
          promptTokens: data.usage.input_tokens,
          completionTokens: data.usage.output_tokens,
          totalTokens: data.usage.input_tokens + data.usage.output_tokens,
        },
        latencyMs,
      };
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        const errorData = err.response?.data?.error;
        const message = errorData?.message || err.message;

        if (status === 401) {
          throw new LLMError('configuration', this.providerName, `Authentication failed: ${message}`, {
            statusCode: status,
            isRetryable: false,
          });
        }

        if (status === 429) {
          throw new LLMError('rate_limit', this.providerName, `Rate limited: ${message}`, {
            statusCode: status,
            isRetryable: true,
          });
        }

        if (status && status >= 500) {
          throw new LLMError('server_error', this.providerName, `Server error: ${message}`, {
            statusCode: status,
            isRetryable: true,
          });
        }

        if (err.code === 'ECONNABORTED') {
          throw new LLMError('timeout', this.providerName, 'Request timed out', {
            isRetryable: true,
          });
        }

        // Handle Anthropic-specific errors
        if (errorData?.type === 'rate_limit_error') {
          throw new LLMError('rate_limit', this.providerName, `Rate limit: ${message}`, {
            statusCode: status,
            isRetryable: true,
          });
        }

        throw new LLMError('invalid_request', this.providerName, message, {
          statusCode: status,
        });
      }

      throw err;
    }
  }

  private mapFinishReason(
    reason: string | null
  ): GenerationResponse['finishReason'] {
    switch (reason) {
      case 'end_turn':
        return 'stop';
      case 'max_tokens':
        return 'length';
      case 'tool_use':
        return 'tool_calls';
      case 'content_filtered':
        return 'content_filter';
      default:
        return null;
    }
  }

  private calculateBackoff(attempt: number): number {
    // Exponential backoff: 1s, 2s, 4s, 8s, etc. (capped at 30s)
    // Plus ±20% random jitter
    const baseDelay = Math.min(1000 * Math.pow(2, attempt), 30_000);
    const jitter = baseDelay * 0.2 * (Math.random() * 2 - 1);
    return Math.floor(baseDelay + jitter);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ─── Factory Function ───────────────────────────────────────────────────────

export function createAnthropicProvider(config: LLMConfig): LLMProvider {
  log.info(
    { model: config.model || 'claude-3-sonnet-20240229' },
    'Creating Anthropic provider'
  );

  // Verify API key is not logged
  if (config.apiKey) {
    log.debug({ apiKeyRedacted: redactApiKey(config.apiKey) }, 'Anthropic provider configured');
  }

  return new AnthropicProvider(config);
}