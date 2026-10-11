import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, pairDevice, FakeDevice, ownerHeaders, waitFor } from './helpers/testServer.js';

/**
 * End-to-end acceptance slice: server -> planner -> policy -> device -> result.
 *
 * These tests use a scripted provider so the plan is deterministic; the mock
 * provider is used for the "ordinary" happy path.
 */
class ScriptedProvider {
  constructor(plan) {
    this.plan = plan;
    this.name = 'scripted';
    this.model = 'scripted-e2e';
    this.calls = 0;
  }

  get configured() {
    return true;
  }

  validateProviderConfig() {
    return { ok: true, issues: [] };
  }

  async getProviderHealth() {
    return { provider: this.name, configured: true, model: this.model, reachable: true, model_available: true, issues: [] };
  }

  async planTask({ userPayload }) {
    this.calls += 1;
    this.lastInstruction = userPayload.instruction;
    const plan = typeof this.plan === 'function' ? this.plan(userPayload) : this.plan;
    return { raw: plan, rawText: JSON.stringify(plan), usage: null };
  }

  normalizeProviderError(error) {
    return error;
  }
}

async function connectPhone(t, { accessibility = true, env, overrides } = {}) {
  const server = await startTestServer({ env, overrides });
  t.after(() => server.close());
  const paired = await pairDevice(server.baseUrl);
  const device = new FakeDevice({
    wsUrl: server.wsUrl,
    deviceId: paired.device_id,
    deviceToken: paired.device_token,
    accessibility,
  });
  t.after(() => device.close());
  await device.open();
  await device.hello();
  await device.waitFor('device_auth_ok');
  return { ...server, paired, device };
}

test('the vertical slice: pair, connect, plan, execute, report', async (t) => {
  const { baseUrl, paired, device } = await connectPhone(t);
  device.autoRespond(async (action) => {
    assert.equal(action.type, 'open_app');
    return { status: 'succeeded', result: { summary: 'YouTube opened', package_name: action.package_name } };
  });

  const created = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: paired.device_id, instruction: 'Open YouTube' }),
  });
  assert.equal(created.status, 202);
  const { task_id: taskId } = await created.json();

  const dispatch = await device.waitFor('task_dispatch', { timeoutMs: 5000 });
  assert.equal(dispatch.message.protocol_version, 1);
  assert.equal(dispatch.message.instruction, 'Open YouTube');

  const action = await device.waitFor('execute_action', { timeoutMs: 5000 });
  assert.equal(action.message.protocol_version, 1);
  assert.equal(action.message.sequence, 1);
  assert.equal(action.message.action.type, 'open_app');
  assert.equal(action.message.action.package_name, 'com.google.android.youtube');
  assert.ok(Date.parse(action.message.expires_at) > Date.now() - 1000);

  const task = await waitFor(async () => {
    const body = await (await fetch(`${baseUrl}/api/v1/tasks/${taskId}`, { headers: ownerHeaders() })).json();
    return ['completed', 'failed'].includes(body.status) ? body : null;
  }, { timeoutMs: 8000 });

  assert.equal(task.status, 'completed');
  assert.equal(task.completed_actions, 1);
  assert.match(task.result.summary, /Open YouTube/);
  assert.equal(task.result.actions.length, 1);
  assert.deepEqual(task.result.actions[0], {
    sequence: 1,
    type: 'open_app',
    status: 'succeeded',
    summary: 'YouTube opened',
  });

  const completedMessage = await device.waitFor('task_completed', { timeoutMs: 5000 });
  assert.equal(completedMessage.message.status, 'completed');
});

test('a task that the policy denies never reaches the device', async (t) => {
  const provider = new ScriptedProvider({
    task_summary: 'Wipe the device',
    requires_approval: false,
    actions: [{ type: 'type_text', text: '482913', target: { text: 'Verification code' } }],
  });
  const { baseUrl, paired, device } = await connectPhone(t, { overrides: { provider } });
  let actionsReceived = 0;
  device.autoRespond(async () => {
    actionsReceived += 1;
    return { status: 'succeeded' };
  });

  const created = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: paired.device_id, instruction: 'enter my code' }),
  });
  const { task_id: taskId } = await created.json();

  const task = await waitFor(async () => {
    const body = await (await fetch(`${baseUrl}/api/v1/tasks/${taskId}`, { headers: ownerHeaders() })).json();
    return ['completed', 'failed'].includes(body.status) ? body : null;
  }, { timeoutMs: 8000 });

  assert.equal(task.status, 'failed');
  assert.equal(task.error_code, 'ACTION_NOT_ALLOWED');
  assert.equal(actionsReceived, 0, 'a denied action must never be dispatched');
});

