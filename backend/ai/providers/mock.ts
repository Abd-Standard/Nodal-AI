/**
 * backend/ai/providers/mock.ts
 *
 * Mock LLM provider for testing.
 * Returns predefined responses without making any network calls.
 */

import {
  LLMProvider,
  Message,
  GenerationOptions,
  GenerationResponse,
  LLMError,
  LLMConfig,
} from '../types';
import { createLogger } from '../../utils/logger';

const log = createLogger('llm:mock');

// ─── Mock Response Configuration ───────────────────────────────────────────

export interface MockResponse {
  /** Text to return as the response */
  content: string;
  /** Optional tool calls to return */
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: Record<string, unknown>;
  }>;
  /** Optional delay in ms before responding */
  delayMs?: number;
  /** Optional finish reason */
  finishReason?: GenerationResponse['finishReason'];
}

/**
 * Default mock responses for common scenarios.
 */
export const DEFAULT_MOCK_RESPONSES: Record<string, MockResponse> = {
  // Simple text response
  default: {
    content: 'I understand your request. How can I help you with Stellar payments?',
    finishReason: 'stop',
  },

  // Tool call responses
  stellar_payment: {
    content: 'I will execute a Stellar payment.',
    toolCalls: [
      {
        id: 'call_123',
        name: 'stellar_payment',
        arguments: {
          destination: 'GABCD123EFGH456IJKL789',
          amount: '10',
          asset: 'XLM',
        },
      },
    ],
    finishReason: 'tool_calls',
  },

  balance_check: {
    content: 'Let me check the account balance.',
    toolCalls: [
      {
        id: 'call_456',
        name: 'balance_check',
        arguments: {
          publicKey: 'GABCD123EFGH456IJKL789',
        },
      },
    ],
    finishReason: 'tool_calls',
  },

  // Error responses
  error: {
    content: 'I encountered an error processing your request.',
    finishReason: 'stop',
  },
};

// ─── Mock Provider ─────────────────────────────────────────────────────────

export class MockProvider implements LLMProvider {
  readonly providerName = 'mock';
  readonly defaultModel = 'mock-model';

  private readonly responses: Map<string, MockResponse>;
  private readonly defaultResponse: MockResponse;
  private callCount = 0;

  constructor(
    config: LLMConfig,
    responses?: Record<string, MockResponse>,
    defaultResponse?: MockResponse
  ) {
    this.responses = new Map(Object.entries(responses || DEFAULT_MOCK_RESPONSES));
    this.defaultResponse = defaultResponse || DEFAULT_MOCK_RESPONSES.default;
  }

  isConfigured(): boolean {
    // Mock is always "configured"
    return true;
  }

  async generate(
    messages: Message[],
    options: GenerationOptions = {}
  ): Promise<GenerationResponse> {
    this.callCount++;
    const startTime = Date.now();

    // Get the last user message for response matching
    const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
    const userContent = lastUserMessage?.content.toLowerCase() || '';

    // Try to find a matching response
    let response = this.defaultResponse;

    for (const [key, mockResponse] of this.responses) {
      if (userContent.includes(key.toLowerCase().replace(/_/g, ' '))) {
        response = mockResponse;
        break;
      }
    }

    // Apply any configured delay
    if (response.delayMs) {
      await new Promise((resolve) => setTimeout(resolve, response.delayMs));
    }

    const latencyMs = Date.now() - startTime;

    // Build response
    const result: GenerationResponse = {
      content: response.content,
      model: this.defaultModel,
      finishReason: response.finishReason || 'stop',
      usage: {
        promptTokens: this.estimateTokens(messages),
        completionTokens: this.estimateTokens([{ role: 'assistant', content: response.content }]),
        totalTokens: 0,
      },
      latencyMs,
    };

    result.usage.totalTokens = result.usage.promptTokens + result.usage.completionTokens;

    // Add tool calls if present
    if (response.toolCalls) {
      result.toolCalls = response.toolCalls.map((tc) => ({
        id: tc.id,
        name: tc.name,
        arguments: JSON.stringify(tc.arguments),
      }));
    }

    log.debug(
      {
        callCount: this.callCount,
        userMessage: lastUserMessage?.content.slice(0, 50),
        finishReason: result.finishReason,
        latencyMs,
      },
      'Mock provider generated response'
    );

    return result;
  }

  /**
   * Get the number of times generate() has been called.
   * Useful for testing to verify the mock was invoked.
   */
  getCallCount(): number {
    return this.callCount;
  }

  /**
   * Reset the call counter.
   */
  reset(): void {
    this.callCount = 0;
  }

  /**
   * Add a custom response for a specific trigger.
   */
  addResponse(trigger: string, response: MockResponse): void {
    this.responses.set(trigger, response);
  }

  /**
   * Clear all custom responses, reverting to defaults.
   */
  clearCustomResponses(): void {
    this.responses.clear();
    // Re-add default responses
    Object.entries(DEFAULT_MOCK_RESPONSES).forEach(([key, value]) => {
      this.responses.set(key, value);
    });
  }

  private estimateTokens(messages: Message[]): number {
    // Rough estimate: ~4 characters per token
    const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
    return Math.ceil(totalChars / 4);
  }
}

// ─── Factory Function ───────────────────────────────────────────────────────

export function createMockProvider(
  config: LLMConfig,
  responses?: Record<string, MockResponse>,
  defaultResponse?: MockResponse
): LLMProvider {
  log.info('Creating mock LLM provider');

  return new MockProvider(config, responses, defaultResponse);
}

// ─── Test Helpers ───────────────────────────────────────────────────────────

/**
 * Creates a mock provider pre-configured for testing.
 * Includes common test responses.
 */
export function createTestMockProvider(): MockProvider {
  const testConfig: LLMConfig = {
    provider: 'mock',
    model: 'test-model',
    apiKey: 'test-key-for-mocking',
  };

  return new MockProvider(testConfig, {
    payment: {
      content: 'Processing payment request.',
      toolCalls: [
        {
          id: 'test_call_1',
          name: 'stellar_payment',
          arguments: {
            destination: 'GTEST123456789012345678',
            amount: '10',
            asset: 'XLM',
          },
        },
      ],
      finishReason: 'tool_calls',
    },
    balance: {
      content: 'Checking balance.',
      toolCalls: [
        {
          id: 'test_call_2',
          name: 'balance_check',
          arguments: {
            publicKey: 'GTEST123456789012345678',
          },
        },
      ],
      finishReason: 'tool_calls',
    },
    empty: {
      content: '',
      finishReason: 'stop',
    },
  });
}