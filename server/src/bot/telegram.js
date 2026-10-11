import { RateLimiter } from '../utils/rateLimit.js';
import { AppError } from '../utils/errors.js';

/**
 * Telegram Bot API adapter (long polling).
 *
 * The bot never touches a phone. It authenticates the sender, then calls the same
 * task service the HTTP API uses, so every safety rule applies identically.
 *
 * Reference: https://core.telegram.org/bots/api
 */

const MAX_MESSAGE_LENGTH = 3900;
const POLL_ERROR_BACKOFF_MS = 5000;

export class TelegramBot {
  constructor({ config, tasks, registry, executor, logger, store, pairing }) {
    this.config = config;
    this.tasks = tasks;
    this.registry = registry;
    this.executor = executor;
    this.logger = logger;
    this.store = store ?? null;
    this.pairing = pairing ?? null;
    this.name = 'telegram';
    this.enabled = true;
    this.running = false;
    this.offsetKey = 'telegram.update_offset';
    this.limiter = new RateLimiter({ limit: 20, windowMs: 60_000 });
    this.ownerChatId = config.allowedChatIds[0] ?? null;
    this.allowedUserIds = new Set(config.allowedUserIds);
    this.allowedChatIds = new Set(config.allowedChatIds);
  }

  get apiBase() {
    return `${this.config.apiBaseUrl}/bot${this.config.botToken}`;
  }

  async start() {
    if (this.running) return;
    this.running = true;
    if (!this.store) {
      this.logger.warn('bot.no_store', { message: 'Bot started without a store; update offsets will not persist.' });
    }
    void this.#pollLoop();
    this.logger.info('bot.started', {
      provider: 'telegram',
      allowedUsers: this.allowedUserIds.size,
      allowedChats: this.allowedChatIds.size,
    });
  }

  async stop() {
    this.running = false;
  }

  attachStore(store) {
    this.store = store;
  }

  status() {
    return {
      enabled: true,
      provider: 'telegram',
      running: this.running,
      allowed_user_ids: [...this.allowedUserIds],
      allowed_chat_ids: [...this.allowedChatIds],
    };
  }

  /* ------------------------------------------------------------------ */