test('an unknown action type fails validation before dispatch', async (t) => {
  const provider = new ScriptedProvider({
    task_summary: 'Run a shell command',
    requires_approval: false,
    actions: [{ type: 'run_shell', command: 'rm -rf /' }],
  });
  const { baseUrl, paired, device } = await connectPhone(t, { overrides: { provider } });
  let actionsReceived = 0;
  device.autoRespond(async () => {
    actionsReceived += 1;
    return { status: 'succeeded' };
  });

  const created = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: paired.device_id, instruction: 'clean up storage' }),
  });
  const { task_id: taskId } = await created.json();

  const task = await waitFor(async () => {
    const body = await (await fetch(`${baseUrl}/api/v1/tasks/${taskId}`, { headers: ownerHeaders() })).json();
    return ['completed', 'failed'].includes(body.status) ? body : null;
  }, { timeoutMs: 8000 });

  assert.equal(task.status, 'failed');
  assert.equal(task.error_code, 'INVALID_AI_PLAN');
  assert.equal(actionsReceived, 0);
});

test('a sensitive task waits for approval and runs once approved', async (t) => {
  const provider = new ScriptedProvider({
    task_summary: 'Send the draft',
    requires_approval: false,
    actions: [{ type: 'tap_element', match: { text: 'Send' }, reason: 'Send the message' }],
  });
  const { baseUrl, paired, device } = await connectPhone(t, { overrides: { provider } });
  device.autoRespond(async () => ({ status: 'succeeded', result: { summary: 'tapped Send' } }));

  const created = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: paired.device_id, instruction: 'send the draft' }),
  });
  const { task_id: taskId } = await created.json();

  const pending = await waitFor(async () => {
    const body = await (await fetch(`${baseUrl}/api/v1/tasks/${taskId}`, { headers: ownerHeaders() })).json();
    return body.status === 'awaiting_approval' ? body : null;
  }, { timeoutMs: 8000 });
  assert.equal(pending.requires_approval, true);

  const approvalMessage = await device.waitFor('approval_required', { timeoutMs: 5000 });
  assert.ok(approvalMessage.message.reasons.length > 0);

  const approved = await fetch(`${baseUrl}/api/v1/tasks/${taskId}/approve`, { method: 'POST', headers: ownerHeaders() });
  assert.equal(approved.status, 200);

  const task = await waitFor(async () => {
    const body = await (await fetch(`${baseUrl}/api/v1/tasks/${taskId}`, { headers: ownerHeaders() })).json();
    return ['completed', 'failed'].includes(body.status) ? body : null;
  }, { timeoutMs: 8000 });
  assert.equal(task.status, 'completed');
  assert.equal(task.approval_state, 'approved');
});

test('a denied task is cancelled and never executes', async (t) => {
  const provider = new ScriptedProvider({
    task_summary: 'Send the draft',
    requires_approval: false,
    actions: [{ type: 'tap_element', match: { text: 'Send' } }],
  });
  const { baseUrl, paired, device } = await connectPhone(t, { overrides: { provider } });
  let executed = 0;
  device.autoRespond(async () => {
    executed += 1;
    return { status: 'succeeded' };
  });

  const created = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: paired.device_id, instruction: 'send the draft' }),
  });
  const { task_id: taskId } = await created.json();
  await waitFor(async () => {
    const body = await (await fetch(`${baseUrl}/api/v1/tasks/${taskId}`, { headers: ownerHeaders() })).json();
    return body.status === 'awaiting_approval' ? body : null;
  }, { timeoutMs: 8000 });

  const denied = await fetch(`${baseUrl}/api/v1/tasks/${taskId}/deny`, { method: 'POST', headers: ownerHeaders() });
  assert.equal(denied.status, 200);

  const body = await denied.json();
  assert.equal(body.status, 'cancelled');
  assert.equal(body.approval_state, 'denied');
  assert.equal(executed, 0);
});

