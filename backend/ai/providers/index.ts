/**
 * backend/ai/providers/index.ts
 *
 * LLM provider registry and factory.
 * Creates the appropriate LLM provider based on configuration.
 */

import { LLMProvider, LLMConfig, LLMProviderType, LLMError } from '../types';
import { createOpenAIProvider } from './openai';
import { createAnthropicProvider } from './anthropic';
import { createMockProvider } from './mock';
import { createLogger } from '../../utils/logger';

const log = createLogger('llm:providers');

// ─── Provider Registry ─────────────────────────────────────────────────────

const PROVIDER_FACTORIES: Record<LLMProviderType, (config: LLMConfig) => LLMProvider> = {
  openai: createOpenAIProvider,
  anthropic: createAnthropicProvider,
  mock: createMockProvider,
};

// ─── Factory Function ───────────────────────────────────────────────────────

/**
 * Creates an LLM provider based on the configuration.
 *
 * @param config - The LLM configuration
 * @returns A configured LLM provider instance
 * @throws {LLMError} If the provider type is unknown or not configured
 */
export function createLLMProvider(config: LLMConfig): LLMProvider {
  const { provider } = config;

  const factory = PROVIDER_FACTORIES[provider];
  if (!factory) {
    throw new LLMError(
      'configuration',
      'provider-registry',
      `Unknown LLM provider: ${provider}. Supported: openai, anthropic, mock`
    );
  }

  log.info({ provider }, 'Creating LLM provider');

  const providerInstance = factory(config);

  if (!providerInstance.isConfigured()) {
    throw new LLMError(
      'configuration',
      provider,
      `Provider ${provider} is not properly configured. Check API key.`
    );
  }

  return providerInstance;
}

// ─── Provider Info ──────────────────────────────────────────────────────────

export interface ProviderInfo {
  name: LLMProviderType;
  displayName: string;
  defaultModel: string;
  supportsTools: boolean;
  supportsJsonMode: boolean;
  supportsVision: boolean;
}

/**
 * Information about each supported provider.
 */
export const PROVIDER_INFO: Record<LLMProviderType, ProviderInfo> = {
  openai: {
    name: 'openai',
    displayName: 'OpenAI',
    defaultModel: 'gpt-4o',
    supportsTools: true,
    supportsJsonMode: true,
    supportsVision: true,
  },
  anthropic: {
    name: 'anthropic',
    displayName: 'Anthropic',
    defaultModel: 'claude-3-sonnet-20240229',
    supportsTools: true,
    supportsJsonMode: false,
    supportsVision: true,
  },
  mock: {
    name: 'mock',
    displayName: 'Mock (Testing)',
    defaultModel: 'mock-model',
    supportsTools: true,
    supportsJsonMode: true,
    supportsVision: false,
  },
};

/**
 * Returns information about all available providers.
 */
export function getAvailableProviders(): ProviderInfo[] {
  return Object.values(PROVIDER_INFO);
}

/**
 * Returns information about a specific provider.
 */
export function getProviderInfo(provider: LLMProviderType): ProviderInfo | undefined {
  return PROVIDER_INFO[provider];
}

// ─── Exports ────────────────────────────────────────────────────────────────

export { createOpenAIProvider } from './openai';
export { createAnthropicProvider } from './anthropic';
export { createMockProvider, MockProvider } from './mock';
export type { MockResponse } from './mock';