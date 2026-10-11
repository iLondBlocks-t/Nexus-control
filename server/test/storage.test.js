import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore } from '../src/storage/memoryStore.js';
import { JsonFileStore } from '../src/storage/jsonStore.js';
import { SqliteStore, isSqliteAvailable } from '../src/storage/sqliteStore.js';

const drivers = [
  ['memory', async () => new MemoryStore()],
  [
    'json',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-json-'));
      return new JsonFileStore({ file: path.join(dir, 'store.json') });
    },
  ],
];

const sampleTask = {
  id: 'task_1',
  ownerId: 'owner',
  deviceId: 'dev_1',
  instruction: 'Open YouTube',
  status: 'queued',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  actionCount: 2,
  completedActions: 0,
  requiresApproval: false,
  approvalState: 'not_required',
};

for (const [name, factory] of drivers) {
  test(`${name} driver round-trips devices, tasks and actions`, async (t) => {
    const store = await factory();
    t.after(() => store.close());

    await store.createDevice({
      id: 'dev_1',
      ownerId: 'owner',
      label: 'Phone',
      model: 'SM-J730F',
      androidVersion: '9',
      appVersion: '0.1.0',
      createdAt: new Date().toISOString(),
      connectionState: 'offline',
      revokedAt: null,
      tokenHash: 'hash-1',
      accessibilityEnabled: false,
      launcherPackages: ['com.google.android.youtube'],
    });

    const device = await store.getDevice('dev_1');
    assert.equal(device.label, 'Phone');
    assert.deepEqual(device.launcherPackages, ['com.google.android.youtube']);

    const byToken = await store.findDeviceByTokenHash('hash-1');
    assert.equal(byToken.id, 'dev_1');

    await store.createTask(sampleTask);
    await store.appendAction({
      id: 'act_1',
      taskId: 'task_1',
      sequence: 1,
      type: 'open_app',
      status: 'succeeded',
      createdAt: new Date().toISOString(),
      retryCount: 0,
      result: { summary: 'opened' },
    });

    const task = await store.getTask('task_1');
    assert.equal(task.instruction, 'Open YouTube');
    const actions = await store.listActions('task_1');
    assert.equal(actions.length, 1);
    assert.deepEqual(actions[0].result, { summary: 'opened' });

    const unfinished = await store.listUnfinishedTasks();
    assert.equal(unfinished.length, 1);

    await store.updateTask('task_1', { status: 'completed', finishedAt: new Date().toISOString() });
    assert.equal((await store.listUnfinishedTasks()).length, 0);
    assert.equal(await store.countUnfinishedTasksForDevice('dev_1'), 0);
  });
}

test('the json driver persists across a restart', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-json-restart-'));
  const file = path.join(dir, 'store.json');

  const first = new JsonFileStore({ file });
  await first.init();
  await first.createTask({ ...sampleTask, id: 'task_persist' });
  await first.setState('telegram.update_offset', 42);
  await first.close();

  const second = new JsonFileStore({ file });
  await second.init();
  t.after(() => second.close());

  const task = await second.getTask('task_persist');
  assert.equal(task.instruction, 'Open YouTube');
  assert.equal(await second.getState('telegram.update_offset'), 42);
});

test('pruning removes tasks older than the retention cutoff', async (t) => {
  const store = new MemoryStore();
  await store.init();
  t.after(() => store.close());

  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  await store.createTask({ ...sampleTask, id: 'task_old', finishedAt: old, status: 'completed' });
  await store.createTask({ ...sampleTask, id: 'task_new', status: 'queued' });

  const removed = await store.pruneTasksOlderThan(new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
  assert.equal(removed, 1);
  assert.equal(await store.getTask('task_old'), undefined);
  assert.ok(await store.getTask('task_new'));
});

test('expired pairing codes can be purged', async (t) => {
  const store = new MemoryStore();
  await store.init();
  t.after(() => store.close());

  await store.createPairing({
    id: 'pr_1',
    codeHash: 'hash',
    ownerId: 'owner',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() - 1000).toISOString(),
    failureCount: 0,
  });
  await store.createPairing({
    id: 'pr_2',
    codeHash: 'hash2',
    ownerId: 'owner',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    failureCount: 0,
  });

  assert.equal(await store.deleteExpiredPairings(Date.now()), 1);
  assert.equal((await store.listPairings()).length, 1);
});

const sqliteAvailable = await isSqliteAvailable();

test('the sqlite driver round-trips records', { skip: sqliteAvailable ? false : 'node:sqlite unavailable' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-sqlite-'));
  const store = new SqliteStore({ file: path.join(dir, 'nexus.db') });
  await store.init();
  t.after(() => store.close());

  await store.createDevice({
    id: 'dev_1',
    ownerId: 'owner',
    label: 'Phone',
    model: 'SM-J730F',
    androidVersion: '9',
    appVersion: '0.1.0',
    createdAt: new Date().toISOString(),
    connectionState: 'offline',
    revokedAt: null,
    tokenHash: 'hash-1',
    accessibilityEnabled: true,
    launcherPackages: ['com.android.settings'],
  });

  const device = await store.getDevice('dev_1');
  assert.equal(device.accessibilityEnabled, true);
  assert.deepEqual(device.launcherPackages, ['com.android.settings']);
  assert.equal((await store.findDeviceByTokenHash('hash-1')).id, 'dev_1');

  await store.createTask(sampleTask);
  await store.updateTask('task_1', { status: 'running', result: { summary: 'in progress' } });
  const task = await store.getTask('task_1');
  assert.equal(task.status, 'running');
  assert.deepEqual(task.result, { summary: 'in progress' });

  await store.appendAction({ id: 'act_1', taskId: 'task_1', sequence: 1, type: 'back', status: 'succeeded', createdAt: new Date().toISOString(), retryCount: 0 });
  assert.equal((await store.listActions('task_1')).length, 1);

  await store.setState('k', { a: 1 });
  assert.deepEqual(await store.getState('k'), { a: 1 });
});

test('sqlite survives a restart', { skip: sqliteAvailable ? false : 'node:sqlite unavailable' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexus-sqlite-restart-'));
  const file = path.join(dir, 'nexus.db');

  const first = new SqliteStore({ file });
  await first.init();
  await first.createTask({ ...sampleTask, id: 'task_keep' });
  await first.close();

  const second = new SqliteStore({ file });
  await second.init();
  t.after(() => second.close());
  assert.equal((await second.getTask('task_keep')).instruction, 'Open YouTube');
});
