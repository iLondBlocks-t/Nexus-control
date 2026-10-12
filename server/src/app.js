import express from 'express';
import { requestContext } from './middleware/requestContext.js';
import { errorHandler, notFound } from './middleware/errorHandler.js';
import { optionalOwnerAuth, createPairRouter } from './routes/pair.js';
import { createDevicesRouter } from './routes/devices.js';
import { createTasksRouter } from './routes/tasks.js';
import { createHealthRouter } from './routes/health.js';
import { createConsoleRouter } from './routes/console.js';

const API_JSON_LIMIT = '128kb';

/** Compose the HTTP application. No side effects, so tests can build it safely. */
export function createApp(context) {
  const { config, store, storage, registry, pairing, tasks, executor, gateway, aiProvider, logger, startedAt, version, bot } =
    context;

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ? 1 : false);

  app.use((req, res, next) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('x-frame-options', 'DENY');
    next();
  });

  app.use(requestContext({ logger }));
  app.use(express.json({ limit: API_JSON_LIMIT }));
  app.use(express.urlencoded({ extended: false, limit: '16kb' }));

  app.use(createHealthRouter({ config, store, aiProvider, gateway, storage, startedAt, version }));

  // Owner control panel: static files, no credentials of their own.
  app.use('/console', createConsoleRouter());

  // Pairing: "create" requires the owner token, "complete" does not.
  app.use('/api/v1/pair', optionalOwnerAuth(config, { logger }));
  app.use('/api/v1/pair', createPairRouter({ config, pairing, registry, logger }));

  app.use('/api/v1/devices', createDevicesRouter({ config, registry, gateway, logger }));
  app.use('/api/v1/tasks', createTasksRouter({ config, tasks, executor, logger }));

  app.get('/api/v1/status', async (req, res, next) => {
    try {
      const devices = await registry.list('owner');
      res.setHeader('cache-control', 'no-store');
      res.json({
        service: 'nexus-phone-agent',
        version,
        env: config.env,
        owner_authenticated: Boolean(req.ownerId),
        limits: config.tasks,
        storage: { driver: storage.driver, persistent: storage.persistent },
        websocket: gateway?.stats() ?? null,
        devices: devices.map((device) => registry.toPublicRecord(device, { online: gateway?.isOnline(device.id) })),
      });
    } catch (error) {
      next(error);
    }
  });

  // Convenience redirect from the root to the health endpoint.
  app.get('/', (_req, res) => res.redirect(302, '/healthz'));

  app.use(notFound({ logger }));
  app.use(errorHandler({ logger, includeStack: config.env === 'development' }));

  // Bot status is surfaced through /api/v1/status only; keep the reference so the
  // object is not garbage collected before shutdown.
  app.locals.bot = bot ?? null;

  return app;
}
