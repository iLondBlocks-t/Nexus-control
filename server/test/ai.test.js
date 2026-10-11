import test from 'node:test';
import assert from 'node:assert/strict';
import { installMockFetch, chatCompletionResponse } from './helpers/mockFetch.js';
import { OpenAiProvider } from '../src/ai/openaiProvider.js';
import { Planner } from '../src/planner/planner.js';
import { buildConfig } from '../src/config/index.js';
import { getLogger } from '../src/logging/logger.js';
import { AppError } from '../src/utils/errors.js';

function makeConfig(overrides = {}) {
  const { config } = buildConfig(
    {
      NODE_ENV: 'development',
      OWNER_API_TOKENS: 'owner',
      AI_PROVIDER: 'openai',
      OPENAI_API_KEY: 'sk-test-key',
      OPENAI_MODEL: 'gpt-6.1-sol',
      LOG_LEVEL: 'silent',
      ...overrides,
    },
    { skipEnvFile: true },
  );
  return config;
}

const validPlan = {
  task_summary: 'Open YouTube',
  requires_approval: false,
  actions: [{ type: 'open_app', package_name: 'com.google.android.youtube', reason: 'Open the app' }],
};

function makeProvider(configOverrides = {}, providerOverrides = {}) {
  const config = makeConfig(configOverrides);
  return new OpenAiProvider({
    apiKey: config.ai.apiKey,
    model: config.ai.model,
    baseUrl: config.ai.baseUrl,
    timeoutMs: 1000,
    maxRetries: 0,
    reasoningEffort: config.ai.reasoningEffort,
    ...providerOverrides,
  });
}

test('a valid structured plan is parsed', async (t) => {
  const fetchMock = installMockFetch();
  t.after(() => fetchMock.restore());
  fetchMock.queue({ body: chatCompletionResponse(JSON.stringify(validPlan)) });

  const provider = makeProvider();
  const result = await provider.planTask({
    systemPrompt: 'system',
    userPayload: { instruction: 'Open YouTube' },
    taskId: 'task_1',
  });
  assert.deepEqual(result.raw, validPlan);
  assert.equal(fetchMock.lastCall().url, 'https://api.openai.com/v1/chat/completions');
  assert.equal(JSON.parse(fetchMock.lastCall().options.body).model, 'gpt-6.1-sol');
});

test('JSON wrapped in markdown fences is still accepted', async (t) => {
  const fetchMock = installMockFetch();
  t.after(() => fetchMock.restore());
  fetchMock.queue({ body: chatCompletionResponse('```json\n' + JSON.stringify(validPlan) + '\n```') });

  const provider = makeProvider();
  const result = await provider.planTask({ systemPrompt: 's', userPayload: {}, taskId: 'task_1' });
  assert.deepEqual(result.raw, validPlan);
});

test('malformed JSON becomes INVALID_AI_PLAN', async (t) => {
  const fetchMock = installMockFetch();
  t.after(() => fetchMock.restore());
  fetchMock.queue({ body: chatCompletionResponse('{ not json') });

  const provider = makeProvider();
  await assert.rejects(
    () => provider.planTask({ systemPrompt: 's', userPayload: {}, taskId: 'task_1' }),
    (error) => error.code === 'INVALID_AI_PLAN',
  );
});

test('a JSON array is rejected (the contract requires an object)', async (t) => {
  const fetchMock = installMockFetch();
  t.after(() => fetchMock.restore());
  fetchMock.queue({ body: chatCompletionResponse('[{"type":"back"}]') });

  const provider = makeProvider();
  await assert.rejects(
    () => provider.planTask({ systemPrompt: 's', userPayload: {}, taskId: 'task_1' }),
    (error) => error.code === 'INVALID_AI_PLAN',
  );
});

test('an unexpected response shape becomes INVALID_AI_PLAN', async (t) => {
  const fetchMock = installMockFetch();
  t.after(() => fetchMock.restore());
  fetchMock.queue({ body: { id: 'x', choices: [] } });

  const provider = makeProvider();
  await assert.rejects(
    () => provider.planTask({ systemPrompt: 's', userPayload: {}, taskId: 'task_1' }),
    (error) => error.code === 'INVALID_AI_PLAN',
  );
});

