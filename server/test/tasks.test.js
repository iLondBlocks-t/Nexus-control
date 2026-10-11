import test from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, isTerminal, isActive, assertTransition } from '../src/tasks/stateMachine.js';
import { startTestServer, pairDevice, FakeDevice, ownerHeaders, waitFor, sleep } from './helpers/testServer.js';
import { MemoryStore } from '../src/storage/memoryStore.js';

test('the state machine only allows documented transitions', () => {
  assert.equal(canTransition('queued', 'planning'), true);
  assert.equal(canTransition('planning', 'running'), true);
  assert.equal(canTransition('running', 'awaiting_approval'), true);
  assert.equal(canTransition('completed', 'running'), false);
  assert.equal(canTransition('cancelled', 'running'), false);
  assert.equal(isTerminal('completed'), true);
  assert.equal(isTerminal('running'), false);
  assert.equal(isActive('planning'), true);

  assert.throws(() => assertTransition('completed', 'running'), (error) => error.code === 'TASK_NOT_ACTIONABLE');
  assert.equal(assertTransition('failed', 'failed'), 'failed', 'terminal states are idempotent');
});

test('task creation validates the instruction', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const paired = await pairDevice(baseUrl);

  const post = (body) =>
    fetch(`${baseUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ownerHeaders() },
      body: JSON.stringify(body),
    });

  const empty = await post({ device_id: paired.device_id, instruction: '   ' });
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).error.code, 'INVALID_REQUEST');

  const tooLong = await post({ device_id: paired.device_id, instruction: 'x'.repeat(1001) });
  assert.equal(tooLong.status, 400);

  const controlChars = await post({ device_id: paired.device_id, instruction: 'opensettings' });
  assert.equal(controlChars.status, 400);

  const unknownDevice = await post({ device_id: 'dev_missing', instruction: 'Open YouTube' });
  assert.equal(unknownDevice.status, 404);
  assert.equal((await unknownDevice.json()).error.code, 'DEVICE_NOT_PAIRED');
});

test('task creation requires authentication', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);

  const response = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ device_id: 'dev_1', instruction: 'Open YouTube' }),
  });
  assert.equal(response.status, 401);
});

test('a task for an offline device fails with DEVICE_OFFLINE', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const paired = await pairDevice(baseUrl);

  const response = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: paired.device_id, instruction: 'Open YouTube' }),
  });
  assert.equal(response.status, 202);
  const created = await response.json();

  const task = await waitFor(async () => {
    const current = await fetch(`${baseUrl}/api/v1/tasks/${created.task_id}`, { headers: ownerHeaders() });
    const body = await current.json();
    return body.status !== 'queued' && body.status !== 'planning' ? body : null;
  }, { timeoutMs: 5000 });

  assert.equal(task.status, 'failed');
  assert.equal(task.error_code, 'DEVICE_OFFLINE');
});

test('a task on a device without accessibility fails with ACCESSIBILITY_NOT_ENABLED', async (t) => {
  const { baseUrl, wsUrl, close } = await startTestServer();
  t.after(close);
  const paired = await pairDevice(baseUrl);
  const device = new FakeDevice({
    wsUrl,
    deviceId: paired.device_id,
    deviceToken: paired.device_token,
    accessibility: false,
  });
  t.after(() => device.close());
  await device.open();
  await device.hello();
  await device.waitFor('device_auth_ok');

  const response = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: paired.device_id, instruction: 'Open YouTube' }),
  });
  const created = await response.json();

  const task = await waitFor(async () => {
    const current = await fetch(`${baseUrl}/api/v1/tasks/${created.task_id}`, { headers: ownerHeaders() });
    const body = await current.json();
    return ['failed', 'completed'].includes(body.status) ? body : null;
  }, { timeoutMs: 5000 });

  assert.equal(task.status, 'failed');
  assert.equal(task.error_code, 'ACCESSIBILITY_NOT_ENABLED');
});

test('only one automation task runs per device', async (t) => {
  const { baseUrl, wsUrl, close } = await startTestServer();
  t.after(close);
  const paired = await pairDevice(baseUrl);
  const device = new FakeDevice({ wsUrl, deviceId: paired.device_id, deviceToken: paired.device_token });
  t.after(() => device.close());
  await device.open();
  await device.hello();
  await device.waitFor('device_auth_ok');

  const first = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: paired.device_id, instruction: 'Open YouTube' }),
  });
  assert.equal(first.status, 202);
  // Wait until the first task is actually executing on the device.
  await device.waitFor('execute_action', { timeoutMs: 5000 });

  const second = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: paired.device_id, instruction: 'Open YouTube' }),
  });
  const secondBody = await second.json();

  const settled = await waitFor(async () => {
    const current = await fetch(`${baseUrl}/api/v1/tasks/${secondBody.task_id}`, { headers: ownerHeaders() });
    const body = await current.json();
    return ['failed', 'completed'].includes(body.status) ? body : null;
  }, { timeoutMs: 5000 });

  assert.equal(settled.status, 'failed');
  assert.equal(settled.error_code, 'DEVICE_BUSY');
});

test('a task is limited by the pending task budget', async (t) => {
  const { baseUrl, wsUrl, close } = await startTestServer({ env: { MAX_PENDING_TASKS_PER_DEVICE: '1' } });
  t.after(close);
  const paired = await pairDevice(baseUrl);
  const device = new FakeDevice({ wsUrl, deviceId: paired.device_id, deviceToken: paired.device_token });
  t.after(() => device.close());
  await device.open();
  await device.hello();
  await device.waitFor('device_auth_ok');

  const post = () =>
    fetch(`${baseUrl}/api/v1/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...ownerHeaders() },
      body: JSON.stringify({ device_id: paired.device_id, instruction: 'Open YouTube' }),
    });

  await post();
  // Hold the first task open by never answering its action.
  await device.waitFor('execute_action', { timeoutMs: 5000 });

  const second = await post();
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.code, 'TASK_LIMIT_EXCEEDED');
});

