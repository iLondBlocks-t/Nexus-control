import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, pairDevice, FakeDevice, ownerHeaders, sleep, waitFor } from './helpers/testServer.js';

/** Pair a device and connect a fake phone, returning both. */
async function connectPairedDevice(baseUrl, wsUrl, options = {}) {
  const paired = await pairDevice(baseUrl);
  const device = new FakeDevice({ wsUrl, deviceId: paired.device_id, deviceToken: paired.device_token, ...options });
  await device.open();
  await device.hello();
  const auth = await device.waitFor('device_auth_ok', { timeoutMs: 5000 }).catch(() => null);
  return { paired, device, auth };
}

test('a paired device can authenticate over the WebSocket gateway', async (t) => {
  const { wsUrl, baseUrl, close } = await startTestServer();
  t.after(close);

  const { device, auth } = await connectPairedDevice(baseUrl, wsUrl);
  t.after(() => device.close());

  assert.ok(auth, 'the server must confirm authentication');
  assert.equal(auth.message.device_id, device.deviceId);
  assert.equal(auth.message.protocol_version, 1);
  assert.equal(auth.message.heartbeat_interval_ms, 1000);
});

test('a wrong device token is rejected and the socket is closed', async (t) => {
  const { wsUrl, baseUrl, close } = await startTestServer();
  t.after(close);

  const paired = await pairDevice(baseUrl);
  const device = new FakeDevice({ wsUrl, deviceId: paired.device_id, deviceToken: 'not-the-real-token' });
  t.after(() => device.close());
  await device.open();
  await device.hello();

  const failure = await device.waitFor('device_auth_failed', { timeoutMs: 5000 });
  assert.equal(failure.message.error_code, 'AUTHENTICATION_REQUIRED');
  await waitFor(() => device.socket.readyState === device.socket.CLOSED);
});

test('an unknown device is rejected with authentication required', async (t) => {
  const { wsUrl, close } = await startTestServer();
  t.after(close);

  const device = new FakeDevice({ wsUrl, deviceId: 'dev_does_not_exist', deviceToken: 'x'.repeat(40) });
  t.after(() => device.close());
  await device.open();
  await device.hello();
  const failure = await device.waitFor('device_auth_failed', { timeoutMs: 5000 });
  assert.equal(failure.message.error_code, 'AUTHENTICATION_REQUIRED');
});

test('a revoked device cannot connect', async (t) => {
  const { wsUrl, baseUrl, close } = await startTestServer();
  t.after(close);

  const paired = await pairDevice(baseUrl);
  await fetch(`${baseUrl}/api/v1/devices/${paired.device_id}/revoke`, { method: 'POST', headers: ownerHeaders() });

  const device = new FakeDevice({ wsUrl, deviceId: paired.device_id, deviceToken: paired.device_token });
  t.after(() => device.close());
  await device.open();
  await device.hello();
  const failure = await device.waitFor('device_auth_failed', { timeoutMs: 5000 });
  assert.equal(failure.message.error_code, 'DEVICE_REVOKED');
});

test('a message before authentication is rejected', async (t) => {
  const { wsUrl, baseUrl, close } = await startTestServer();
  t.after(close);

  const paired = await pairDevice(baseUrl);
  const device = new FakeDevice({ wsUrl, deviceId: paired.device_id, deviceToken: paired.device_token });
  t.after(() => device.close());
  await device.open();
  device.send({ protocol_version: 1, type: 'heartbeat' });

  const error = await device.waitFor('protocol_error', { timeoutMs: 5000 });
  assert.equal(error.message.error_code, 'AUTHENTICATION_REQUIRED');
  await waitFor(() => device.socket.readyState === device.socket.CLOSED);
});

test('the connection is closed when authentication never arrives', async (t) => {
  const { wsUrl, close } = await startTestServer({ env: { AUTH_TIMEOUT_MS: '2000' } });
  t.after(close);

  const device = new FakeDevice({ wsUrl, deviceId: 'dev_x', deviceToken: 'y' });
  t.after(() => device.close());
  await device.open();

  const failure = await device.waitFor('device_auth_failed', { timeoutMs: 6000 });
  assert.equal(failure.message.error_code, 'AUTHENTICATION_REQUIRED');
  await waitFor(() => device.socket.readyState === device.socket.CLOSED, { timeoutMs: 6000 });
});

test('malformed JSON produces a protocol error', async (t) => {
  const { wsUrl, baseUrl, close } = await startTestServer();
  t.after(close);

  const { device } = await connectPairedDevice(baseUrl, wsUrl);
  t.after(() => device.close());
  device.socket.send('{not json');

  const error = await device.waitFor('protocol_error', { timeoutMs: 5000 });
  assert.equal(error.message.error_code, 'INVALID_REQUEST');
});

test('an unsupported protocol version is rejected', async (t) => {
  const { wsUrl, baseUrl, close } = await startTestServer();
  t.after(close);

  const paired = await pairDevice(baseUrl);
  const device = new FakeDevice({ wsUrl, deviceId: paired.device_id, deviceToken: paired.device_token });
  t.after(() => device.close());
  await device.open();
  await device.hello({ protocolVersion: 99 });

  const error = await device.waitFor('protocol_error', { timeoutMs: 5000 });
  assert.equal(error.message.error_code, 'INVALID_PROTOCOL_VERSION');
});

test('unknown schema fields are rejected', async (t) => {
  const { wsUrl, baseUrl, close } = await startTestServer();
  t.after(close);

  const { device } = await connectPairedDevice(baseUrl, wsUrl);
  t.after(() => device.close());
  device.send({ protocol_version: 1, type: 'device_status', accessibility_enabled: true, surprise: 1 });

  const error = await device.waitFor('protocol_error', { timeoutMs: 5000 });
  assert.equal(error.message.error_code, 'INVALID_REQUEST');
  assert.match(error.message.message, /surprise/);
});