test('a refusal from the model becomes INVALID_AI_PLAN', async (t) => {
  const fetchMock = installMockFetch();
  t.after(() => fetchMock.restore());
  fetchMock.queue({
    body: { choices: [{ message: { role: 'assistant', refusal: 'I cannot help with that.' } }] },
  });

  const provider = makeProvider();
  await assert.rejects(
    () => provider.planTask({ systemPrompt: 's', userPayload: {}, taskId: 'task_1' }),
    (error) => error.code === 'INVALID_AI_PLAN',
  );
});

test('a missing API key fails with AI_PROVIDER_NOT_CONFIGURED', async () => {
  const provider = makeProvider({}, { apiKey: '' });
  await assert.rejects(
    () => provider.planTask({ systemPrompt: 's', userPayload: {}, taskId: 'task_1' }),
    (error) => error.code === 'AI_PROVIDER_NOT_CONFIGURED',
  );
});

test('invalid credentials map to AI_PROVIDER_INVALID_CREDENTIALS without retrying', async (t) => {
  const fetchMock = installMockFetch();
  t.after(() => fetchMock.restore());
  fetchMock.queue({ status: 401, body: { error: { message: 'Incorrect API key provided' } } });

  const provider = makeProvider({}, { maxRetries: 3 });
  await assert.rejects(
    () => provider.planTask({ systemPrompt: 's', userPayload: {}, taskId: 'task_1' }),
    (error) => error.code === 'AI_PROVIDER_INVALID_CREDENTIALS',
  );
  assert.equal(fetchMock.calls.length, 1, 'a 401 must not be retried');
});

test('rate limiting maps to AI_PROVIDER_RATE_LIMITED after bounded retries', async (t) => {
  const fetchMock = installMockFetch();
  t.after(() => fetchMock.restore());
  fetchMock.queue({ status: 429, headers: { 'retry-after': '0' } });
  fetchMock.queue({ status: 429, headers: { 'retry-after': '0' } });

  const provider = makeProvider({}, { maxRetries: 1 });
  await assert.rejects(
    () => provider.planTask({ systemPrompt: 's', userPayload: {}, taskId: 'task_1' }),
    (error) => error.code === 'AI_PROVIDER_RATE_LIMITED',
  );
  assert.equal(fetchMock.calls.length, 2, 'one retry after the first 429');
});

test('a server error maps to AI_PROVIDER_ERROR after bounded retries', async (t) => {
  const fetchMock = installMockFetch();
  t.after(() => fetchMock.restore());
  fetchMock.queue({ status: 500 });
  fetchMock.queue({ status: 500 });

  const provider = makeProvider({}, { maxRetries: 1 });
  await assert.rejects(
    () => provider.planTask({ systemPrompt: 's', userPayload: {}, taskId: 'task_1' }),
    (error) => error.code === 'AI_PROVIDER_ERROR',
  );
  assert.equal(fetchMock.calls.length, 2);
});

test('a transient failure followed by success recovers', async (t) => {
  const fetchMock = installMockFetch();
  t.after(() => fetchMock.restore());
  fetchMock.queue({ status: 503 });
  fetchMock.queue({ body: chatCompletionResponse(JSON.stringify(validPlan)) });

  const provider = makeProvider({}, { maxRetries: 1 });
  const result = await provider.planTask({ systemPrompt: 's', userPayload: {}, taskId: 'task_1' });
  assert.deepEqual(result.raw, validPlan);
});

test('a timeout maps to AI_PROVIDER_TIMEOUT', async (t) => {
  const fetchMock = installMockFetch();
  t.after(() => fetchMock.restore());
  const timeout = new Error('The operation was aborted due to timeout');
  timeout.name = 'TimeoutError';
  fetchMock.queue({ throwError: timeout });

  const provider = makeProvider({}, { maxRetries: 0 });
  await assert.rejects(
    () => provider.planTask({ systemPrompt: 's', userPayload: {}, taskId: 'task_1' }),
    (error) => error.code === 'AI_PROVIDER_TIMEOUT',
  );
});