test('actions are persisted and exposed through the API', async (t) => {
  const { baseUrl, wsUrl, close } = await startTestServer();
  t.after(close);
  const paired = await pairDevice(baseUrl);
  const device = new FakeDevice({ wsUrl, deviceId: paired.device_id, deviceToken: paired.device_token });
  t.after(() => device.close());
  await device.open();
  await device.hello();
  await device.waitFor('device_auth_ok');
  device.autoRespond(async () => ({ status: 'succeeded', result: { summary: 'YouTube opened' } }));

  const created = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: paired.device_id, instruction: 'Open YouTube' }),
  });
  const { task_id: taskId } = await created.json();

  const task = await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/v1/tasks/${taskId}`, { headers: ownerHeaders() });
    const body = await response.json();
    return ['completed', 'failed'].includes(body.status) ? body : null;
  }, { timeoutMs: 8000 });

  assert.equal(task.status, 'completed');
  assert.equal(task.action_count, 1);
  assert.equal(task.completed_actions, 1);
  assert.equal(task.actions.length, 1);
  assert.equal(task.actions[0].type, 'open_app');
  assert.equal(task.actions[0].status, 'succeeded');
  assert.deepEqual(task.actions[0].result, { summary: 'YouTube opened' });
});

test('a device reported failure fails the task with the device error code', async (t) => {
  const { baseUrl, wsUrl, close } = await startTestServer();
  t.after(close);
  const paired = await pairDevice(baseUrl);
  const device = new FakeDevice({ wsUrl, deviceId: paired.device_id, deviceToken: paired.device_token });
  t.after(() => device.close());
  await device.open();
  await device.hello();
  await device.waitFor('device_auth_ok');
  device.autoRespond(async () => ({ status: 'failed', errorCode: 'APP_NOT_INSTALLED', message: 'YouTube is not installed' }));

  const created = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: paired.device_id, instruction: 'Open YouTube' }),
  });
  const { task_id: taskId } = await created.json();

  const task = await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/v1/tasks/${taskId}`, { headers: ownerHeaders() });
    const body = await response.json();
    return ['completed', 'failed'].includes(body.status) ? body : null;
  }, { timeoutMs: 10_000 });

  assert.equal(task.status, 'failed');
  assert.equal(task.error_code, 'APP_NOT_INSTALLED');
});

test('cancelling a finished task is rejected', async (t) => {
  const { baseUrl, wsUrl, close } = await startTestServer();
  t.after(close);
  const paired = await pairDevice(baseUrl);
  const device = new FakeDevice({ wsUrl, deviceId: paired.device_id, deviceToken: paired.device_token });
  t.after(() => device.close());
  await device.open();
  await device.hello();
  await device.waitFor('device_auth_ok');
  device.autoRespond();

  const created = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: paired.device_id, instruction: 'Open YouTube' }),
  });
  const { task_id: taskId } = await created.json();
  await waitFor(async () => {
    const body = await (await fetch(`${baseUrl}/api/v1/tasks/${taskId}`, { headers: ownerHeaders() })).json();
    return body.status === 'completed' ? body : null;
  }, { timeoutMs: 8000 });

  const cancel = await fetch(`${baseUrl}/api/v1/tasks/${taskId}/cancel`, { method: 'POST', headers: ownerHeaders() });
  assert.equal(cancel.status, 409);
  assert.equal((await cancel.json()).error.code, 'TASK_NOT_ACTIONABLE');
});