test('a cancelled task stops mid-run and the device is told to stop', async (t) => {
  const provider = new ScriptedProvider({
    task_summary: 'Open YouTube and scroll',
    requires_approval: false,
    actions: [
      { type: 'open_app', package_name: 'com.google.android.youtube' },
      { type: 'scroll', direction: 'down' },
    ],
  });
  const { baseUrl, paired, device, server } = await connectPhone(t, { overrides: { provider } });

  const executed = [];
  device.autoRespond(async (action) => {
    executed.push(action.type);
    // Never answer the second action, so the task is still running when we cancel.
    if (action.type === 'scroll') return new Promise(() => {});
    return { status: 'succeeded', result: { summary: 'opened' } };
  });

  const created = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: paired.device_id, instruction: 'open youtube and scroll' }),
  });
  const { task_id: taskId } = await created.json();

  await device.waitFor('execute_action', { predicate: (message) => message.action.type === 'scroll' }, { timeoutMs: 5000 });

  const cancelled = await fetch(`${baseUrl}/api/v1/tasks/${taskId}/cancel`, { method: 'POST', headers: ownerHeaders() });
  assert.equal(cancelled.status, 200);

  const cancelMessage = await device.waitFor('cancel_task', { timeoutMs: 5000 });
  assert.equal(cancelMessage.message.task_id, taskId);
  assert.equal(cancelMessage.message.reason, 'user_cancelled');

  const task = await (await fetch(`${baseUrl}/api/v1/tasks/${taskId}`, { headers: ownerHeaders() })).json();
  assert.equal(task.status, 'cancelled');
  assert.equal(server.gateway.presence.isOnline(paired.device_id), true, 'cancelling must not drop the connection');
});

test('a device reported failure stops the task with the device error code', async (t) => {
  const provider = new ScriptedProvider({
    task_summary: 'Open an app that is missing',
    requires_approval: false,
    actions: [{ type: 'open_app', package_name: 'com.example.missing' }],
  });
  const { baseUrl, paired, device } = await connectPhone(t, { overrides: { provider } });
  device.autoRespond(async () => ({ status: 'failed', errorCode: 'APP_NOT_INSTALLED', message: 'The app is not installed' }));

  const created = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: paired.device_id, instruction: 'open the missing app' }),
  });
  const { task_id: taskId } = await created.json();

  const task = await waitFor(async () => {
    const body = await (await fetch(`${baseUrl}/api/v1/tasks/${taskId}`, { headers: ownerHeaders() })).json();
    return ['completed', 'failed'].includes(body.status) ? body : null;
  }, { timeoutMs: 10_000 });

  assert.equal(task.status, 'failed');
  assert.equal(task.error_code, 'APP_NOT_INSTALLED');
  assert.equal(task.actions[0].status, 'failed');
  assert.equal(task.actions[0].error_code, 'APP_NOT_INSTALLED');
});

test('a task stops when the device reports the screen is blocked', async (t) => {
  const provider = new ScriptedProvider({
    task_summary: 'Read the screen',
    requires_approval: false,
    actions: [{ type: 'read_visible_ui' }],
  });
  const { baseUrl, paired, device } = await connectPhone(t, { overrides: { provider } });
  device.autoRespond(async () => ({ status: 'failed', errorCode: 'SCREEN_BLOCKED', message: 'A secure window is active' }));

  const created = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: paired.device_id, instruction: 'read the screen' }),
  });
  const { task_id: taskId } = await created.json();

  const task = await waitFor(async () => {
    const body = await (await fetch(`${baseUrl}/api/v1/tasks/${taskId}`, { headers: ownerHeaders() })).json();
    return ['completed', 'failed'].includes(body.status) ? body : null;
  }, { timeoutMs: 10_000 });
  assert.equal(task.status, 'failed');
  assert.equal(task.error_code, 'SCREEN_BLOCKED');
});

