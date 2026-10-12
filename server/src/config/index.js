import crypto from 'node:crypto';
import { z } from 'zod';
import { loadEnvFile, splitList } from './env.js';

/**
 * Server configuration.
 *
 * Every value is validated on startup. A configuration problem produces a
 * precise, non-fatal-at-import-time error instead of a runtime surprise, and
 * safety critical values (authentication, budgets, timeouts) cannot be disabled.
 */

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0', 'yes', 'no']), z.literal('')])
  .transform((value) => {
    if (typeof value === 'boolean') return value;
    return value === 'true' || value === '1' || value === 'yes';
  });

// An empty environment variable is treated as "not set" (a common hosting
// default), but any other invalid value is a hard configuration error instead of
// being silently replaced by the default.
const int = (min, max, fallback) =>
  z
    .preprocess(
      (value) => (value === undefined || value === null || value === '' ? fallback : value),
      z.coerce
        .number({ invalid_type_error: 'must be a number' })
        .int('must be an integer')
        .min(min, `must be >= ${min}`)
        .max(max, `must be <= ${max}`),
    )
    .default(fallback);

const DEFAULT_MODEL = 'gpt-6.1-sol';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: int(1, 65535, 3000),
  PUBLIC_BASE_URL: z.string().default(''),
  WS_PATH: z
    .string()
    .startsWith('/', 'must start with "/"')
    .default('/api/v1/device'),
  TRUST_PROXY: booleanish.default(true),

  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),

  OWNER_API_TOKENS: z.string().default(''),

  MAX_MESSAGE_BYTES: int(2048, 262144, 32768),
  MAX_WS_CONNECTIONS: int(1, 10000, 50),
  HEARTBEAT_INTERVAL_MS: int(1000, 300000, 20000),
  HEARTBEAT_TIMEOUT_MS: int(2000, 900000, 60000),
  AUTH_TIMEOUT_MS: int(2000, 120000, 15000),
  WS_MESSAGE_RATE_PER_MINUTE: int(5, 100000, 240),

  PAIRING_CODE_TTL_SECONDS: int(30, 3600, 300),
  PAIRING_MAX_ATTEMPTS: int(1, 50, 5),
  PAIRING_FAILURE_WINDOW_SECONDS: int(30, 3600, 300),
  PAIRING_CREATE_RATE_PER_MINUTE: int(1, 100, 10),
  PAIRING_COMPLETE_RATE_PER_MINUTE: int(1, 100, 20),

  MAX_ACTIONS_PER_TASK: int(1, 30, 12), // ceiling = HARD_LIMITS.MAX_ACTIONS_PER_TASK
  MAX_TASK_DURATION_SECONDS: int(5, 900, 90), // ceiling = HARD_LIMITS.MAX_TASK_DURATION_SECONDS
  MAX_ACTION_TIMEOUT_MS: int(2000, 120000, 20000),
  MAX_ACTION_RETRIES: int(0, 5, 2),
  MAX_PLANNING_ITERATIONS: int(1, 5, 3),
  MAX_PENDING_TASKS_PER_DEVICE: int(1, 50, 3), // ceiling = HARD_LIMITS.MAX_PENDING_TASKS_PER_DEVICE
  TASK_CREATE_RATE_PER_MINUTE: int(1, 200, 20),
  TASK_HISTORY_RETENTION_DAYS: int(1, 3650, 30),
  APPROVAL_TIMEOUT_SECONDS: int(30, 3600, 900),

  AI_PROVIDER: z.enum(['openai', 'openai_compatible', 'mock', 'none']).default('none'),
  OPENAI_API_KEY: z.string().default(''),
  OPENAI_MODEL: z.string().default(''),
  OPENAI_BASE_URL: z.string().default('https://api.openai.com/v1'),
  OPENAI_REASONING_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).optional(),
  AI_TIMEOUT_MS: int(1000, 300000, 45000),
  AI_MAX_RETRIES: int(0, 5, 2),

  POLICY_SENSITIVE_MODE: z.enum(['approval', 'deny']).default('approval'),

  STORAGE_DRIVER: z.enum(['json', 'sqlite', 'memory']).default('json'),
  STORAGE_PATH: z.string().default(''),
  DATABASE_URL: z.string().default(''),

  TELEGRAM_ENABLED: booleanish.default(false),
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_ALLOWED_USER_IDS: z.string().default(''),
  TELEGRAM_ALLOWED_CHAT_IDS: z.string().default(''),
  TELEGRAM_POLL_TIMEOUT_SECONDS: int(1, 50, 25),
  TELEGRAM_API_BASE_URL: z.string().default('https://api.telegram.org'),
});

