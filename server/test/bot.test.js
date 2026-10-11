import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, pairDevice, FakeDevice, ownerHeaders, waitFor } from './helpers/testServer.js';
import { installMockFetch } from './helpers/mockFetch.js';
import { TelegramBot } from '../src/bot/telegram.js';
import { buildConfig } from '../src/config/index.js';
import { getLogger } from '../src/logging/logger.js';

const CHAT_ID = 1001;
const USER_ID = 42;

async function setup(t, { connectDevice = true } = {}) {
  const server = await startTestServer();
  t.after(() => server.close());
  const paired = await pairDevice(server.baseUrl);

  let device = null;
  if (connectDevice) {
    device = new FakeDevice({ wsUrl: server.wsUrl, deviceId: paired.device_id, deviceToken: paired.device_token });
    t.after(() => device.close());
    await device.open();
    await device.hello();
    await device.waitFor('device_auth_ok');
    device.autoRespond(async () => ({ status: 'succeeded', result: { summary: 'done' } }));
  }

  const fetchMock = installMockFetch({ match: (url) => url.includes('api.telegram.org') });
  t.after(() => fetchMock.restore());

  const { config } = buildConfig(
    {
      NODE_ENV: 'development',
      OWNER_API_TOKENS: 'owner',
      TELEGRAM_ENABLED: 'true',
      TELEGRAM_BOT_TOKEN: `${USER_ID}0:AAFakeTokenForTestsOnly123456789012345678`,
      TELEGRAM_ALLOWED_USER_IDS: String(USER_ID),
      TELEGRAM_ALLOWED_CHAT_IDS: String(CHAT_ID),
      LOG_LEVEL: 'silent',
    },
    { skipEnvFile: true },
  );

  const bot = new TelegramBot({
    config: config.telegram,
    tasks: server.server.tasks,
    registry: server.server.registry,
    executor: server.server.executor,
    logger: getLogger({ component: 'bot-test' }),
    store: server.server.store,
    pairing: server.server.pairing,
  });

  /** Queue one update and drive a single poll cycle. */
  const deliver = async (text, { userId = USER_ID, chatId = CHAT_ID } = {}) => {
    fetchMock.queue({ body: { ok: true, result: [{ update_id: Math.floor(Math.random() * 1e6), message: { message_id: 1, chat: { id: chatId }, from: { id: userId }, text } }] } });
    await bot.handleUpdate({
      update_id: 1,
      message: { message_id: 1, chat: { id: chatId }, from: { id: userId }, text },
    });
    return fetchMock.calls.filter((call) => call.url.includes('/sendMessage'));
  };

  return { server, paired, device, bot, fetchMock, deliver };
}

test('the bot ignores senders that are not allowed', async (t) => {
  const { deliver } = await setup(t);
  const sent = await deliver('/help', { userId: 999 });
  assert.equal(sent.length, 0, 'an unknown Telegram user id must be ignored entirely');
});

test('the bot ignores a chat that is not allowed even for a known user', async (t) => {
  const { deliver } = await setup(t);
  const sent = await deliver('/help', { chatId: 4242 });
  assert.equal(sent.length, 0);
});

test('/help lists the available commands', async (t) => {
  const { deliver } = await setup(t);
  const sent = await deliver('/help');
  assert.equal(sent.length, 1);
  const body = JSON.parse(sent[0].options.body);
  assert.match(body.text, /\/run/);
  assert.match(body.text, /\/cancel/);
  assert.match(body.text, /\/devices/);
});

test('/run sends a task to the device and reports completion', async (t) => {
  const { server, deliver } = await setup(t);
  const accepted = await deliver('/run Open YouTube');
  assert.ok(accepted.length >= 1);
  assert.match(JSON.parse(accepted[0].options.body).text, /Task accepted/);

  const taskId = JSON.parse(accepted[0].options.body).text.match(/task_[a-z0-9]+/)[0];
  const task = await waitFor(async () => {
    const body = await (await fetch(`${server.baseUrl}/api/v1/tasks/${taskId}`, { headers: ownerHeaders() })).json();
    return ['completed', 'failed'].includes(body.status) ? body : null;
  }, { timeoutMs: 8000 });

  assert.equal(task.status, 'completed');
});

test('/run without an instruction explains the usage', async (t) => {
  const { deliver } = await setup(t);
  const sent = await deliver('/run');
  assert.match(JSON.parse(sent[0].options.body).text, /Usage: \/run/);
});

test('/task reports the progress of a task', async (t) => {
  const { server, paired, deliver } = await setup(t);
  const created = await fetch(`${server.baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: paired.device_id, instruction: 'Open YouTube' }),
  });
  const { task_id: taskId } = await created.json();
  await waitFor(async () => {
    const body = await (await fetch(`${server.baseUrl}/api/v1/tasks/${taskId}`, { headers: ownerHeaders() })).json();
    return ['completed', 'failed'].includes(body.status) ? body : null;
  }, { timeoutMs: 8000 });

  const sent = await deliver(`/task ${taskId}`);
  const body = JSON.parse(sent[0].options.body);
  assert.match(body.text, new RegExp(taskId));
  assert.match(body.text, /status:/);
});

test('/stop cancels unfinished tasks', async (t) => {
  const { server, paired, deliver } = await setup(t, { connectDevice: false });
  const created = await fetch(`${server.baseUrl}/api/v1/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ device_id: paired.device_id, instruction: 'Open YouTube' }),
  });
  const { task_id: taskId } = await created.json();
  await waitFor(async () => {
    const body = await (await fetch(`${server.baseUrl}/api/v1/tasks/${taskId}`, { headers: ownerHeaders() })).json();
    return body.status === 'failed' ? body : null;
  }, { timeoutMs: 5000 });

  // Put a task back into an unfinished state so /stop has something to cancel.
  await server.server.store.updateTask(taskId, { status: 'running' });
  const sent = await deliver('/stop');
  assert.match(JSON.parse(sent[0].options.body).text, /Stopped 1 unfinished task/);
});

test('/pair issues a code and never exposes device tokens', async (t) => {
  const { deliver } = await setup(t);
  const sent = await deliver('/pair');
  const body = JSON.parse(sent[0].options.body);
  assert.match(body.text, /Pairing code: [A-Z0-9]{4}-[A-Z0-9]{4}/);
  assert.match(body.text, /Expires at/);
  assert.ok(!body.text.includes('device_token'));
});

test('the bot rate limits a flooding sender', async (t) => {
  const { deliver } = await setup(t);
  let limited = false;
  for (let i = 0; i < 22; i += 1) {
    const sent = await deliver('/help');
    const last = sent[sent.length - 1];
    if (last && JSON.parse(last.options.body).text.includes('Rate limit')) limited = true;
  }
  assert.equal(limited, true, 'a flooding sender must be throttled');
});

test('plain text is not treated as a command', async (t) => {
  const { deliver } = await setup(t);
  const sent = await deliver('open youtube please');
  assert.match(JSON.parse(sent[0].options.body).text, /Send a command/);
});

test('bot messages are split so they stay inside the Telegram limit', async (t) => {
  const { deliver } = await setup(t);
  await deliver('/devices');
  const sent = (await deliver('/help'))[0];
  const body = JSON.parse(sent.options.body);
  assert.ok(body.text.length <= 3900);
});

test('the bot never sends the bot token in a message body', async (t) => {
  const { deliver, fetchMock } = await setup(t);
  await deliver('/help');
  await deliver('/devices');
  for (const call of fetchMock.calls) {
    const body = call.options?.body ?? '';
    assert.ok(!body.includes('AAFakeTokenForTestsOnly'), 'message bodies must not contain the token');
  }
});