test('approving a task that is not awaiting approval is rejected', async (t) => {
  const { baseUrl, close } = await startTestServer();
  t.after(close);
  const paired = await pairDevice(baseUrl);

  const created = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: paired.device_id, instruction: 'Open YouTube' }),
  });
  const { task_id: taskId } = await created.json();
  await waitFor(async () => {
    const body = await (await fetch(`${baseUrl}/api/v1/tasks/${taskId}`, { headers: ownerHeaders() })).json();
    return body.status === 'failed' ? body : null;
  }, { timeoutMs: 5000 });

  const approve = await fetch(`${baseUrl}/api/v1/tasks/${taskId}/approve`, { method: 'POST', headers: ownerHeaders() });
  assert.equal(approve.status, 409);
});

test('expired tasks are swept up by the maintenance pass', async (t) => {
  const { baseUrl, close, server } = await startTestServer();
  t.after(close);
  const paired = await pairDevice(baseUrl);

  const created = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: paired.device_id, instruction: 'Open YouTube' }),
  });
  const { task_id: taskId } = await created.json();

  // Force the task into an unfinished state with a deadline in the past.
  await server.store.updateTask(taskId, {
    status: 'running',
    expiresAt: new Date(Date.now() - 1000).toISOString(),
  });

  const swept = await server.tasks.expireStale();
  assert.equal(swept, 1);

  const body = await (await fetch(`${baseUrl}/api/v1/tasks/${taskId}`, { headers: ownerHeaders() })).json();
  assert.equal(body.status, 'expired');
  assert.equal(body.error_code, 'TASK_EXPIRED');
});

test('unfinished tasks are not replayed after a server restart', async (t) => {
  const store = new MemoryStore();
  await store.init();

  const first = await startTestServer({ overrides: { storage: { store, driver: 'memory', persistent: false } } });
  const paired = await pairDevice(first.baseUrl);
  const device = new FakeDevice({
    wsUrl: first.wsUrl,
    deviceId: paired.device_id,
    deviceToken: paired.device_token,
  });
  t.after(() => device.close());
  await device.open();
  await device.hello();
  await device.waitFor('device_auth_ok');

  // "send" makes the offline mock planner propose a sensitive tap, so the task
  // parks in awaiting_approval: unfinished, with an unknown action state.
  const created = await fetch(`${first.baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: paired.device_id, instruction: 'send the message' }),
  });
  const { task_id: taskId } = await created.json();

  await waitFor(async () => {
    const body = await (await fetch(`${first.baseUrl}/api/v1/tasks/${taskId}`, { headers: ownerHeaders() })).json();
    return body.status === 'awaiting_approval' ? body : null;
  }, { timeoutMs: 5000 });

  await first.close();

  const second = await startTestServer({ overrides: { storage: { store, driver: 'memory', persistent: false } } });
  t.after(() => second.close());

  assert.equal(second.server.interruptedTasks, 1);
  const body = await (await fetch(`${second.baseUrl}/api/v1/tasks/${taskId}`, { headers: ownerHeaders() })).json();
  assert.equal(body.status, 'failed');
  assert.equal(body.error_code, 'INTERNAL_ERROR');
  assert.match(body.result.summary, /restart/i);
});

test('task history can be pruned by retention policy', async (t) => {
  const { baseUrl, close, server } = await startTestServer();
  t.after(close);
  const paired = await pairDevice(baseUrl);

  await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: paired.device_id, instruction: 'Open YouTube' }),
  });
  await waitFor(async () => (await server.store.listUnfinishedTasks()).length === 0, { timeoutMs: 5000 });

  for (const task of await server.store.listTasks({ ownerId: 'owner' })) {
    await server.store.updateTask(task.id, { finishedAt: new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString() });
  }

  const removed = await server.tasks.pruneHistory();
  assert.equal(removed, 1);
  assert.equal((await server.store.listTasks({ ownerId: 'owner' })).length, 0);
});

test('the executor stops when the device disappears mid-task', async (t) => {
  const { baseUrl, wsUrl, close } = await startTestServer();
  t.after(close);
  const paired = await pairDevice(baseUrl);
  const device = new FakeDevice({ wsUrl, deviceId: paired.device_id, deviceToken: paired.device_token });
  await device.open();
  await device.hello();
  await device.waitFor('device_auth_ok');

  const created = await fetch(`${baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: paired.device_id, instruction: 'Open YouTube' }),
  });
  const { task_id: taskId } = await created.json();
  await device.waitFor('execute_action', { timeoutMs: 5000 });

  device.socket.close();

  const body = await waitFor(async () => {
    const current = await (await fetch(`${baseUrl}/api/v1/tasks/${taskId}`, { headers: ownerHeaders() })).json();
    return ['failed', 'cancelled'].includes(current.status) ? current : null;
  }, { timeoutMs: 8000 });

  assert.equal(body.status, 'failed');
  assert.equal(body.error_code, 'DEVICE_OFFLINE');
  await sleep(50);
});