test('oversized messages close the connection', async (t) => {
  const { wsUrl, baseUrl, close } = await startTestServer({ env: { MAX_MESSAGE_BYTES: '4096' } });
  t.after(close);

  const { device } = await connectPairedDevice(baseUrl, wsUrl);
  t.after(() => device.close());
  device.send({ protocol_version: 1, type: 'device_status', accessibility_enabled: true, padding: 'x'.repeat(5000) });

  await waitFor(() => device.socket.readyState === device.socket.CLOSED, { timeoutMs: 6000 });
});

test('duplicate message ids are ignored', async (t) => {
  const { wsUrl, baseUrl, close } = await startTestServer();
  t.after(close);

  const { device } = await connectPairedDevice(baseUrl, wsUrl);
  t.after(() => device.close());

  const status = { protocol_version: 1, type: 'device_status', message_id: 'dup-1', accessibility_enabled: true };
  device.send(status);
  await device.waitFor('heartbeat_ack').catch(() => {});
  device.send({ protocol_version: 1, type: 'heartbeat', message_id: 'dup-1' });

  // The duplicate heartbeat must not produce a second acknowledgement.
  await device.waitFor('heartbeat_ack', { timeoutMs: 1000 }).then(
    () => {
      throw new Error('a duplicate message id must be ignored');
    },
    () => {},
  );
});

test('an unmatched action result is ignored without breaking the session', async (t) => {
  const { wsUrl, baseUrl, close } = await startTestServer();
  t.after(close);

  const { device } = await connectPairedDevice(baseUrl, wsUrl);
  t.after(() => device.close());

  device.send({
    protocol_version: 1,
    type: 'action_result',
    message_id: 'stale-1',
    task_id: 'task_missing',
    action_id: 'act_missing',
    sequence: 1,
    status: 'succeeded',
  });
  device.send({ protocol_version: 1, type: 'heartbeat', message_id: 'hb-1' });
  const ack = await device.waitFor('heartbeat_ack', { timeoutMs: 3000 });
  assert.equal(ack.message.type, 'heartbeat_ack');
});

test('the connection is rate limited', async (t) => {
  const { wsUrl, baseUrl, close } = await startTestServer({ env: { WS_MESSAGE_RATE_PER_MINUTE: '5' } });
  t.after(close);

  const { device } = await connectPairedDevice(baseUrl, wsUrl);
  t.after(() => device.close());

  for (let i = 0; i < 6; i += 1) {
    device.send({ protocol_version: 1, type: 'heartbeat', message_id: `hb-${i}` });
  }
  const error = await device.waitFor('protocol_error', { timeoutMs: 3000 });
  assert.equal(error.message.error_code, 'RATE_LIMITED');
});

test('a reconnecting device replaces its previous connection', async (t) => {
  const { wsUrl, baseUrl, server, close } = await startTestServer();
  t.after(close);

  const paired = await pairDevice(baseUrl);
  const first = new FakeDevice({ wsUrl, deviceId: paired.device_id, deviceToken: paired.device_token });
  await first.open();
  await first.hello();
  await first.waitFor('device_auth_ok');
  assert.equal(server.gateway.presence.size, 1);

  const second = new FakeDevice({ wsUrl, deviceId: paired.device_id, deviceToken: paired.device_token });
  t.after(() => second.close());
  await second.open();
  await second.hello();
  await second.waitFor('device_auth_ok');

  await waitFor(() => server.gateway.presence.size === 1 && server.gateway.isOnline(paired.device_id), { timeoutMs: 5000 });
  assert.equal(server.gateway.isOnline(paired.device_id), true);
  first.close();
});

test('a device that disconnects is marked offline', async (t) => {
  const { wsUrl, baseUrl, server, close } = await startTestServer();
  t.after(close);

  const { device, paired } = await connectPairedDevice(baseUrl, wsUrl);
  assert.equal(server.gateway.isOnline(paired.device_id), true);
  device.socket.close();
  await waitFor(() => !server.gateway.isOnline(paired.device_id), { timeoutMs: 5000 });
});

test('cancelling while an action is queued stops the task and notifies the device', async (t) => {
  const { wsUrl, baseUrl, close } = await startTestServer();
  t.after(close);

  const { device, paired } = await connectPairedDevice(baseUrl, wsUrl);
  // Deliberately never answer the action.
  const actionPromise = device.waitFor('execute_action', { timeoutMs: 5000 });

  const created = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: paired.device_id, instruction: 'Open YouTube' }),
  });
  const task = await created.json();
  const action = await actionPromise;
  assert.equal(action.message.action.type, 'open_app');

  const cancelled = await fetch(`${baseUrl}/api/v1/tasks/${task.task_id}/cancel`, {
    method: 'POST',
    headers: ownerHeaders(),
  });
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).status, 'cancelled');

  const cancelMessage = await device.waitFor('cancel_task', { timeoutMs: 5000 });
  assert.equal(cancelMessage.message.task_id, task.task_id);

  await sleep(100);
  const after = await fetch(`${baseUrl}/api/v1/tasks/${task.task_id}`, { headers: ownerHeaders() });
  assert.equal((await after.json()).status, 'cancelled');
});

test('the gateway reports statistics without leaking secrets', async (t) => {
  const { baseUrl, wsUrl, server, close } = await startTestServer();
  t.after(close);

  const { device } = await connectPairedDevice(baseUrl, wsUrl);
  t.after(() => device.close());

  const stats = server.gateway.stats();
  assert.equal(stats.protocolVersion, 1);
  assert.equal(stats.connections, 1);
  assert.ok(!JSON.stringify(stats).includes('token'));
});
