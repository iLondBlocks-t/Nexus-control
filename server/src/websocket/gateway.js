import { WebSocketServer } from 'ws';
import { AppError, normalizeError } from '../utils/errors.js';
import { authenticateDevice, hashDeviceToken } from '../auth/deviceAuth.js';
import { RateLimiter } from '../utils/rateLimit.js';
import { ConnectionManager } from './connectionManager.js';
import {
  PROTOCOL_VERSION,
  envelopeFor,
  isSupportedProtocolVersion,
  parseInboundMessage,
} from './protocol.js';
import { createId } from '../utils/ids.js';

/**
 * Authenticated WebSocket gateway for devices.
 *
 * Hardening implemented here:
 *  - path-scoped upgrades and a global connection cap
 *  - per-IP upgrade rate limiting
 *  - handshake-by-first-message authentication (no long lived secret in a URL)
 *  - schema validation of every inbound frame
 *  - message size, rate and duplicate-message limits
 *  - ping/pong heartbeats with a dead-socket timeout
 *  - correlation by task_id/action_id so results cannot be replayed
 */

const DEDUPE_CACHE_SIZE = 200;

export class DeviceGateway {
  constructor({ server, config, store, registry, logger, onDeviceEvent = () => {} }) {
    this.config = config;
    this.store = store;
    this.registry = registry;
    this.logger = logger;
    this.onDeviceEvent = onDeviceEvent;

    this.presence = new ConnectionManager({ registry, logger });
    this.pendingActions = new Map();
    this.seenActionResults = new Map();
    this.upgradeLimiter = new RateLimiter({ limit: 30, windowMs: 60_000 });
    this.taskCreateLimiters = new Map();
    // Injected after the executor exists, which needs the gateway: see index.js.
    this.taskPipeline = null;

    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: config.limits.maxMessageBytes,
      perMessageDeflate: false, // compression is not worth the memory on a phone link
    });
    this.server = server;
    this.heartbeatTimer = null;
  }

  /**
   * Wire the task pipeline in once both sides exist.
   *
   * The executor needs the gateway to dispatch actions and the gateway needs
   * the executor to run the tasks a phone asks for, so the cycle is broken by
   * injecting it after construction.
   */
  attachTaskPipeline({ tasks, executor }) {
    this.taskPipeline = { tasks, executor };
  }

  start() {
    this.server.on('upgrade', (request, socket, head) => {
      this.handleUpgrade(request, socket, head);
    });
    this.wss.on('connection', (socket, request) => this.handleConnection(socket, request));
    this.heartbeatTimer = setInterval(() => this.#heartbeat(), this.config.limits.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
    this.logger.info('ws.gateway_started', { path: this.config.wsPath, maxPayload: this.config.limits.maxMessageBytes });
  }

  async closeAll() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const pending of this.pendingActions.values()) {
      clearTimeout(pending.timer);
      pending.reject(new AppError('DEVICE_OFFLINE'));
    }
    this.pendingActions.clear();
    this.presence.closeAll();
    await new Promise((resolve) => this.wss.close(resolve));
  }

  handleUpgrade(request, socket, head) {
    let pathname = '';
    try {
      pathname = new URL(request.url, 'http://localhost').pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname !== this.config.wsPath) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    if (this.presence.size >= this.config.limits.maxWsConnections) {
      this.logger.warn('ws.connection_limit', { size: this.presence.size });
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }

    const ip = request.socket.remoteAddress ?? 'unknown';
    const verdict = this.upgradeLimiter.consume(ip);
    if (!verdict.allowed) {
      this.logger.warn('ws.upgrade_rate_limited', { ip });
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
      socket.destroy();
      return;
    }

    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit('connection', ws, request);
    });
  }

  handleConnection(socket, request) {
    const context = {
      socket,
      ip: request.socket.remoteAddress ?? 'unknown',
      authenticated: false,
      deviceId: null,
      limiter: new RateLimiter({ limit: this.config.limits.wsMessageRatePerMinute, windowMs: 60_000 }),
      seenMessageIds: new Set(),
      messageIdOrder: [],
      lastPong: Date.now(),
      alive: true,
    };
    socket.nexus = context;
    context.alive = true;
    socket.on('pong', () => {
      context.lastPong = Date.now();
      context.alive = true;
    });

    const authTimer = setTimeout(() => {
      if (!context.authenticated) {
        this.logger.warn('ws.auth_timeout', { ip: context.ip });
        this.#send(socket, envelopeFor('device_auth_failed', {
          message_id: createId('message'),
          error_code: 'AUTHENTICATION_REQUIRED',
          message: 'Device authentication timed out.',
        }));
        socket.close(4002, 'auth_timeout');
      }
    }, this.config.limits.authTimeoutMs);

    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.#protocolError(socket, context, 'INVALID_REQUEST', 'Binary frames are not supported.');
        return;
      }
      this.handleMessage(socket, context, data.toString(), authTimer).catch((error) => {
        this.logger.error('ws.message_error', { error, deviceId: context.deviceId });
      });
    });

    socket.on('close', (code, reason) => {
      clearTimeout(authTimer);
      if (context.deviceId) {
        this.presence.remove(context.deviceId, socket);
        this.releaseDeviceLimiters(context.deviceId);
        this.registry.markSeen(context.deviceId, { connectionState: 'disconnected' }).catch(() => {});
        this.logger.info('ws.disconnected', { deviceId: context.deviceId, code, reason: reason?.toString() });
        this.onDeviceEvent('device_offline', { deviceId: context.deviceId });
      }
    });

    socket.on('error', (error) => {
      this.logger.warn('ws.socket_error', { error: error.message, deviceId: context.deviceId });
    });
  }

  async handleMessage(socket, context, raw, authTimer) {
    if (raw.length > this.config.limits.maxMessageBytes) {
      this.#protocolError(socket, context, 'INVALID_REQUEST', 'Message exceeds the maximum size.');
      socket.close(1009, 'message_too_large');
      return;
    }

    const rate = context.limiter.consume('messages');
    if (!rate.allowed) {
      this.#protocolError(socket, context, 'RATE_LIMITED', 'Too many messages. Slow down.');
      return;
    }

    const parsed = parseInboundMessage(raw);
    if (!parsed.ok) {
      this.#protocolError(socket, context, parsed.errorCode, parsed.message);
      if (!context.authenticated) socket.close(4000, 'invalid_hello');
      return;
    }

    const message = parsed.message;

    // Duplicate suppression (message_id is optional; only enforce when supplied).
    if (message.message_id) {
      if (context.seenMessageIds.has(message.message_id)) {
        this.logger.debug('ws.duplicate_message', { deviceId: context.deviceId, messageId: message.message_id });
        return;
      }
      context.seenMessageIds.add(message.message_id);
      context.messageIdOrder.push(message.message_id);
      if (context.messageIdOrder.length > DEDUPE_CACHE_SIZE) {
        const oldest = context.messageIdOrder.shift();
        context.seenMessageIds.delete(oldest);
      }
    }

    if (!context.authenticated) {
      if (message.type !== 'device_hello') {
        this.#protocolError(socket, context, 'AUTHENTICATION_REQUIRED', 'Authenticate with device_hello first.');
        socket.close(4000, 'not_authenticated');
        return;
      }
      await this.#authenticate(socket, context, message);
      clearTimeout(authTimer);
      return;
    }

    if (message.type === 'device_hello') {
      this.#protocolError(socket, context, 'INVALID_REQUEST', 'The device is already authenticated.');
      return;
    }

    switch (message.type) {
      case 'heartbeat':
        this.#send(socket, envelopeFor('heartbeat_ack', {
          message_id: createId('message'),
          server_time: new Date().toISOString(),
        }));
        break;

      case 'device_status': {
        this.presence.setAccessibility(context.deviceId, message.accessibility_enabled);
        await this.registry.markSeen(context.deviceId, {
          connectionState: 'connected',
          accessibilityEnabled: message.accessibility_enabled,
        });
        this.onDeviceEvent('device_status', {
          deviceId: context.deviceId,
          accessibilityEnabled: message.accessibility_enabled,
        });
        break;
      }

      case 'action_result':
        this.#resolveActionResult(context, message);
        break;

      case 'task_progress':
        this.onDeviceEvent('task_progress', {
          deviceId: context.deviceId,
          taskId: message.task_id,
          status: message.status,
          message: message.message ?? null,
        });
        break;

      case 'protocol_error':
        this.logger.warn('ws.device_protocol_error', {
          deviceId: context.deviceId,
          errorCode: message.error_code,
          message: message.message ?? null,
        });
        break;

      case 'task_create':
        await this.#handleTaskCreate(socket, context, message);
        break;

      case 'task_approve':
      case 'task_deny':
        await this.#handleTaskDecision(socket, context, message);
        break;

      default:
        this.#protocolError(socket, context, 'INVALID_REQUEST', 'Unknown message type.');
    }
  }

  /**
   * Create and start a task requested by the phone itself.
   *
   * The instruction is validated by the shared schema, rate limited per device,
   * then handed to the same TaskService and executor the HTTP API uses, so a
   * phone-initiated task is subject to every limit an API task is.
   */
  async #handleTaskCreate(socket, context, message) {
    const reject = (errorCode, text) => {
      this.#send(socket, envelopeFor('task_rejected', {
        message_id: createId('message'),
        request_id: message.request_id,
        error_code: errorCode,
        message: text,
      }));
    };

    if (!this.taskPipeline) {
      return reject('SERVICE_UNAVAILABLE', 'Task creation is not available on this server.');
    }

    const limiter = this.#taskCreateLimiter(context.deviceId);
    if (!limiter.consume('task_create').allowed) {
      this.logger.warn('ws.task_create_rate_limited', { deviceId: context.deviceId });
      return reject('RATE_LIMITED', 'Too many task requests. Wait a minute and try again.');
    }

    try {
      const device = await this.registry.get(context.deviceId);
      if (!device?.ownerId) {
        return reject('DEVICE_NOT_PAIRED', 'This device is not paired.');
      }
      const task = await this.taskPipeline.tasks.create({
        ownerId: device.ownerId,
        deviceId: context.deviceId,
        instruction: message.instruction,
        source: 'device',
      });

      this.#send(socket, envelopeFor('task_accepted', {
        message_id: createId('message'),
        request_id: message.request_id,
        task_id: task.id,
        status: task.status,
      }));

      // Fire and forget: the executor records its own outcome on the task.
      void this.taskPipeline.executor.run(task);
    } catch (error) {
      const normalized = normalizeError(error);
      this.logger.warn('ws.task_create_failed', {
        deviceId: context.deviceId,
        errorCode: normalized.code,
      });
      return reject(normalized.code, normalized.message);
    }
    return undefined;
  }

  /**
   * Approve or deny a task that is waiting for the owner.
   *
   * The phone is the owner's own device and is already authenticated, and the
   * task must belong to that same device, so a device can never decide on
   * somebody else's task.
   */
  async #handleTaskDecision(socket, context, message) {
    const approved = message.type === 'task_approve';
    const reply = (status, extra = {}) => {
      this.#send(socket, envelopeFor('approval_result', {
        message_id: createId('message'),
        task_id: message.task_id,
        approved,
        status,
        ...extra,
      }));
    };

    if (!this.taskPipeline) {
      return reply('failed', { error_code: 'SERVICE_UNAVAILABLE', message: 'Task control is not available.' });
    }

    try {
      // Read the task straight from storage: the caller is a device, not an
      // owner, so the owner-scoped lookup cannot be used here. Ownership is
      // enforced explicitly right after.
      const task = await this.store.getTask(message.task_id);
      if (!task) {
        return reply('failed', { error_code: 'NOT_FOUND', message: 'That task does not exist.' });
      }
      if (task.deviceId !== context.deviceId) {
        this.logger.warn('ws.task_decision_wrong_device', {
          deviceId: context.deviceId,
          taskId: message.task_id,
        });
        return reply('failed', {
          error_code: 'PERMISSION_DENIED',
          message: 'That task belongs to a different device.',
        });
      }

      const updated = approved
        ? await this.taskPipeline.tasks.approve(task.ownerId, message.task_id)
        : await this.taskPipeline.tasks.deny(task.ownerId, message.task_id);

      this.logger.info('ws.task_decision', {
        deviceId: context.deviceId,
        taskId: message.task_id,
        approved,
        status: updated.status,
      });
      return reply(updated.status ?? (approved ? 'running' : 'cancelled'));
    } catch (error) {
      const normalized = normalizeError(error);
      return reply('failed', { error_code: normalized.code, message: normalized.message });
    }
  }

  #taskCreateLimiter(deviceId) {
    let limiter = this.taskCreateLimiters.get(deviceId);
    if (!limiter) {
      limiter = new RateLimiter({ limit: this.config.tasks.createRatePerMinute, windowMs: 60_000 });
      this.taskCreateLimiters.set(deviceId, limiter);
    }
    return limiter;
  }

  /** Called when a device disconnects so its limiter does not leak. */
  releaseDeviceLimiters(deviceId) {
    this.taskCreateLimiters.delete(deviceId);
  }

  async #authenticate(socket, context, message) {
    try {
      const device = await authenticateDevice(this.store, {
        deviceId: message.device_id,
        deviceToken: message.device_token,
      });

      context.authenticated = true;
      context.deviceId = device.id;
      context.accessibilityEnabled = Boolean(message.client?.accessibility_enabled);
      this.presence.add(device.id, socket, { accessibilityEnabled: context.accessibilityEnabled });

      await this.registry.markSeen(device.id, {
        connectionState: 'connected',
        accessibilityEnabled: context.accessibilityEnabled,
        ...(message.client?.app_version ? { appVersion: message.client.app_version } : {}),
        ...(message.client?.device_model ? { model: message.client.device_model } : {}),
        ...(message.client?.android_version ? { androidVersion: message.client.android_version } : {}),
        ...(Array.isArray(message.client?.launcher_packages)
          ? { launcherPackages: message.client.launcher_packages.slice(0, 200) }
          : {}),
      });

      this.#send(socket, envelopeFor('device_auth_ok', {
        message_id: createId('message'),
        device_id: device.id,
        server_time: new Date().toISOString(),
        heartbeat_interval_ms: this.config.limits.heartbeatIntervalMs,
      }));
      this.logger.info('ws.authenticated', { deviceId: device.id });
      this.onDeviceEvent('device_online', { deviceId: device.id });
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'AUTHENTICATION_REQUIRED';
      const mapped = ['AUTHENTICATION_REQUIRED', 'DEVICE_REVOKED', 'INVALID_PROTOCOL_VERSION', 'INVALID_REQUEST', 'RATE_LIMITED'].includes(code)
        ? code
        : 'AUTHENTICATION_REQUIRED';
      this.logger.warn('ws.auth_failed', { errorCode: mapped, ip: context.ip, deviceId: message.device_id ?? null });
      this.#send(socket, envelopeFor('device_auth_failed', {
        message_id: createId('message'),
        error_code: mapped,
        message: error.message,
      }));
      socket.close(4003, 'auth_failed');
    }
  }

  #resolveActionResult(context, message) {
    const key = `${message.task_id}:${message.action_id}`;
    const seen = this.seenActionResults.get(message.task_id) ?? new Set();
    if (seen.has(message.action_id)) {
      this.logger.debug('ws.duplicate_action_result', { key });
      return;
    }
    seen.add(message.action_id);
    this.seenActionResults.set(message.task_id, seen);

    const pending = this.pendingActions.get(key);
    if (!pending) {
      this.logger.warn('ws.unmatched_action_result', { key, deviceId: context.deviceId });
      return;
    }
    clearTimeout(pending.timer);
    this.pendingActions.delete(key);
    pending.resolve({
      status: message.status,
      result: message.result ?? null,
      errorCode: message.error_code ?? null,
      message: message.message ?? null,
      durationMs: message.duration_ms ?? null,
    });
  }

  #protocolError(socket, context, errorCode, message, refMessageId) {
    this.logger.warn('ws.protocol_error', { errorCode, message, deviceId: context.deviceId ?? null });
    this.#send(socket, envelopeFor('protocol_error', {
      message_id: createId('message'),
      error_code: errorCode,
      message,
      ...(refMessageId ? { ref_message_id: refMessageId } : {}),
    }));
  }

  #send(socket, payload) {
    if (socket.readyState !== socket.OPEN) return false;
    try {
      socket.send(JSON.stringify(payload));
      return true;
    } catch (error) {
      this.logger.error('ws.send_failed', { error: error.message });
      return false;
    }
  }

  #heartbeat() {
    for (const entry of this.presence.connections.values()) {
      const socket = entry.socket;
      const context = socket.nexus;
      if (!context) continue;
      const stale = Date.now() - context.lastPong > this.config.limits.heartbeatTimeoutMs;
      if (stale) {
        this.logger.warn('ws.heartbeat_timeout', { deviceId: context.deviceId });
        try {
          socket.terminate();
        } catch {
          /* ignore */
        }
        continue;
      }
      if (socket.readyState === socket.OPEN) {
        context.alive = false;
        socket.ping();
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Server -> device API used by the task executor                       */
  /* ------------------------------------------------------------------ */

  isOnline(deviceId) {
    return this.presence.isOnline(deviceId);
  }

  isAccessibilityEnabled(deviceId) {
    return this.presence.isAccessibilityEnabled(deviceId);
  }

  /**
   * Dispatch one action and wait for its correlated result.
   * @returns {Promise<{status: string, result: object|null, errorCode: string|null, message: string|null}>}
   */
  async executeAction({ deviceId, taskId, actionId, sequence, action, timeoutMs }) {
    const entry = this.presence.get(deviceId);
    if (!entry) throw new AppError('DEVICE_OFFLINE');

    const payload = envelopeFor('execute_action', {
      message_id: createId('message'),
      task_id: taskId,
      action_id: actionId,
      sequence,
      expires_at: new Date(Date.now() + timeoutMs).toISOString(),
      action,
    });

    return new Promise((resolve, reject) => {
      const key = `${taskId}:${actionId}`;
      const timer = setTimeout(() => {
        this.pendingActions.delete(key);
        reject(new AppError('ACTION_TIMEOUT'));
      }, timeoutMs);
      this.pendingActions.set(key, { resolve, reject, timer, startedAt: Date.now() });
      const sent = this.#send(entry.socket, payload);
      if (!sent) {
        clearTimeout(timer);
        this.pendingActions.delete(key);
        reject(new AppError('DEVICE_OFFLINE'));
      }
    });
  }

  sendTaskDispatch({ deviceId, taskId, instruction, actionCount, expiresAt }) {
    const entry = this.presence.get(deviceId);
    if (!entry) return false;
    return this.#send(entry.socket, envelopeFor('task_dispatch', {
      message_id: createId('message'),
      task_id: taskId,
      instruction,
      action_count: actionCount,
      expires_at: expiresAt,
    }));
  }

  sendCancel({ deviceId, taskId, reason = 'user_cancelled' }) {
    const entry = this.presence.get(deviceId);
    if (!entry) return false;
    return this.#send(entry.socket, envelopeFor('cancel_task', {
      message_id: createId('message'),
      task_id: taskId,
      reason,
    }));
  }

  sendApprovalRequired({ deviceId, taskId, reasons }) {
    const entry = this.presence.get(deviceId);
    if (!entry) return false;
    return this.#send(entry.socket, envelopeFor('approval_required', {
      message_id: createId('message'),
      task_id: taskId,
      reasons,
    }));
  }

  sendTaskCompleted({ deviceId, taskId, status, summary, errorCode }) {
    const entry = this.presence.get(deviceId);
    if (!entry) return false;
    return this.#send(entry.socket, envelopeFor('task_completed', {
      message_id: createId('message'),
      task_id: taskId,
      status,
      summary,
      errorCode,
    }));
  }

  sendDeviceRevoked({ deviceId, reason = 'revoked_by_owner' }) {
    const entry = this.presence.get(deviceId);
    if (!entry) return false;
    return this.#send(entry.socket, envelopeFor('device_revoked', { message_id: createId('message'), reason }));
  }

  /** Drop every pending action for a task (used on cancellation). */
  failPendingForTask(taskId, errorCode = 'TASK_CANCELLED') {
    for (const [key, pending] of [...this.pendingActions.entries()]) {
      if (key.startsWith(`${taskId}:`)) {
        clearTimeout(pending.timer);
        this.pendingActions.delete(key);
        pending.reject(new AppError(errorCode));
      }
    }
  }

  stats() {
    return {
      connections: this.presence.size,
      onlineDevices: this.presence.onlineDeviceIds(),
      pendingActions: this.pendingActions.size,
      protocolVersion: PROTOCOL_VERSION,
      path: this.config.wsPath,
      maxPayload: this.config.limits.maxMessageBytes,
    };
  }
}

export { isSupportedProtocolVersion, hashDeviceToken };