  async #pollLoop() {
    while (this.running) {
      try {
        const updates = await this.#getUpdates();
        for (const update of updates) {
          await this.handleUpdate(update).catch((error) => {
            this.logger.error('bot.update_failed', { error: error.message, updateId: update.update_id });
          });
        }
      } catch (error) {
        this.logger.error('bot.poll_failed', { error: error.message });
        await sleep(POLL_ERROR_BACKOFF_MS);
      }
    }
  }

  async #getUpdates() {
    const offset = (await this.store?.getState(this.offsetKey)) ?? undefined;
    const payload = {
      timeout: this.config.pollTimeoutSeconds,
      allowed_updates: ['message'],
      limit: 50,
    };
    if (typeof offset === 'number') payload.offset = offset + 1;

    const response = await fetch(`${this.apiBase}/getUpdates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout((this.config.pollTimeoutSeconds + 10) * 1000),
    });

    if (!response.ok) {
      throw new Error(`getUpdates failed with HTTP ${response.status}`);
    }
    const data = await response.json();
    if (!data.ok) throw new Error(`getUpdates error: ${data.description ?? 'unknown'}`);

    const updates = Array.isArray(data.result) ? data.result : [];
    if (updates.length) {
      const highest = updates[updates.length - 1].update_id;
      await this.store?.setState(this.offsetKey, highest);
    }
    return updates;
  }

  async callApi(method, payload = {}) {
    const response = await fetch(`${this.apiBase}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) {
      throw new Error(`Telegram ${method} failed with HTTP ${response.status}`);
    }
    const data = await response.json();
    if (!data.ok) throw new Error(`Telegram ${method} error: ${data.description ?? 'unknown'}`);
    return data.result;
  }

  async sendMessage(chatId, text, extra = {}) {
    const chunks = chunkText(String(text), MAX_MESSAGE_LENGTH);
    for (const chunk of chunks) {
      await this.callApi('sendMessage', {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
        ...extra,
      }).catch((error) => this.logger.error('bot.send_failed', { error: error.message, chatId }));
    }
  }

  /* ------------------------------------------------------------------ */

  async handleUpdate(update) {
    const message = update?.message;
    if (!message) return;
    const chatId = message?.chat?.id;
    const userId = message?.from?.id;
    const text = String(message?.text ?? '').trim();
    if (!text) return;

    if (!this.#isAuthorized(userId, chatId)) {
      this.logger.warn('bot.unauthorized_sender', { userId, chatId });
      return;
    }

    const rate = this.limiter.consume(String(userId));
    if (!rate.allowed) {
      await this.sendMessage(chatId, 'Rate limit reached. Wait a minute and try again.');
      return;
    }

    if (!text.startsWith('/')) {
      await this.sendMessage(
        chatId,
        'Send a command to control NEXUS. Use /help to see what is available, or /run <task> to start one.',
      );
      return;
    }

    const [rawCommand, ...rest] = text.split(/\s+/);
    const command = rawCommand.split('@')[0].toLowerCase();
    const argument = rest.join(' ').trim();
    this.ownerChatId = chatId;

    switch (command) {
      case '/help':
        return this.#help(chatId);
      case '/start':
        return this.#help(chatId);
      case '/status':
        return this.#status(chatId);
      case '/devices':
        return this.#devices(chatId);
      case '/pair':
        return this.#pair(chatId);
      case '/run':
        return this.#run(chatId, argument);
      case '/task':
        return this.#task(chatId, argument);
      case '/cancel':
        return this.#cancel(chatId, argument);
      case '/stop':
        return this.#stop(chatId);
      case '/revoke':
        return this.#revoke(chatId, argument);
      default:
        return this.sendMessage(chatId, `Unknown command ${command}. Use /help.`);
    }
  }

  #isAuthorized(userId, chatId) {
    if (userId === undefined || userId === null) return false;
    if (!this.allowedUserIds.has(String(userId))) return false;
    if (this.allowedChatIds.size > 0 && !this.allowedChatIds.has(String(chatId))) return false;
    return true;
  }

  async #help(chatId) {
    await this.sendMessage(
      chatId,
      [
        'NEXUS Phone Agent',
        '',
        '/help - this message',
        '/status - server, AI and device status',
        '/devices - list paired devices',
        '/pair - create a pairing code (valid once)',
        '/run <task> - send a task to your default device',
        '/task <id> - show the progress of a task',
        '/cancel <id> - cancel a task',
        '/stop - cancel every unfinished task',
        '/revoke <device-id> - revoke a device credential',
        '',
        'Only pre-approved Telegram user ids can use these commands.',
      ].join('\n'),
    );
  }

  async #status(chatId) {
    const devices = await this.registry.list('owner');
    const online = devices.filter((device) => this.executor?.gateway?.isOnline(device.id));
    await this.sendMessage(
      chatId,
      [
        'NEXUS status',
        `Devices: ${devices.length} (${online.length} online)`,
        ...devices.map((device) => {
          const isOnline = this.executor?.gateway?.isOnline(device.id);
          return `- ${device.label ?? device.id} [${device.id}] ${isOnline ? 'online' : 'offline'}${
            device.revokedAt ? ' (revoked)' : ''
          }`;
        }),
      ].join('\n'),
    );
  }

  async #devices(chatId) {
    const devices = await this.registry.list('owner');
    if (!devices.length) {
      await this.sendMessage(chatId, 'No devices are paired yet. Use /pair and enter the code in the NEXUS app.');
      return;
    }
    await this.sendMessage(
      chatId,
      devices
        .map((device) => {
          const isOnline = this.executor?.gateway?.isOnline(device.id);
          const lines = [`${device.label ?? 'Device'} — ${device.id}`, `  state: ${isOnline ? 'online' : 'offline'}`];
          lines.push(`  last seen: ${device.lastSeenAt ?? 'never'}`);
          if (device.revokedAt) lines.push(`  revoked: ${device.revokedAt}`);
          return lines.join('\n');
        })
        .join('\n\n'),
    );
  }

  async #pair(chatId) {
    if (!this.pairing) {
      await this.sendMessage(
        chatId,
        'Pairing is unavailable: the bot is not wired to the pairing service.',
      );
      return;
    }
    const code = await this.pairing.createCode({ ownerId: 'owner' });
    await this.sendMessage(
      chatId,
      [`Pairing code: ${code.code}`, `Expires at: ${code.expires_at}`, '', 'Enter it in the NEXUS app. It works once.'].join(
        '\n',
      ),
    );
  }

  async #pickDevice() {
    const devices = await this.registry.list('owner');
    const usable = devices.filter((device) => !device.revokedAt);
    if (usable.length === 1) return usable[0];
    if (usable.length === 0) return null;
    return usable.find((device) => this.executor?.gateway?.isOnline(device.id)) ?? usable[0];
  }

  async #run(chatId, instruction) {
    if (!instruction) {
      await this.sendMessage(chatId, 'Usage: /run <task>. Example: /run Open YouTube');
      return;
    }
    const device = await this.#pickDevice();
    if (!device) {
      await this.sendMessage(chatId, 'No device is paired. Use /pair first and complete pairing in the NEXUS app.');
      return;
    }
    try {
      const task = await this.tasks.create({
        ownerId: 'owner',
        deviceId: device.id,
        instruction,
        source: 'telegram',
      });
      await this.sendMessage(chatId, `Task accepted: ${task.id}\nDevice: ${device.label ?? device.id}\nInstruction: ${instruction}`);
      void this.executor.run(task);
    } catch (error) {
      const appError = error instanceof AppError ? error : null;
      await this.sendMessage(chatId, `Task rejected: ${appError?.message ?? 'unknown error'}`);
    }
  }

  async #task(chatId, argument) {
    const taskId = argument.trim();
    if (!taskId) {
      await this.sendMessage(chatId, 'Usage: /task <task-id>');
      return;
    }
    try {
      const task = await this.tasks.get('owner', taskId);
      const actions = await this.tasks.store.listActions(task.id);
      const serialized = this.tasks.serialize(task, actions);
      await this.sendMessage(
        chatId,
        [
          `Task ${serialized.task_id}`,
          `status: ${serialized.status}`,
          `instruction: ${serialized.instruction}`,
          `actions: ${serialized.completed_actions}/${serialized.action_count}`,
          serialized.error_code ? `error: ${serialized.error_code}` : null,
          serialized.result?.summary ? `result: ${serialized.result.summary}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    } catch (error) {
      await this.sendMessage(chatId, `Task not found or not visible: ${error.message}`);
    }
  }

  async #cancel(chatId, argument) {
    const taskId = argument.trim();
    if (!taskId) {
      await this.sendMessage(chatId, 'Usage: /cancel <task-id>');
      return;
    }
    try {
      const task = await this.tasks.cancel('owner', taskId);
      await this.sendMessage(chatId, `Task ${task.id} is now ${task.status}.`);
    } catch (error) {
      await this.sendMessage(chatId, `Could not cancel: ${error.message}`);
    }
  }

  async #stop(chatId) {
    const unfinished = await this.tasks.store.listUnfinishedTasks();
    let cancelled = 0;
    for (const task of unfinished) {
      await this.tasks.cancel('owner', task.id).catch(() => {});
      cancelled += 1;
    }
    await this.sendMessage(chatId, `Stopped ${cancelled} unfinished task(s).`);
  }

  async #revoke(chatId, argument) {
    const deviceId = argument.trim();
    if (!deviceId) {
      await this.sendMessage(chatId, 'Usage: /revoke <device-id>');
      return;
    }
    try {
      const device = await this.registry.revoke('owner', deviceId);
      await this.sendMessage(chatId, `Device ${device.id} was revoked. Pair it again to use it.`);
    } catch (error) {
      await this.sendMessage(chatId, `Could not revoke: ${error.message}`);
    }
  }

  /** Server events -> chat notifications. */
  handleNexusEvent(event, payload) {
    if (!this.ownerChatId) return;
    if (event === 'task.completed') {
      void this.sendMessage(this.ownerChatId, `Task ${payload.taskId} completed: ${payload.summary ?? ''}`.trim());
    } else if (event === 'task.failed') {
      void this.sendMessage(
        this.ownerChatId,
        `Task ${payload.taskId} failed (${payload.errorCode}): ${payload.message ?? ''}`.trim(),
      );
    } else if (event === 'task.awaiting_approval') {
      void this.sendMessage(
        this.ownerChatId,
        [`Task ${payload.task.id} needs your approval:`, ...payload.reasons.map((reason) => `- ${reason}`), '', `Approve with: /task ${payload.task.id} then the approve endpoint, or cancel with /cancel ${payload.task.id}.`].join(
          '\n',
        ),
      );
    }
  }
}

function chunkText(text, size) {
  if (text.length <= size) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut <= 0) cut = size;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
