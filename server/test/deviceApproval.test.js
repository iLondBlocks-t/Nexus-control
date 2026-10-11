import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, pairDevice, FakeDevice, ownerHeaders, waitFor } from './helpers/testServer.js';

/**
 * Approving and denying from the phone.
 *
 * The Android app has no owner API token, so decisions taken on the device
 * travel over its authenticated socket. These tests prove the server still
 * enforces ownership: a device may only decide on its own tasks.
 */

/** A plan whose single action lands in the sensitive bucket. */
class ApprovalProvider {
  constructor() {
    this.name = 'approval-scripted';
    this.model = 'approval-scripted-v1';
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

  async planTask() {
    this.calls += 1;
    return {
      raw: {
        task_summary: 'Send the draft',
        requires_approval: false,
        actions: [{ type: 'tap_element', match: { text: 'Send' }, reason: 'Send the message' }],
      },
      rawText: '{}',
      usage: null,
    };
  }

  normalizeProviderError(error) {
    return error;
  }
}

async function connectPhone(t, { env = {}, overrides = {} } = {}) {
  const server = await startTestServer({ env, overrides });
  t.after(() => server.close());
  const paired = await pairDevice(server.baseUrl);
  const device = new FakeDevice({
    wsUrl: server.wsUrl,
    deviceId: paired.device_id,
    deviceToken: paired.device_token,
    accessibility: true,
  });
  t.after(() => device.close());
  await device.open();
  await device.hello();
  await device.waitFor('device_auth_ok', { timeoutMs: 5000 });
  return { ...server, paired, device };
}

/** Submit a task from the phone and wait until it parks for approval. */
async function submitSensitiveTask(device, instruction = 'send the draft') {
  device.send({ protocol_version: 1, type: 'task_create', request_id: 'req-approval', instruction });
  const accepted = await device.waitFor('task_accepted', { timeoutMs: 5000 });
  await device.waitFor('approval_required', { timeoutMs: 8000 });
  return accepted.message.task_id;
}

test('the phone can approve a task that is waiting for approval', async (t) => {
  const { device, baseUrl } = await connectPhone(t, { overrides: { provider: new ApprovalProvider() } });
  device.autoRespond(async () => ({ status: 'succeeded', result: { summary: 'tapped Send' } }));

  const taskId = await submitSensitiveTask(device);
  device.send({ protocol_version: 1, type: 'task_approve', task_id: taskId });

  const result = await device.waitFor('approval_result', { timeoutMs: 5000 });
  assert.equal(result.message.task_id, taskId);
  assert.equal(result.message.approved, true);
  assert.equal(result.message.error_code, undefined);

  const finished = await waitFor(async () => {
    const body = await (await fetch(`${baseUrl}/api/v1/tasks/${taskId}`, { headers: ownerHeaders() })).json();
    return ['completed', 'failed'].includes(body.status) ? body : null;
  }, { timeoutMs: 8000 });
  assert.equal(finished.status, 'completed');
  assert.equal(finished.approval_state, 'approved');
});

test('the phone can deny a task and it never executes', async (t) => {
  const { device, baseUrl } = await connectPhone(t, { overrides: { provider: new ApprovalProvider() } });
  let executed = 0;
  device.autoRespond(async () => {
    executed += 1;
    return { status: 'succeeded' };
  });

  const taskId = await submitSensitiveTask(device);
  device.send({ protocol_version: 1, type: 'task_deny', task_id: taskId });

  const result = await device.waitFor('approval_result', { timeoutMs: 5000 });
  assert.equal(result.message.approved, false);
  assert.equal(result.message.status, 'cancelled');

  const body = await (await fetch(`${baseUrl}/api/v1/tasks/${taskId}`, { headers: ownerHeaders() })).json();
  assert.equal(body.status, 'cancelled');
  assert.equal(body.approval_state, 'denied');
  assert.equal(executed, 0);
});

test('a device cannot decide on a task that belongs to another device', async (t) => {
  const { device, baseUrl } = await connectPhone(t, { overrides: { provider: new ApprovalProvider() } });
  device.autoRespond(async () => ({ status: 'succeeded' }));

  // A second, unrelated device.
  const other = await pairDevice(baseUrl);
  const created = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: other.device_id, instruction: 'send the draft' }),
  });
  const { task_id: otherTaskId } = await created.json();

  device.send({ protocol_version: 1, type: 'task_approve', task_id: otherTaskId });
  const result = await device.waitFor('approval_result', { timeoutMs: 5000 });
  assert.equal(result.message.error_code, 'PERMISSION_DENIED');
  assert.equal(result.message.approved, true);
});

test('approving an unknown task reports not found', async (t) => {
  const { device } = await connectPhone(t, { overrides: { provider: new ApprovalProvider() } });

  device.send({ protocol_version: 1, type: 'task_approve', task_id: 'task_does_not_exist' });
  const result = await device.waitFor('approval_result', { timeoutMs: 5000 });
  assert.equal(result.message.error_code, 'NOT_FOUND');
});

test('approving a task that is not waiting for approval is refused', async (t) => {
  const { device } = await connectPhone(t);
  device.autoRespond(async () => ({ status: 'succeeded', result: { summary: 'ok' } }));

  device.send({ protocol_version: 1, type: 'task_create', request_id: 'req-plain', instruction: 'Open YouTube' });
  const accepted = await device.waitFor('task_accepted', { timeoutMs: 5000 });

  device.send({ protocol_version: 1, type: 'task_approve', task_id: accepted.message.task_id });
  const result = await device.waitFor('approval_result', { timeoutMs: 5000 });
  assert.equal(result.message.error_code, 'TASK_NOT_ACTIONABLE');
});
