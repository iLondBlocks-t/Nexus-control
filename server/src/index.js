import http from 'node:http';
import { loadConfig } from './config/index.js';
import { configureLogger, getLogger, protectSecret } from './logging/logger.js';
import { clearSecrets } from './logging/redact.js';
import { createStorage } from './storage/index.js';
import { DeviceRegistry } from './devices/deviceRegistry.js';
import { PairingService } from './pairing/pairingService.js';
import { TaskService } from './tasks/taskService.js';
import { TaskExecutor } from './tasks/executor.js';
import { buildProvider } from './ai/provider.js';
import { Planner } from './planner/planner.js';
import { DeviceGateway } from './websocket/gateway.js';
import { createApp } from './app.js';
import { createBot } from './bot/index.js';
import { normalizeError } from './utils/errors.js';

export const VERSION = '0.1.0';

const MAINTENANCE_INTERVAL_MS = 15_000;
const HOUSEKEEPING_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Build the whole server without listening.
 * Exported so the tests can boot a real instance on an ephemeral port.
 */
export async function createServer({ env = process.env, overrides = {} } = {}) {
  const { config, issues } = loadConfig(env);
  configureLogger({ level: config.log.level, format: config.log.format });
  const logger = getLogger({ component: 'server' });

  for (const token of config.ownerApiTokens) protectSecret(token);
  if (config.ai.apiKey) protectSecret(config.ai.apiKey);
  if (config.telegram.botToken) protectSecret(config.telegram.botToken);

  for (const issue of issues.filter((entry) => entry.level === 'warning')) {
    logger.warn('config.warning', { key: issue.key, message: issue.message });
  }

  // Tests may inject a store so state can be shared between server instances.
  const storage = overrides.storage ?? (await createStorage(config));
  const store = storage.store;
  logger.info('storage.ready', { driver: storage.driver, persistent: storage.persistent });

  const registry = new DeviceRegistry({ store, logger });
  const pairing = new PairingService({ store, registry, config, logger });
  const provider = overrides.provider ?? buildProvider(config);
  const planner = overrides.planner ?? new Planner({ provider, config, logger });

  const events = overrides.events ?? [];
  const listeners = [...events];
  const publish = (event, payload) => {
    for (const listener of listeners) {
      try {
        listener(event, payload);
      } catch (error) {
        logger.error('event.listener_failed', { event, error: error.message });
      }
    }
  };

  const tasks = new TaskService({ store, config, registry, logger, publish });

  const gateway = overrides.gateway ?? new DeviceGateway({
    server: null,
    config,
    store,
    registry,
    logger,
    onDeviceEvent: (event, payload) => {
      if (event === 'device_offline') {
        void tasks.executor?.handleDeviceOffline?.(payload.deviceId);
        publish('device.offline', payload);
      }
      publish(`device.${event}`, payload);
    },
  });

  const executor = overrides.executor ?? new TaskExecutor({
    store,
    config,
    registry,
    gateway,
    planner,
    tasks,
    logger,
    publish,
  });
  tasks.attachExecutor(executor);
  // The phone submits tasks over its authenticated socket; the pipeline is
  // injected here because the executor and the gateway depend on each other.
  gateway.attachTaskPipeline?.({ tasks, executor });

  const bot = createBot({ config, tasks, registry, executor, store, pairing, logger, publish });
  if (bot?.handleNexusEvent) {
    listeners.push((event, payload) => {
      try {
        bot.handleNexusEvent(event, payload);
      } catch (error) {
        logger.error('bot.event_failed', { event, error: error.message });
      }
    });
  }

  const startedAt = Date.now();
  const expressApp = createApp({
    config,
    store,
    storage,
    registry,
    pairing,
    tasks,
    executor,
    gateway,
    aiProvider: provider,
    planner,
    logger,
    startedAt,
    version: VERSION,
    bot,
  });

  const server = http.createServer(expressApp);
  // The gateway needs the HTTP server to intercept upgrades.
  gateway.server = server;
  gateway.start();

  // Tasks that were unfinished when the process stopped are never replayed:
  // the state of the last UI action is unknown.
  const interrupted = await reconcileInterruptedTasks(tasks, logger);

  let maintenanceTimer = null;
  let housekeepingTimer = null;

  const context = {
    config,
    logger,
    store,
    storage,
    registry,
    pairing,
    tasks,
    executor,
    gateway,
    planner,
    provider,
    bot,
    app: expressApp,
    server,
    interruptedTasks: interrupted,
    publish,
    onEvent(listener) {
      listeners.push(listener);
    },
    async listen(port = config.port, host = config.host) {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, resolve);
      });
      maintenanceTimer = setInterval(() => {
        void tasks.expireStale().catch((error) => logger.error('maintenance.expire_failed', { error: error.message }));
        void pairing.pruneExpired().catch(() => {});
      }, MAINTENANCE_INTERVAL_MS);
      maintenanceTimer.unref?.();

      housekeepingTimer = setInterval(() => {
        void tasks.pruneHistory().catch((error) => logger.error('maintenance.prune_failed', { error: error.message }));
      }, HOUSEKEEPING_INTERVAL_MS);
      housekeepingTimer.unref?.();

      logger.info('server.listening', {
        port,
        host,
        env: config.env,
        wsPath: config.wsPath,
        storageDriver: storage.driver,
        aiProvider: provider.name,
        aiConfigured: provider.configured,
        bot: bot?.name ?? 'disabled',
      });
      return server;
    },
    async close() {
      if (maintenanceTimer) clearInterval(maintenanceTimer);
      if (housekeepingTimer) clearInterval(housekeepingTimer);
      await bot?.stop?.().catch(() => {});
      executor.shutdown();
      await gateway.closeAll();
      await new Promise((resolve) => server.close(resolve));
      await store.close?.();
      clearSecrets();
      logger.info('server.stopped', {});
    },
  };

  return context;
}

async function reconcileInterruptedTasks(tasks, logger) {
  const unfinished = await tasks.store.listUnfinishedTasks();
  let count = 0;
  for (const task of unfinished) {
    count += 1;
    await tasks
      .updateStatus(task.id, 'failed', {
        errorCode: 'INTERNAL_ERROR',
        result: {
          summary:
            'The server restarted while this task was unfinished. It was not replayed because the state of the last action is unknown.',
        },
      })
      .catch(() => {});
  }
  if (count) logger.warn('tasks.reconciled', { count });
  return count;
}

function installProcessHandlers(logger) {
  process.on('unhandledRejection', (reason) => {
    logger.error('process.unhandled_rejection', { error: normalizeError(reason).message });
  });
  process.on('uncaughtException', (error) => {
    logger.error('process.uncaught_exception', { error: error.message });
  });
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  try {
    const server = await createServer();
    installProcessHandlers(server.logger);
    await server.listen();
    const shutdown = async (signal) => {
      server.logger.info('server.shutdown_signal', { signal });
      try {
        await server.close();
        process.exit(0);
      } catch (error) {
        server.logger.error('server.shutdown_failed', { error: error.message });
        process.exit(1);
      }
    };
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('SIGINT', () => void shutdown('SIGINT'));
  } catch (error) {
    const message = error?.message ?? String(error);
    process.stderr.write(`nexus: startup failed\n${message}\n`);
    process.exit(1);
  }
}
