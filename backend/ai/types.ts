/**
 * backend/ai/types.ts
 *
 * Provider-agnostic LLM interface types.
 * Defines the contract for LLM adapters so the planner doesn't depend on one vendor.
 *
 * Supported providers:
 * - OpenAI (gpt-4, gpt-4o, gpt-4o-mini, etc.)
 * - Anthropic (claude-3-opus, claude-3-sonnet, claude-3-haiku, etc.)
 * - Mock (for testing)
 */

import { z } from 'zod';

// ─── Message Types ───────────────────────────────────────────────────────────

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface Message {
  role: MessageRole;
  content: string;
  /** Optional tool call identifier */
  tool_call_id?: string;
  /** Optional tool name (for tool role messages) */
  name?: string;
}

// ─── Tool Calling Types ─────────────────────────────────────────────────────

export interface ToolDefinition {
  /** Tool name */
  name: string;
  /** Tool description */
  description: string;
  /** JSON Schema for tool input */
  parameters: Record<string, unknown>;
}

export type ToolChoice = 
  | { type: 'none' }
  | { type: 'auto' }
  | { type: 'tool'; name: string };

// ─── Generation Options ──────────────────────────────────────────────────────

export interface GenerationOptions {
  /** Maximum tokens to generate */
  maxTokens?: number;
  /** Sampling temperature (0-2) */
  temperature?: number;
  /** Nucleus sampling threshold */
  topP?: number;
  /** Frequency penalty */
  frequencyPenalty?: number;
  /** Presence penalty */
  presencePenalty?: number;
  /** Stop sequences */
  stop?: string[];
  /** Tool definitions available to the model */
  tools?: ToolDefinition[];
  /** Which tool to force the model to use */
  toolChoice?: ToolChoice;
  /** Number of completions to generate */
  n?: number;
  /** Response format (for structured outputs) */
  responseFormat?: { type: 'json_object' };
}

// ─── Generation Response ─────────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string of arguments
}

export interface GenerationResponse {
  /** Generated text content */
  content: string;
  /** Model that generated the response */
  model: string;
  /** Finish reason */
  finishReason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
  /** Tool calls if the model requested function execution */
  toolCalls?: ToolCall[];
  /** Usage statistics */
  usage: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  /** Response latency in milliseconds */
  latencyMs: number;
}

// ─── LLM Provider Interface ─────────────────────────────────────────────────

/**
 * Core LLM provider interface.
 * Implement this for each LLM vendor (OpenAI, Anthropic, etc.)
 */
export interface LLMProvider {
  /**
   * Generate a completion from the LLM.
   *
   * @param messages - Conversation history (system + user + assistant + tool)
   * @param options - Generation options
   * @returns LLM response with content and metadata
   */
  generate(
    messages: Message[],
    options?: GenerationOptions
  ): Promise<GenerationResponse>;

  /**
   * The provider name (e.g., 'openai', 'anthropic')
   */
  readonly providerName: string;

  /**
   * The default model used by this provider
   */
  readonly defaultModel: string;

  /**
   * Check if the provider is properly configured
   */
  isConfigured(): boolean;
}

// ─── Provider Configuration ─────────────────────────────────────────────────

export const LLMProviderSchema = z.enum(['openai', 'anthropic', 'mock']);

export type LLMProviderType = z.infer<typeof LLMProviderSchema>;

export interface LLMConfig {
  /** Provider to use (openai, anthropic, mock) */
  provider: LLMProviderType;
  /** Model identifier (e.g., 'gpt-4o', 'claude-3-sonnet-20240229') */
  model: string;
  /** API key for the provider (secret-managed) */
  apiKey: string;
  /** Optional base URL for OpenAI-compatible APIs */
  baseUrl?: string;
  /** Request timeout in milliseconds */
  timeoutMs?: number;
  /** Maximum retries for transient failures */
  maxRetries?: number;
}

// ─── Token Usage Tracking ───────────────────────────────────────────────────

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  timestamp: number;
}

export interface SessionTokenUsage {
  sessionId: string;
  requests: TokenUsage[];
  totalUsage: TokenUsage;
}

// ─── Error Types ─────────────────────────────────────────────────────────────

export class LLMError extends Error {
  readonly kind: 'configuration' | 'rate_limit' | 'invalid_request' | 'server_error' | 'network_error' | 'timeout';
  readonly provider: string;
  readonly statusCode?: number;
  readonly isRetryable: boolean;

  constructor(
    kind: LLMError['kind'],
    provider: string,
    message: string,
    options?: {
      statusCode?: number;
      isRetryable?: boolean;
    }
  ) {
    super(message);
    this.name = 'LLMError';
    this.kind = kind;
    this.provider = provider;
    this.statusCode = options?.statusCode;
    this.isRetryable = options?.isRetryable ?? (kind === 'rate_limit' || kind === 'network_error' || kind === 'timeout');
    Object.setPrototypeOf(this, LLMError.prototype);
  }
}

// ─── Utility Types ──────────────────────────────────────────────────────────

/**
 * Factory function to create an LLM provider from config.
 */
export type LLMProviderFactory = (config: LLMConfig) => LLMProvider;

/**
 * Registry of available LLM providers.
 */
export interface LLMProviderRegistry {
  [key: string]: LLMProviderFactory;
}

// ─── Validation Helpers ─────────────────────────────────────────────────────

/**
 * Validates that an API key doesn't appear in logs.
 * Returns true if the key is safe to log (redacted).
 */
export function isSafeToLogApiKey(key: string): boolean {
  // Keys should never be logged directly
  // This function documents the expectation
  return false;
}

/**
 * Redacts an API key for safe logging.
 */
export function redactApiKey(key: string): string {
  if (!key || key.length < 8) return '[INVALID]';
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}