/** Absolute safety ceilings. A configuration value may never exceed these. */
export const HARD_LIMITS = Object.freeze({
  MAX_ACTIONS_PER_TASK: 30,
  MAX_TASK_DURATION_SECONDS: 900,
  MAX_PENDING_TASKS_PER_DEVICE: 50,
});

function parse(env, { skipEnvFile = false } = {}) {
  if (!skipEnvFile) loadEnvFile();
  const parsed = schema.safeParse(env);
  return parsed;
}

/**
 * Build a validated, frozen configuration object.
 *
 * Returns `{ ok, config, issues }` where `issues` is a list of
 * `{ level: 'error'|'warning', key, message }` entries.
 */
export function buildConfig(env = process.env, options = {}) {
  const parsed = parse(env, options);
  const issues = [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      issues.push({
        level: 'error',
        key: issue.path.join('.'),
        message: `${issue.path.join('.') || 'environment'}: ${issue.message}`,
      });
    }
    return { ok: false, config: null, issues };
  }

  const raw = parsed.data;
  const isProduction = raw.NODE_ENV === 'production';
  const ownerTokens = splitList(raw.OWNER_API_TOKENS);

  let effectiveOwnerTokens = ownerTokens;
  if (ownerTokens.length === 0) {
    // Never let the server start with authentication silently disabled.
    if (isProduction) {
      issues.push({
        level: 'error',
        key: 'OWNER_API_TOKENS',
        message:
          'OWNER_API_TOKENS is required in production. Generate one with `openssl rand -hex 32` and set it as a secret.',
      });
    } else {
      const ephemeral = `dev-${crypto.randomBytes(16).toString('hex')}`;
      effectiveOwnerTokens = [ephemeral];
      issues.push({
        level: 'warning',
        key: 'OWNER_API_TOKENS',
        message:
          'OWNER_API_TOKENS is not set. An ephemeral development token was generated for this process only.',
      });
    }
  }

  if (isProduction && !raw.PUBLIC_BASE_URL) {
    issues.push({
      level: 'warning',
      key: 'PUBLIC_BASE_URL',
      message: 'PUBLIC_BASE_URL is empty; generated links (pairing, callbacks) will be relative.',
    });
  }

  if (isProduction && raw.AI_PROVIDER === 'mock') {
    issues.push({
      level: 'error',
      key: 'AI_PROVIDER',
      message: 'AI_PROVIDER=mock is only allowed outside production.',
    });
  }

  const aiConfigured =
    (raw.AI_PROVIDER === 'openai' || raw.AI_PROVIDER === 'openai_compatible') &&
    raw.OPENAI_API_KEY.length > 0 &&
    raw.OPENAI_MODEL.length > 0;

  if ((raw.AI_PROVIDER === 'openai' || raw.AI_PROVIDER === 'openai_compatible') && !aiConfigured) {
    issues.push({
      level: 'warning',
      key: 'AI_PROVIDER',
      message:
        'AI provider selected but OPENAI_API_KEY or OPENAI_MODEL is empty. Task planning will fail with AI_PROVIDER_NOT_CONFIGURED until both are set.',
    });
  }

  if (raw.TELEGRAM_ENABLED && !raw.TELEGRAM_BOT_TOKEN) {
    issues.push({
      level: 'error',
      key: 'TELEGRAM_BOT_TOKEN',
      message: 'TELEGRAM_ENABLED is true but TELEGRAM_BOT_TOKEN is missing.',
    });
  }

  if (raw.TELEGRAM_ENABLED && splitList(raw.TELEGRAM_ALLOWED_USER_IDS).length === 0) {
    issues.push({
      level: 'error',
      key: 'TELEGRAM_ALLOWED_USER_IDS',
      message: 'TELEGRAM_ALLOWED_USER_IDS must list at least one numeric Telegram user id.',
    });
  }

  const config = Object.freeze({
    env: raw.NODE_ENV,
    isProduction,
    host: raw.HOST,
    port: raw.PORT,
    publicBaseUrl: raw.PUBLIC_BASE_URL.replace(/\/$/, ''),
    wsPath: raw.WS_PATH,
    trustProxy: raw.TRUST_PROXY,

    log: Object.freeze({ level: raw.LOG_LEVEL, format: raw.LOG_FORMAT }),

    ownerApiTokens: Object.freeze(effectiveOwnerTokens.slice()),
    ownerTokenConfigured: ownerTokens.length > 0,

    limits: Object.freeze({
      maxMessageBytes: raw.MAX_MESSAGE_BYTES,
      maxWsConnections: raw.MAX_WS_CONNECTIONS,
      heartbeatIntervalMs: raw.HEARTBEAT_INTERVAL_MS,
      heartbeatTimeoutMs: raw.HEARTBEAT_TIMEOUT_MS,
      authTimeoutMs: raw.AUTH_TIMEOUT_MS,
      wsMessageRatePerMinute: raw.WS_MESSAGE_RATE_PER_MINUTE,
    }),

    pairing: Object.freeze({
      ttlSeconds: raw.PAIRING_CODE_TTL_SECONDS,
      maxAttempts: raw.PAIRING_MAX_ATTEMPTS,
      createRatePerMinute: raw.PAIRING_CREATE_RATE_PER_MINUTE,
      completeRatePerMinute: raw.PAIRING_COMPLETE_RATE_PER_MINUTE,
      failureWindowSeconds: raw.PAIRING_FAILURE_WINDOW_SECONDS,
    }),

    tasks: Object.freeze({
      maxActionsPerTask: Math.min(raw.MAX_ACTIONS_PER_TASK, HARD_LIMITS.MAX_ACTIONS_PER_TASK),
      maxDurationSeconds: Math.min(raw.MAX_TASK_DURATION_SECONDS, HARD_LIMITS.MAX_TASK_DURATION_SECONDS),
      maxActionTimeoutMs: raw.MAX_ACTION_TIMEOUT_MS,
      maxActionRetries: raw.MAX_ACTION_RETRIES,
      maxPlanningIterations: raw.MAX_PLANNING_ITERATIONS,
      maxPendingTasksPerDevice: Math.min(
        raw.MAX_PENDING_TASKS_PER_DEVICE,
        HARD_LIMITS.MAX_PENDING_TASKS_PER_DEVICE,
      ),
      createRatePerMinute: raw.TASK_CREATE_RATE_PER_MINUTE,
      historyRetentionDays: raw.TASK_HISTORY_RETENTION_DAYS,
      approvalTimeoutSeconds: raw.APPROVAL_TIMEOUT_SECONDS,
    }),

    ai: Object.freeze({
      provider: raw.AI_PROVIDER,
      baseUrl: raw.OPENAI_BASE_URL.replace(/\/$/, ''),
      apiKey: raw.OPENAI_API_KEY,
      model: raw.OPENAI_MODEL || DEFAULT_MODEL,
      modelConfigured: raw.OPENAI_MODEL.length > 0,
      reasoningEffort: raw.OPENAI_REASONING_EFFORT,
      timeoutMs: raw.AI_TIMEOUT_MS,
      maxRetries: raw.AI_MAX_RETRIES,
      configured: aiConfigured,
    }),

    policy: Object.freeze({ sensitiveMode: raw.POLICY_SENSITIVE_MODE }),

    storage: Object.freeze({
      driver: raw.STORAGE_DRIVER,
      path: raw.STORAGE_PATH,
      databaseUrl: raw.DATABASE_URL,
    }),

    telegram: Object.freeze({
      enabled: raw.TELEGRAM_ENABLED,
      botToken: raw.TELEGRAM_BOT_TOKEN,
      allowedUserIds: Object.freeze(splitList(raw.TELEGRAM_ALLOWED_USER_IDS)),
      allowedChatIds: Object.freeze(splitList(raw.TELEGRAM_ALLOWED_CHAT_IDS)),
      pollTimeoutSeconds: raw.TELEGRAM_POLL_TIMEOUT_SECONDS,
      apiBaseUrl: raw.TELEGRAM_API_BASE_URL.replace(/\/$/, ''),
    }),
  });

  const hasErrors = issues.some((issue) => issue.level === 'error');
  return { ok: !hasErrors, config, issues };
}

let cachedConfig = null;

/** Load (and memoise) configuration for the running process. */
export function loadConfig(env = process.env, options = {}) {
  const result = buildConfig(env, options);
  if (!result.ok) {
    const details = result.issues
      .filter((issue) => issue.level === 'error')
      .map((issue) => `  - ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid server configuration:\n${details}`);
  }
  cachedConfig = result;
  return result;
}

export function getConfig() {
  if (!cachedConfig) throw new Error('Configuration has not been loaded yet. Call loadConfig() first.');
  return cachedConfig.config;
}

export function getConfigIssues() {
  return cachedConfig ? cachedConfig.issues : [];
}

export { DEFAULT_MODEL };
