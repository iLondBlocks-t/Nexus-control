import { WebSocket } from 'ws';
import { createServer } from '../../src/index.js';

/**
 * Boots a real server instance on an ephemeral port with safe test defaults.
 * Every test gets an isolated in-memory store.
 */
export async function startTestServer({ env = {}, overrides = {}, logLevel = 'error' } = {}) {
  const server = await createServer({
    env: {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      STORAGE_DRIVER: 'memory',
      AI_PROVIDER: 'mock',
      OWNER_API_TOKENS: 'test-owner-token',
      LOG_LEVEL: logLevel,
      LOG_FORMAT: 'json',
      HEARTBEAT_INTERVAL_MS: '1000',
      HEARTBEAT_TIMEOUT_MS: '2500',
      ...env,
    },
    overrides,
  });
  await server.listen(0, '127.0.0.1');
  const port = server.server.address().port;
  return {
    server,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/api/v1/device`,
    close: () => server.close(),
  };
}

export const OWNER_TOKEN = 'test-owner-token';

export function ownerHeaders(extra = {}) {
  return { authorization: `Bearer ${OWNER_TOKEN}`, ...extra };
}

/** Minimal fake Android client speaking the real protocol. */
export class FakeDevice {
  constructor({ wsUrl, deviceId, deviceToken, appVersion = '0.1.0', androidVersion = '9', accessibility = true }) {
    this.deviceId = deviceId;
    this.deviceToken = deviceToken;
    this.appVersion = appVersion;
    this.androidVersion = androidVersion;
    this.accessibility = accessibility;
    this.inbox = [];
    this.waiters = [];
    this.socket = new WebSocket(wsUrl, { perMessageDeflate: false });
    this.socket.on('message', (data) => {
      const message = JSON.parse(data.toString());
      this.inbox.push(message);
      this.#notify();
    });
    this.socket.on('error', () => {});
    this.opened = new Promise((resolve, reject) => {
      this.socket.once('open', resolve);
      this.socket.once('error', reject);
    });
  }

  #notify() {
    for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.waiters[i];
      const index = this.inbox.findIndex((message, position) => position >= waiter.cursor && waiter.match(message));
      if (index !== -1) {
        this.waiters.splice(i, 1);
        waiter.resolve({ message: this.inbox[index], cursor: index + 1 });
      }
    }
  }

  async open() {
    await this.opened;
  }

  async hello({ protocolVersion = 1, deviceId = this.deviceId, deviceToken = this.deviceToken } = {}) {
    this.send({
      protocol_version: protocolVersion,
      type: 'device_hello',
      device_id: deviceId,
      device_token: deviceToken,
      client: {
        app_version: this.appVersion,
        android_version: this.androidVersion,
        device_model: 'SM-J730F',
        accessibility_enabled: this.accessibility,
      },
    });
  }

  send(message) {
    this.socket.send(JSON.stringify(message));
  }

  /** Wait for the first queued (or future) message matching `match`. */
  waitFor(type, { predicate = () => true, timeoutMs = 5000, cursor = 0 } = {}) {
    const match = (message) => message.type === type && predicate(message);
    const index = this.inbox.findIndex((message, position) => position >= cursor && match(message));
    if (index !== -1) return Promise.resolve({ message: this.inbox[index], cursor: index + 1 });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timed out waiting for a "${type}" message.`)),
        timeoutMs,
      );
      this.waiters.push({
        cursor,
        match,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
      this.#notify();
    });
  }

  /**
   * Automatically answer every `execute_action` with `handler(action)`.
   * handler may return {status, result, errorCode} or throw to ignore.
   */
  autoRespond(handler = async () => ({ status: 'succeeded', result: { summary: 'ok' } })) {
    this.socket.on('message', async (data) => {
      const message = JSON.parse(data.toString());
      if (message.type !== 'execute_action') return;
      const outcome = await handler(message.action, message);
      this.send({
        protocol_version: 1,
        type: 'action_result',
        message_id: `res-${message.action_id}`,
        task_id: message.task_id,
        action_id: message.action_id,
        sequence: message.sequence,
        status: outcome.status ?? 'succeeded',
        error_code: outcome.errorCode,
        message: outcome.message,
        duration_ms: outcome.durationMs ?? 25,
        ...(outcome.result ? { result: outcome.result } : {}),
      });
    });
  }

  async reportStatus(accessibilityEnabled = this.accessibility) {
    this.send({
      protocol_version: 1,
      type: 'device_status',
      message_id: 'status-1',
      accessibility_enabled: accessibilityEnabled,
    });
    await this.waitFor('heartbeat_ack').catch(() => {});
  }

  close() {
    try {
      this.socket.close();
    } catch {
      /* already closed */
    }
  }
}

/** Complete the pairing flow over HTTP and return the device credentials. */
export async function pairDevice(baseUrl, { client = { app_version: '0.1.0', android_version: '9' } } = {}) {
  const created = await fetch(`${baseUrl}/api/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...ownerHeaders() },
    body: JSON.stringify({ action: 'create', label: 'Test phone' }),
  });
  const { code } = await created.json();
  const completed = await fetch(`${baseUrl}/api/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'complete', code, client }),
  });
  const body = await completed.json();
  return { code, ...body, status: completed.status };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `predicate` returns a truthy value, or fail after `timeoutMs`. */
export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('waitFor: timed out');
    await sleep(intervalMs);
  }
}
