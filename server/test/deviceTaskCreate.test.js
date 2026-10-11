import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, pairDevice, FakeDevice, waitFor } from './helpers/testServer.js';

/**
 * Task creation from the phone itself.
 *
 * The Android app has no owner API token (by design), so it submits the
 * instruction over its own authenticated socket. These tests prove the request
 * still goes through the shared TaskService, the planner, the policy engine and
 * the same rate limits as the HTTP API.
 */
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

test('a phone can submit a task over its socket and it runs end to end', async (t) => {
  const { device } = await connectPhone(t);
  device.autoRespond(async (action) => ({
    status: 'succeeded',
    result: { summary: 'YouTube opened', package_name: action.package_name },
  }));

  device.send({
    protocol_version: 1,
    type: 'task_create',
    request_id: 'req-1',
    instruction: 'Open YouTube',
  });

  const accepted = await device.waitFor('task_accepted', { timeoutMs: 5000 });
  assert.equal(accepted.message.request_id, 'req-1');
  assert.equal(accepted.message.status, 'queued');
  assert.match(accepted.message.task_id, /^task_/);

  const dispatch = await device.waitFor('task_dispatch', { timeoutMs: 5000 });
  assert.equal(dispatch.message.task_id, accepted.message.task_id);
  assert.equal(dispatch.message.instruction, 'Open YouTube');

  const action = await device.waitFor('execute_action', { timeoutMs: 5000 });
  assert.equal(action.message.action.type, 'open_app');
  assert.equal(action.message.sequence, 1);

  const completed = await device.waitFor('task_completed', { timeoutMs: 5000 });
  assert.equal(completed.message.status, 'completed');
  assert.equal(completed.message.task_id, accepted.message.task_id);
});

test('a task submitted by a phone is recorded with source "device"', async (t) => {
  const { device, baseUrl, paired } = await connectPhone(t);
  device.autoRespond(async () => ({ status: 'succeeded', result: { summary: 'ok' } }));

  device.send({
    protocol_version: 1,
    type: 'task_create',
    request_id: 'req-source',
    instruction: 'Open YouTube',
  });
  const accepted = await device.waitFor('task_accepted', { timeoutMs: 5000 });
  await device.waitFor('task_completed', { timeoutMs: 5000 });

  const response = await fetch(`${baseUrl}/api/v1/tasks/${accepted.message.task_id}`, {
    headers: { authorization: 'Bearer test-owner-token' },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.task_id, accepted.message.task_id);
  assert.equal(body.device_id, paired.device_id);
  assert.equal(body.source, 'device');
});

test('an empty instruction is refused before a task is created', async (t) => {
  const { device } = await connectPhone(t);

  device.send({
    protocol_version: 1,
    type: 'task_create',
    request_id: 'req-empty',
    instruction: '',
  });

  const error = await device.waitFor('protocol_error', { timeoutMs: 5000 });
  assert.equal(error.message.error_code, 'INVALID_REQUEST');
  // Nothing was queued, so no task_accepted may ever arrive.
  await assert.rejects(device.waitFor('task_accepted', { timeoutMs: 400 }));
});

test('an over-long instruction is refused', async (t) => {
  const { device } = await connectPhone(t);

  device.send({
    protocol_version: 1,
    type: 'task_create',
    request_id: 'req-long',
    instruction: 'x'.repeat(1001),
  });

  const error = await device.waitFor('protocol_error', { timeoutMs: 5000 });
  assert.equal(error.message.error_code, 'INVALID_REQUEST');
});

test('a phone that floods task_create is rate limited', async (t) => {
  const { device } = await connectPhone(t, { env: { TASK_CREATE_RATE_PER_MINUTE: '1' } });
  device.autoRespond(async () => ({ status: 'succeeded', result: { summary: 'ok' } }));

  device.send({
    protocol_version: 1,
    type: 'task_create',
    request_id: 'req-a',
    instruction: 'Open YouTube',
  });
  const first = await device.waitFor('task_accepted', { timeoutMs: 5000 });
  assert.equal(first.message.request_id, 'req-a');

  device.send({
    protocol_version: 1,
    type: 'task_create',
    request_id: 'req-b',
    instruction: 'Open YouTube',
  });
  const rejected = await device.waitFor('task_rejected', { timeoutMs: 5000 });
  assert.equal(rejected.message.request_id, 'req-b');
  assert.equal(rejected.message.error_code, 'RATE_LIMITED');
  assert.match(rejected.message.message, /too many/i);
});

test('task_create before authentication is refused', async (t) => {
  const { wsUrl, close } = await startTestServer();
  t.after(close);
  const device = new FakeDevice({ wsUrl, deviceId: 'dev_x', deviceToken: 'y'.repeat(40) });
  t.after(() => device.close());
  await device.open();

  device.send({
    protocol_version: 1,
    type: 'task_create',
    request_id: 'req-anon',
    instruction: 'Open YouTube',
  });

  const error = await device.waitFor('protocol_error', { timeoutMs: 5000 });
  assert.equal(error.message.error_code, 'AUTHENTICATION_REQUIRED');
  await waitFor(() => device.socket.readyState === device.socket.CLOSED);
});
