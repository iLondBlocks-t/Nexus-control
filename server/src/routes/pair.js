import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { requireOwnerAuth } from '../auth/ownerAuth.js';
import { AppError, normalizeError } from '../utils/errors.js';
import { RateLimiter } from '../utils/rateLimit.js';

const clientInfo = z
  .object({
    app_version: z.string().min(1).max(40),
    android_version: z.string().min(1).max(40),
    device_model: z.string().max(80).optional(),
    accessibility_enabled: z.boolean().optional(),
    launcher_packages: z.array(z.string().min(3).max(255)).max(200).optional(),
  })
  .strict();

const pairBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), label: z.string().max(80).optional() }).strict(),
  z.object({ action: z.literal('complete'), code: z.string().min(4).max(32), client: clientInfo }).strict(),
]);

/**
 * Pairing endpoints.
 *
 * POST /api/v1/pair  { action: "create" }    -> owner only, returns a short lived code
 * POST /api/v1/pair  { action: "complete" }  -> the phone redeems the code once
 */
export function createPairRouter({ config, pairing, registry, logger }) {
  const router = Router();
  const createLimiter = new RateLimiter({ limit: config.pairing.createRatePerMinute, windowMs: 60_000 });
  const completeLimiter = new RateLimiter({ limit: config.pairing.completeRatePerMinute, windowMs: 60_000 });

  router.post(
    '/',
    (req, res, next) => {
      // Rate limiting happens before authentication: the "complete" leg is
      // reached by an unpaired phone, so it must be throttled by IP.
      const action = req.body?.action;
      const limiter = action === 'create' ? createLimiter : completeLimiter;
      return rateLimit(limiter, { logger })(req, res, next);
    },
    validate(pairBody),
    async (req, res, next) => {
      const sourceKey = `ip:${req.ip ?? 'unknown'}`;
      const isCompletion = req.body?.action === 'complete';
      try {
        if (isCompletion && pairing.isLockedOut(sourceKey)) {
          throw new AppError('PAIRING_LOCKED', {
            message: 'Too many failed pairing attempts from this source. Wait a few minutes and request a new code.',
          });
        }

        if (req.body.action === 'create') {
          if (!req.ownerId) {
            return next(
              new AppError('AUTHENTICATION_REQUIRED', {
                message: 'Creating a pairing code requires the owner API token.',
              }),
            );
          }
          const code = await pairing.createCode({ ownerId: req.ownerId, label: req.body.label });
          return res.status(201).json({
            pairing_id: code.pairing_id,
            code: code.code,
            expires_at: code.expires_at,
            expires_in_seconds: code.expires_in_seconds,
            ws_url: config.publicBaseUrl ? `${config.publicBaseUrl}${config.wsPath}` : config.wsPath,
            hint: 'Enter this code in the NEXUS app within the expiry window. It can be used once.',
          });
        }

        const result = await pairing.complete({ code: req.body.code, client: req.body.client });
        pairing.clearAttempts(sourceKey);
        return res.status(201).json({
          device_id: result.deviceId,
          device_token: result.deviceToken,
          device: registry.toPublicRecord(result.device),
          ws_url: config.publicBaseUrl ? `${config.publicBaseUrl}${config.wsPath}` : config.wsPath,
          protocol_version: 1,
          hint: 'Store this token now. It is shown once and cannot be recovered.',
        });
      } catch (error) {
        if (isCompletion) {
          pairing.registerAttemptFailure(sourceKey);
          await pairing.registerFailure(req.body?.code).catch(() => {});
        }
        return next(normalizeError(error));
      }
    },
  );

  return router;
}

/**
 * The "create" leg needs the owner token, the "complete" leg must not.
 * This middleware authenticates when a token is present but only requires it
 * for the privileged action.
 */
export function optionalOwnerAuth(config, { logger } = {}) {
  const strict = requireOwnerAuth(config, { logger });
  return function optionalOwnerAuthMiddleware(req, res, next) {
    if (!req.headers.authorization) return next();
    return strict(req, res, (error) => {
      if (error) return next();
      return next();
    });
  };
}
