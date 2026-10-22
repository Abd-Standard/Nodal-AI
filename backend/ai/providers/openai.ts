/**
 * backend/ai/providers/openai.ts
 *
 * OpenAI adapter implementing the LLMProvider interface.
 * Supports GPT-4, GPT-4o, GPT-4o-mini, and OpenAI-compatible APIs.
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

const log = createLogger('llm:openai');

// ─── OpenAI-specific types ─────────────────────────────────────────────────

interface OpenAIMessage {
  role: Message['role'];
  content: string;
  name?: string;
  tool_call_id?: string;
}

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// ─── OpenAI Provider ───────────────────────────────────────────────────────

export class OpenAIProvider implements LLMProvider {
  readonly providerName = 'openai';
  readonly defaultModel = 'gpt-4o';

  private readonly client: AxiosInstance;
  private readonly config: LLMConfig;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;

  constructor(config: LLMConfig) {
    this.config = config;
    this.maxRetries = config.maxRetries ?? 3;
    this.timeoutMs = config.timeoutMs ?? 60_000;

    const baseURL = config.baseUrl || 'https://api.openai.com/v1';

    this.client = axios.create({
      baseURL,
      timeout: this.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
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
        'OpenAI API key not configured'
      );
    }

    const model = options.responseFormat?.type === 'json_object' 
      ? 'gpt-4o'  // JSON mode works best with gpt-4o
      : this.config.model || this.defaultModel;

    const startTime = Date.now();

    // Convert messages to OpenAI format
    const openAIMessages: OpenAIMessage[] = messages.map((msg) => ({
      role: msg.role,
      content: msg.content,
      name: msg.name,
      tool_call_id: msg.tool_call_id,
    }));

    // Build request payload
    const payload: Record<string, unknown> = {
      model,
      messages: openAIMessages,
      temperature: options.temperature,
      max_tokens: options.maxTokens,
      top_p: options.topP,
      frequency_penalty: options.frequencyPenalty,
      presence_penalty: options.presencePenalty,
      stop: options.stop,
      n: options.n,
    };

    // Add tools if provided
    if (options.tools && options.tools.length > 0) {
      payload.tools = options.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        },
      }));
    }

    // Add tool choice if provided
    if (options.toolChoice) {
      if (options.toolChoice.type === 'none') {
        payload.tool_choice = 'none';
      } else if (options.toolChoice.type === 'tool') {
        payload.tool_choice = {
          type: 'function',
          function: { name: options.toolChoice.name },
        };
      }
      // 'auto' is the default, no need to specify
    }

    // Add response format for structured output
    if (options.responseFormat) {
      payload.response_format = options.responseFormat;
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
            'OpenAI request failed, retrying...'
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

  private async makeRequest(
    payload: Record<string, unknown>,
    startTime: number
  ): Promise<GenerationResponse> {
    try {
      const response = await this.client.post<OpenAIResponse>('/chat/completions', payload);

      const data = response.data;
      const latencyMs = Date.now() - startTime;

      // Extract the first choice (we don't generate multiple by default)
      const choice = data.choices[0];
      if (!choice) {
        throw new LLMError(
          'server_error',
          this.providerName,
          'No completion choice returned'
        );
      }

      // Convert tool calls
      const toolCalls = choice.message.tool_calls?.map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: tc.function.arguments,
      }));

      return {
        content: choice.message.content || '',
        model: data.model,
        finishReason: this.mapFinishReason(choice.finish_reason),
        toolCalls,
        usage: {
          promptTokens: data.usage.prompt_tokens,
          completionTokens: data.usage.completion_tokens,
          totalTokens: data.usage.total_tokens,
        },
        latencyMs,
      };
    } catch (err) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        const message = err.response?.data?.error?.message || err.message;

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
      case 'stop':
        return 'stop';
      case 'length':
        return 'length';
      case 'tool_calls':
        return 'tool_calls';
      case 'content_filter':
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

export function createOpenAIProvider(config: LLMConfig): LLMProvider {
  log.info(
    { model: config.model || 'gpt-4o', baseUrl: config.baseUrl || 'default' },
    'Creating OpenAI provider'
  );

  // Verify API key is not logged
  if (config.apiKey) {
    log.debug({ apiKeyRedacted: redactApiKey(config.apiKey) }, 'OpenAI provider configured');
  }

  return new OpenAIProvider(config);
}