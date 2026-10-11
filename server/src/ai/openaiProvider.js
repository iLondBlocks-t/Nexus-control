import { AppError } from '../utils/errors.js';
import { getLogger } from '../logging/logger.js';

/**
 * OpenAI (and OpenAI-compatible) Chat Completions adapter.
 *
 * Uses only the platform `fetch` with an explicit timeout and bounded retries.
 * The API key is read from configuration at call time and is never logged.
 *
 * Verified against the official documentation:
 *  - https://developers.openai.com/api/docs/changelog
 *  - https://developers.openai.com/api/docs/guides/latest-model
 * Current default model: gpt-6.1-sol (Chat Completions supported).
 */

const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffDelay(attempt, retryAfterMs) {
  if (retryAfterMs && Number.isFinite(retryAfterMs)) return Math.min(retryAfterMs, 10000);
  const base = Math.min(2000 * 2 ** attempt, 10000);
  return Math.round(base / 2 + Math.random() * (base / 2));
}

function parseRetryAfter(headerValue) {
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return null;
}

export class OpenAiProvider {
  /**
   * @param {{apiKey: string, model: string, baseUrl: string, timeoutMs: number,
   *          maxRetries: number, reasoningEffort?: string, label?: string}} options
   */
  constructor(options) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries;
    this.reasoningEffort = options.reasoningEffort;
    this.name = options.label ?? 'openai';
    this.logger = getLogger({ component: 'ai' });
  }

  /** @returns {{ok: boolean, issues: string[]}} */
  validateProviderConfig() {
    const issues = [];
    if (!this.apiKey) issues.push('OPENAI_API_KEY is empty.');
    if (!this.model) issues.push('OPENAI_MODEL is empty.');
    if (!/^https?:\/\//.test(this.baseUrl)) issues.push('OPENAI_BASE_URL must be an absolute http(s) URL.');
    return { ok: issues.length === 0, issues };
  }

  get configured() {
    return this.validateProviderConfig().ok;
  }

  /**
   * Configuration-only health check. `live` additionally calls the provider's
   * models endpoint to confirm the key works; it never prints the key.
   */
  async getProviderHealth({ live = false } = {}) {
    const validation = this.validateProviderConfig();
    const health = {
      provider: this.name,
      configured: validation.ok,
      model: this.model,
      base_url: this.baseUrl,
      issues: validation.issues,
      reachable: null,
      model_available: null,
    };
    if (!live) return health;
    if (!validation.ok) {
      health.reachable = false;
      return health;
    }

    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.apiKey}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!response.ok) {
        health.reachable = false;
        health.issues = [...validation.issues, `provider responded with HTTP ${response.status}`];
        return health;
      }
      const data = await response.json();
      const ids = Array.isArray(data?.data) ? data.data.map((entry) => entry.id) : [];
      health.reachable = true;
      health.model_available = ids.includes(this.model);
      if (!health.model_available) {
        health.issues = [...validation.issues, `model "${this.model}" was not returned by the account`];
      }
    } catch (error) {
      health.reachable = false;
      health.issues = [...validation.issues, `request failed: ${error.name}`];
    }
    return health;
  }

  /**
   * Ask the model for a structured plan.
   * @returns {Promise<{raw: object, rawText: string, usage: object|null}>}
   */
  async planTask({ systemPrompt, userPayload, requestId, taskId }) {
    const validation = this.validateProviderConfig();
    if (!validation.ok) {
      throw new AppError('AI_PROVIDER_NOT_CONFIGURED', { details: { issues: validation.issues } });
    }

    const body = {
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(userPayload) },
      ],
      response_format: { type: 'json_object' },
      max_completion_tokens: 2000,
    };
    if (this.reasoningEffort) body.reasoning_effort = this.reasoningEffort;

    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const started = Date.now();
      try {
        const response = await fetch(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.apiKey}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.timeoutMs),
        });

        if (!response.ok) {
          const error = await this.#normalizeHttpError(response);
          if (!RETRYABLE_STATUS.has(response.status) || attempt === this.maxRetries) throw error;
          lastError = error;
          const delay = backoffDelay(attempt, parseRetryAfter(response.headers.get('retry-after')));
          this.logger.warn('ai.retry', { requestId, taskId, attempt, status: response.status, delayMs: delay });
          await sleep(delay);
          continue;
        }

        const data = await response.json();
        const content = this.#extractContent(data);
        this.logger.info('ai.plan_received', {
          requestId,
          taskId,
          durationMs: Date.now() - started,
          model: data.model ?? this.model,
          promptTokens: data.usage?.prompt_tokens ?? null,
          completionTokens: data.usage?.completion_tokens ?? null,
        });
        return { rawText: content, usage: data.usage ?? null, raw: parseJsonObject(content) };
      } catch (error) {
        // Fetch-level failures (DNS, TLS, timeout) are retried; provider errors
        // that are already classified keep their own retryable flag.
        const normalized = this.normalizeProviderError(error, { retryable: true });
        if (!normalized.retryable || attempt === this.maxRetries) throw normalized;
        lastError = normalized;
        const delay = backoffDelay(attempt);
        this.logger.warn('ai.retry', {
          requestId,
          taskId,
          attempt,
          reason: error.name === 'TimeoutError' ? 'timeout' : error.name,
          delayMs: delay,
        });
        await sleep(delay);
      }
    }
    throw lastError ?? new AppError('AI_PROVIDER_ERROR');
  }

  async #normalizeHttpError(response) {
    let message = '';
    try {
      const payload = await response.json();
      message = payload?.error?.message ?? '';
    } catch {
      message = '';
    }
    const status = response.status;
    if (status === 401 || status === 403) {
      return new AppError('AI_PROVIDER_INVALID_CREDENTIALS', { details: { status, providerMessage: message } });
    }
    if (status === 429) {
      return this.normalizeProviderError({ status, message }, { retryable: true });
    }
    if (status >= 500) {
      return this.normalizeProviderError({ status, message }, { retryable: true });
    }
    return new AppError('AI_PROVIDER_ERROR', { details: { status, providerMessage: message } });
  }

  #extractContent(data) {
    const message = data?.choices?.[0]?.message;
    if (message?.refusal) {
      throw new AppError('INVALID_AI_PLAN', { details: { issues: ['The model refused to produce a plan.'] } });
    }
    const content = message?.content;
    if (typeof content === 'string' && content.trim()) return content;
    if (Array.isArray(content)) {
      const text = content
        .map((part) => (typeof part === 'string' ? part : part?.text ?? ''))
        .join('')
        .trim();
      if (text) return text;
    }
    throw new AppError('INVALID_AI_PLAN', { details: { issues: ['The provider response contained no message content.'] } });
  }

  normalizeProviderError(error, { retryable = false } = {}) {
    if (error instanceof AppError) return error;
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      return new AppError('AI_PROVIDER_TIMEOUT', { retryable: true });
    }
    if (error?.status === 429 || /rate.?limit/i.test(error?.message ?? '')) {
      return new AppError('AI_PROVIDER_RATE_LIMITED', { retryable: true });
    }
    if (error?.status === 401 || error?.status === 403) {
      return new AppError('AI_PROVIDER_INVALID_CREDENTIALS');
    }
    if (error?.status >= 500) {
      return new AppError('AI_PROVIDER_ERROR', { retryable: true });
    }
    return new AppError('AI_PROVIDER_ERROR', { retryable });
  }
}

/** Accept raw JSON, or JSON wrapped in ``` fences, and require a top-level object. */
export function parseJsonObject(text) {
  let candidate = String(text ?? '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(candidate);
  if (fence) candidate = fence[1].trim();
  try {
    const parsed = JSON.parse(candidate);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    return parsed;
  } catch (error) {
    throw new AppError('INVALID_AI_PLAN', {
      details: { issues: ['The model output was not a JSON object.', error.message] },
    });
  }
}
