import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireOwnerAuth } from '../auth/ownerAuth.js';
import { RateLimiter } from '../utils/rateLimit.js';
import { rateLimit } from '../middleware/rateLimit.js';

const createTaskBody = z
  .object({
    device_id: z.string().min(1).max(64),
    instruction: z.string().min(1).max(1000),
  })
  .strict();

const taskIdParam = z.object({ taskId: z.string().min(1).max(64) }).strict();

/** Task creation, inspection and cancellation. */
export function createTasksRouter({ config, tasks, executor, logger }) {
  const router = Router();
  router.use(requireOwnerAuth(config, { logger }));

  const createLimiter = new RateLimiter({ limit: config.tasks.createRatePerMinute, windowMs: 60_000 });

  router.post('/', rateLimit(createLimiter, { logger }), validate(createTaskBody), async (req, res, next) => {
    try {
      const task = await tasks.create({
        ownerId: req.ownerId,
        deviceId: req.body.device_id,
        instruction: req.body.instruction,
        source: req.headers['x-nexus-source']?.toString() ?? 'api',
      });
      // Fire and forget: the executor records its own outcome on the task.
      void executor.run(task);
      const stored = await tasks.get(req.ownerId, task.id);
      res.status(202).json(tasks.serialize(stored, []));
    } catch (error) {
      next(error);
    }
  });

  router.get('/', async (req, res, next) => {
    try {
      const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100);
      const deviceId = typeof req.query.device_id === 'string' ? req.query.device_id : undefined;
      const list = await tasks.list(req.ownerId, { deviceId, limit });
      res.json({ tasks: list.map((task) => tasks.serialize(task, [])), count: list.length });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:taskId', validate(taskIdParam, 'params'), async (req, res, next) => {
    try {
      const task = await tasks.get(req.ownerId, req.params.taskId);
      const actions = await tasks.store.listActions(task.id);
      res.json(tasks.serialize(task, actions));
    } catch (error) {
      next(error);
    }
  });

  router.post('/:taskId/cancel', validate(taskIdParam, 'params'), async (req, res, next) => {
    try {
      const task = await tasks.cancel(req.ownerId, req.params.taskId);
      res.json(tasks.serialize(task, await tasks.store.listActions(task.id)));
    } catch (error) {
      next(error);
    }
  });

  router.post('/:taskId/approve', validate(taskIdParam, 'params'), async (req, res, next) => {
    try {
      const task = await tasks.approve(req.ownerId, req.params.taskId);
      res.json(tasks.serialize(task, await tasks.store.listActions(task.id)));
    } catch (error) {
      next(error);
    }
  });

  router.post('/:taskId/deny', validate(taskIdParam, 'params'), async (req, res, next) => {
    try {
      const task = await tasks.deny(req.ownerId, req.params.taskId);
      res.json(tasks.serialize(task, await tasks.store.listActions(task.id)));
    } catch (error) {
      next(error);
    }
  });

  return router;
}