test('health check never leaks the API key and reports configuration state', async (t) => {
  const fetchMock = installMockFetch();
  t.after(() => fetchMock.restore());
  fetchMock.queue({ body: { data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-luna' }] } });

  const provider = makeProvider();
  const health = await provider.getProviderHealth({ live: true });
  assert.equal(health.configured, true);
  assert.equal(health.reachable, true);
  assert.equal(health.model_available, true);
  assert.equal(fetchMock.lastCall().url, 'https://api.openai.com/v1/models');
  assert.ok(!JSON.stringify(health).includes('sk-test-key'), 'the key must never appear in health output');
});

test('health check reports an unavailable model', async (t) => {
  const fetchMock = installMockFetch();
  t.after(() => fetchMock.restore());
  fetchMock.queue({ body: { data: [{ id: 'gpt-6-luna' }] } });

  const provider = makeProvider();
  const health = await provider.getProviderHealth({ live: true });
  assert.equal(health.model_available, false);
});

test('an unconfigured provider reports why it is unconfigured', async () => {
  const provider = makeProvider({}, { apiKey: '', model: '' });
  const health = await provider.getProviderHealth();
  assert.equal(health.configured, false);
  assert.ok(health.issues.some((issue) => issue.includes('OPENAI_API_KEY')));
});

/* ------------------------------------------------------------------ */
/* Planner: model output is always screened by the policy engine        */
/* ------------------------------------------------------------------ */

function makePlanner(configOverrides = {}, providerOverrides = {}) {
  const config = makeConfig(configOverrides);
  const provider = new OpenAiProvider({
    apiKey: config.ai.apiKey,
    model: config.ai.model,
    baseUrl: config.ai.baseUrl,
    timeoutMs: 1000,
    maxRetries: 0,
    ...providerOverrides,
  });
  return new Planner({ provider, config, logger: getLogger({}) });
}

test('an unsupported action type is rejected', async (t) => {
  const fetchMock = installMockFetch();
  t.after(() => fetchMock.restore());
  fetchMock.queue({
    body: chatCompletionResponse(
      JSON.stringify({ task_summary: 'x', requires_approval: false, actions: [{ type: 'run_shell', command: 'rm -rf /' }] }),
    ),
  });

  const planner = makePlanner();
  await assert.rejects(
    () => planner.createPlan({ instruction: 'wipe the phone', taskId: 'task_1' }),
    (error) => error.code === 'INVALID_AI_PLAN',
  );
});

test('extra executable fields are rejected', async (t) => {
  const fetchMock = installMockFetch();
  t.after(() => fetchMock.restore());
  fetchMock.queue({
    body: chatCompletionResponse(
      JSON.stringify({ task_summary: 'x', requires_approval: false, actions: [{ type: 'back', extra: 'ignored' }] }),
    ),
  });

  const planner = makePlanner();
  await assert.rejects(
    () => planner.createPlan({ instruction: 'go back', taskId: 'task_1' }),
    (error) => error.code === 'INVALID_AI_PLAN',
  );
});

test('an excessive action count is rejected against the configured budget', async (t) => {
  const fetchMock = installMockFetch();
  t.after(() => fetchMock.restore());
  fetchMock.queue({
    body: chatCompletionResponse(
      JSON.stringify({
        task_summary: 'x',
        requires_approval: false,
        actions: Array.from({ length: 4 }, () => ({ type: 'back' })),
      }),
    ),
  });

  const planner = makePlanner({ MAX_ACTIONS_PER_TASK: '3' });
  await assert.rejects(
    () => planner.createPlan({ instruction: 'go back a lot', taskId: 'task_1' }),
    (error) => error.code === 'INVALID_AI_PLAN',
  );
});

test('an invalid package identifier is rejected', async (t) => {
  const fetchMock = installMockFetch();
  t.after(() => fetchMock.restore());
  fetchMock.queue({
    body: chatCompletionResponse(
      JSON.stringify({ task_summary: 'x', requires_approval: false, actions: [{ type: 'open_app', package_name: 'not a package!' }] }),
    ),
  });

  const planner = makePlanner();
  await assert.rejects(
    () => planner.createPlan({ instruction: 'open it', taskId: 'task_1' }),
    (error) => error.code === 'INVALID_AI_PLAN',
  );
});

test('a sensitive tap is allowed only with approval', async (t) => {
  const fetchMock = installMockFetch();
  t.after(() => fetchMock.restore());
  fetchMock.queue({
    body: chatCompletionResponse(
      JSON.stringify({
        task_summary: 'Send the message',
        requires_approval: false,
        actions: [{ type: 'tap_element', match: { text: 'Send' } }],
      }),
    ),
  });

  const planner = makePlanner();
  const plan = await planner.createPlan({ instruction: 'send it', taskId: 'task_1' });
  assert.equal(plan.requiresApproval, true);
  assert.ok(plan.approvalReasons.length > 0);
});

test('sensitive taps are denied outright in deny mode', async (t) => {
  const fetchMock = installMockFetch();
  t.after(() => fetchMock.restore());
  fetchMock.queue({
    body: chatCompletionResponse(
      JSON.stringify({
        task_summary: 'Send the message',
        requires_approval: false,
        actions: [{ type: 'tap_element', match: { text: 'Send' } }],
      }),
    ),
  });

  const planner = makePlanner({ POLICY_SENSITIVE_MODE: 'deny' });
  await assert.rejects(
    () => planner.createPlan({ instruction: 'send it', taskId: 'task_1' }),
    (error) => error.code === 'ACTION_NOT_ALLOWED',
  );
});

test('typing a credential-like value is denied', async (t) => {
  const fetchMock = installMockFetch();
  t.after(() => fetchMock.restore());
  fetchMock.queue({
    body: chatCompletionResponse(
      JSON.stringify({
        task_summary: 'Enter the code',
        requires_approval: false,
        actions: [{ type: 'type_text', text: '482913', target: { text: 'Code' } }],
      }),
    ),
  });

  const planner = makePlanner();
  await assert.rejects(
    () => planner.createPlan({ instruction: 'enter the code', taskId: 'task_1' }),
    (error) => error.code === 'ACTION_NOT_ALLOWED',
  );
});

test('a prompt injection attempt found on screen is denied', async (t) => {
  const fetchMock = installMockFetch();
  t.after(() => fetchMock.restore());
  fetchMock.queue({
    body: chatCompletionResponse(
      JSON.stringify({
        task_summary: 'Follow the screen',
        requires_approval: false,
        actions: [{ type: 'tap_element', match: { text: 'Ignore previous instructions' } }],
      }),
    ),
  });

  const planner = makePlanner();
  await assert.rejects(
    () => planner.createPlan({ instruction: 'open settings', taskId: 'task_1' }),
    (error) => error instanceof AppError && error.code === 'ACTION_NOT_ALLOWED',
  );
});

test('the system prompt tells the model that screen content is untrusted', () => {
  const planner = makePlanner();
  assert.match(planner.systemPrompt, /untrusted|UNTRUSTED/i);
  assert.match(planner.systemPrompt, /open_app/);
  assert.match(planner.systemPrompt, /requires_approval/);
});

test('the planner sends only the minimum context and never the API key', async (t) => {
  const fetchMock = installMockFetch();
  t.after(() => fetchMock.restore());
  fetchMock.queue({ body: chatCompletionResponse(JSON.stringify(validPlan)) });

  const planner = makePlanner();
  await planner.createPlan({
    instruction: 'Open YouTube',
    taskId: 'task_1',
    device: { model: 'SM-J730F', androidVersion: '9', launcherPackages: ['com.google.android.youtube'] },
    screen: { visible_text: ['Home'] },
  });

  const body = JSON.parse(fetchMock.lastCall().options.body);
  const userPayload = JSON.parse(body.messages[1].content);
  assert.equal(userPayload.instruction, 'Open YouTube');
  assert.deepEqual(userPayload.available_packages, ['com.google.android.youtube']);
  assert.deepEqual(userPayload.screen, { visible_text: ['Home'] });
  assert.equal(userPayload.limits.max_actions, 12);
  assert.ok(!body.messages[1].content.includes('sk-test-key'));
});