test('screen context from a read is fed back into the next planning round', async (t) => {
  const provider = new ScriptedProvider((payload) => {
    if (payload.screen) {
      return {
        task_summary: 'Tap Settings',
        requires_approval: false,
        actions: [{ type: 'tap_element', match: { text: 'Settings' } }],
      };
    }
    return { task_summary: 'Inspect the screen', requires_approval: false, actions: [{ type: 'read_visible_ui' }] };
  });
  const { baseUrl, paired, device } = await connectPhone(t, { overrides: { provider } });

  const seen = [];
  device.autoRespond(async (action) => {
    seen.push(action.type);
    if (action.type === 'read_visible_ui') {
      return { status: 'succeeded', result: { summary: 'Settings is visible', visible_text: ['Settings'] } };
    }
    return { status: 'succeeded', result: { summary: 'tapped Settings' } };
  });

  const created = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: paired.device_id, instruction: 'find the settings button and tap it' }),
  });
  const { task_id: taskId } = await created.json();

  const task = await waitFor(async () => {
    const body = await (await fetch(`${baseUrl}/api/v1/tasks/${taskId}`, { headers: ownerHeaders() })).json();
    return ['completed', 'failed'].includes(body.status) ? body : null;
  }, { timeoutMs: 10_000 });

  assert.equal(task.status, 'completed');
  assert.deepEqual(seen, ['read_visible_ui', 'tap_element']);
  assert.equal(provider.calls, 2);
  assert.deepEqual(provider.lastInstruction, 'find the settings button and tap it');
});

test('a plan larger than the action budget is rejected before anything runs', async (t) => {
  const provider = new ScriptedProvider(() => ({
    task_summary: 'Scroll forever',
    requires_approval: false,
    actions: Array.from({ length: 5 }, () => ({ type: 'scroll', direction: 'down' })),
  }));
  const { baseUrl, paired, device } = await connectPhone(t, {
    env: { MAX_ACTIONS_PER_TASK: '3' },
    overrides: { provider },
  });
  let scrolls = 0;
  device.autoRespond(async () => {
    scrolls += 1;
    return { status: 'succeeded', result: { summary: 'scrolled' } };
  });

  const created = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: paired.device_id, instruction: 'scroll down' }),
  });
  const { task_id: taskId } = await created.json();

  const task = await waitFor(async () => {
    const body = await (await fetch(`${baseUrl}/api/v1/tasks/${taskId}`, { headers: ownerHeaders() })).json();
    return ['completed', 'failed'].includes(body.status) ? body : null;
  }, { timeoutMs: 10_000 });

  assert.equal(task.status, 'failed');
  assert.equal(task.error_code, 'INVALID_AI_PLAN');
  assert.equal(scrolls, 0, 'no action may run when the plan exceeds the budget');
});

test('a follow-up plan that exceeds the remaining budget stops the task', async (t) => {
  const provider = new ScriptedProvider((payload) => {
    if (payload.screen) {
      return {
        task_summary: 'Scroll five times',
        requires_approval: false,
        actions: Array.from({ length: 5 }, () => ({ type: 'scroll', direction: 'down' })),
      };
    }
    return { task_summary: 'Inspect the screen', requires_approval: false, actions: [{ type: 'read_visible_ui' }] };
  });
  const { baseUrl, paired, device } = await connectPhone(t, {
    env: { MAX_ACTIONS_PER_TASK: '4' },
    overrides: { provider },
  });
  const executed = [];
  device.autoRespond(async (action) => {
    executed.push(action.type);
    return { status: 'succeeded', result: { summary: 'ok', visible_text: ['Settings'] } };
  });

  const created = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: paired.device_id, instruction: 'scroll a lot' }),
  });
  const { task_id: taskId } = await created.json();

  const task = await waitFor(async () => {
    const body = await (await fetch(`${baseUrl}/api/v1/tasks/${taskId}`, { headers: ownerHeaders() })).json();
    return ['completed', 'failed'].includes(body.status) ? body : null;
  }, { timeoutMs: 10_000 });

  assert.equal(task.status, 'failed');
  assert.equal(task.error_code, 'INVALID_AI_PLAN');
  assert.deepEqual(executed, ['read_visible_ui'], 'only the actions that fit the budget may run');
  assert.ok(task.completed_actions <= 4);
});
