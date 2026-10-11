import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { requireOwnerAuth } from '../auth/ownerAuth.js';

const deviceIdParam = z.object({ deviceId: z.string().min(1).max(64) }).strict();

/** Owner-only device management. */
export function createDevicesRouter({ config, registry, gateway, logger }) {
  const router = Router();
  router.use(requireOwnerAuth(config, { logger }));

  router.get('/', async (req, res, next) => {
    try {
      const devices = await registry.list(req.ownerId);
      res.json({
        devices: devices.map((device) => registry.toPublicRecord(device, { online: gateway.isOnline(device.id) })),
        count: devices.length,
      });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:deviceId/revoke', validate(deviceIdParam, 'params'), async (req, res, next) => {
    try {
      const device = await registry.revoke(req.ownerId, req.params.deviceId);
      gateway.sendDeviceRevoked({ deviceId: device.id, reason: 'revoked_by_owner' });
      res.json({
        device_id: device.id,
        revoked_at: device.revokedAt,
        status: 'revoked',
        hint: 'The device credential no longer works. Re-pair the phone to use it again.',
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}
