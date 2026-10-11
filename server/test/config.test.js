import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConfig, HARD_LIMITS } from '../src/config/index.js';

const baseEnv = {
  NODE_ENV: 'development',
  OWNER_API_TOKENS: 'abc,def',
  AI_PROVIDER: 'none',
};

const build = (env) => buildConfig({ ...baseEnv, ...env }, { skipEnvFile: true });

test('valid configuration is accepted', () => {
  const { ok, config, issues } = build({});
  assert.equal(ok, true);
  assert.deepEqual(config.ownerApiTokens, ['abc', 'def']);
  assert.equal(config.wsPath, '/api/v1/device');
  assert.deepEqual(
    issues.filter((issue) => issue.level === 'error'),
    [],
  );
});

test('invalid values are reported instead of being coerced silently', () => {
  const { ok, issues } = build({ PORT: 'not-a-port', LOG_LEVEL: 'verbose' });
  assert.equal(ok, false);
  const keys = issues.filter((issue) => issue.level === 'error').map((issue) => issue.key);
  assert.ok(keys.includes('PORT'));
  assert.ok(keys.includes('LOG_LEVEL'));
});

test('production requires an owner token', () => {
  const { ok, issues } = build({ NODE_ENV: 'production', OWNER_API_TOKENS: '' });
  assert.equal(ok, false);
  assert.ok(
    issues.some((issue) => issue.key === 'OWNER_API_TOKENS' && issue.level === 'error'),
    'a missing owner token must be fatal in production',
  );
});

test('development generates an ephemeral token and warns', () => {
  const { ok, config, issues } = build({ NODE_ENV: 'development', OWNER_API_TOKENS: '' });
  assert.equal(ok, true);
  assert.equal(config.ownerApiTokens.length, 1);
  assert.equal(config.ownerTokenConfigured, false);
  assert.ok(issues.some((issue) => issue.key === 'OWNER_API_TOKENS' && issue.level === 'warning'));
});

test('the mock AI provider is refused in production', () => {
  const { ok, issues } = build({ NODE_ENV: 'production', AI_PROVIDER: 'mock' });
  assert.equal(ok, false);
  assert.ok(issues.some((issue) => issue.key === 'AI_PROVIDER' && issue.level === 'error'));
});

test('a selected AI provider without a key or model warns but still boots', () => {
  const { ok, issues } = build({ AI_PROVIDER: 'openai', OPENAI_API_KEY: '', OPENAI_MODEL: '' });
  assert.equal(ok, true);
  assert.ok(issues.some((issue) => issue.key === 'AI_PROVIDER' && issue.level === 'warning'));
});

test('safety budgets above the hard limits are rejected, not clamped silently', () => {
  const { ok, issues } = build({
    MAX_ACTIONS_PER_TASK: String(HARD_LIMITS.MAX_ACTIONS_PER_TASK + 1),
    MAX_TASK_DURATION_SECONDS: String(HARD_LIMITS.MAX_TASK_DURATION_SECONDS + 1),
    MAX_PENDING_TASKS_PER_DEVICE: String(HARD_LIMITS.MAX_PENDING_TASKS_PER_DEVICE + 1),
  });
  assert.equal(ok, false);
  const keys = issues.filter((issue) => issue.level === 'error').map((issue) => issue.key);
  assert.deepEqual(keys.sort(), ['MAX_ACTIONS_PER_TASK', 'MAX_PENDING_TASKS_PER_DEVICE', 'MAX_TASK_DURATION_SECONDS']);
});

test('budgets inside the hard limits are honoured', () => {
  const { ok, config } = build({ MAX_ACTIONS_PER_TASK: '20', MAX_TASK_DURATION_SECONDS: '120' });
  assert.equal(ok, true);
  assert.equal(config.tasks.maxActionsPerTask, 20);
  assert.equal(config.tasks.maxDurationSeconds, 120);
});

test('empty environment variables fall back to defaults instead of failing', () => {
  const { ok, config } = build({ PORT: '', MAX_ACTIONS_PER_TASK: '' });
  assert.equal(ok, true);
  assert.equal(config.port, 3000);
  assert.equal(config.tasks.maxActionsPerTask, 12);
});

test('telegram requires a token and at least one allowed user', () => {
  const noToken = build({ TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: '', TELEGRAM_ALLOWED_USER_IDS: '123' });
  assert.equal(noToken.ok, false);

  const noUsers = build({ TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_ALLOWED_USER_IDS: '' });
  assert.equal(noUsers.ok, false);

  const valid = build({ TELEGRAM_ENABLED: 'true', TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_ALLOWED_USER_IDS: '123,456' });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.config.telegram.allowedUserIds, ['123', '456']);
});

test('defaults match the documented conservative budgets', () => {
  const { config } = build({});
  assert.equal(config.tasks.maxActionsPerTask, 12);
  assert.equal(config.tasks.maxDurationSeconds, 90);
  assert.equal(config.tasks.maxActionRetries, 2);
  assert.equal(config.tasks.maxPlanningIterations, 3);
  assert.equal(config.pairing.ttlSeconds, 300);
  assert.equal(config.ai.model, 'gpt-6.1-sol');
});
