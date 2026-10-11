import { OpenAiProvider } from './openaiProvider.js';
import { MockProvider } from './mockProvider.js';
import { AppError } from '../utils/errors.js';

/**
 * Provider factory.
 *
 * Every provider implements the same four-method contract:
 *   planTask(), validateProviderConfig(), getProviderHealth(), normalizeProviderError()
 */
export function buildProvider(config) {
  if (config.ai.provider === 'openai' || config.ai.provider === 'openai_compatible') {
    return new OpenAiProvider({
      apiKey: config.ai.apiKey,
      model: config.ai.model,
      baseUrl: config.ai.baseUrl,
      timeoutMs: config.ai.timeoutMs,
      maxRetries: config.ai.maxRetries,
      reasoningEffort: config.ai.reasoningEffort,
      label: config.ai.provider === 'openai_compatible' ? 'openai_compatible' : 'openai',
    });
  }

  if (config.ai.provider === 'none') {
    return new UnconfiguredProvider();
  }

  if (config.ai.provider === 'mock') {
    if (config.isProduction) {
      throw new AppError('AI_PROVIDER_NOT_CONFIGURED', {
        message: 'AI_PROVIDER=mock is not allowed in production.',
      });
    }
    return new MockProvider({ model: 'mock-planner-v1' });
  }

  throw new AppError('AI_PROVIDER_NOT_CONFIGURED', {
    message: `Unknown AI_PROVIDER "${config.ai.provider}".`,
  });
}

/**
 * Placeholder used when no provider is configured.
 *
 * It fails loudly and precisely instead of pretending to plan, which keeps the
 * "no fabricated success" rule intact.
 */
class UnconfiguredProvider {
  constructor() {
    this.name = 'none';
    this.model = '';
  }

  get configured() {
    return false;
  }

  validateProviderConfig() {
    return {
      ok: false,
      issues: [
        'No AI provider is configured. Set AI_PROVIDER=openai plus OPENAI_API_KEY and OPENAI_MODEL in the hosting environment.',
      ],
    };
  }

  async getProviderHealth() {
    return {
      provider: 'none',
      configured: false,
      model: null,
      reachable: false,
      model_available: false,
      issues: this.validateProviderConfig().issues,
    };
  }

  async planTask() {
    throw new AppError('AI_PROVIDER_NOT_CONFIGURED');
  }

  normalizeProviderError(error) {
    return error instanceof AppError ? error : new AppError('AI_PROVIDER_NOT_CONFIGURED');
  }
}

export { OpenAiProvider, MockProvider };
