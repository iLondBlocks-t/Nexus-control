import { AppError } from '../utils/errors.js';
import { matchesAny } from '../utils/ids.js';

/**
 * Owner authentication for the HTTP API.
 *
 * NEXUS is designed as a single-owner system: one person owns every device.
 * `OWNER_API_TOKENS` holds one or more bearer tokens for that owner. The bot
 * does not use this mechanism; it calls the task service directly in-process.
 */

export const DEFAULT_OWNER_ID = 'owner';

export function extractBearerToken(headerValue) {
  const raw = String(headerValue ?? '').trim();
  if (!raw) return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw);
  if (!match) return null;
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

export function verifyOwnerToken(token, config) {
  if (!token) return false;
  return matchesAny(token, config.ownerApiTokens);
}

/** Express middleware: rejects anything that is not the configured owner. */
export function requireOwnerAuth(config, { logger } = {}) {
  return function ownerAuthMiddleware(req, res, next) {
    const token = extractBearerToken(req.headers.authorization);
    if (!verifyOwnerToken(token, config)) {
      logger?.warn('auth.owner_rejected', {
        requestId: req.requestId,
        ip: req.ip,
        path: req.originalUrl,
        reason: token ? 'invalid_token' : 'missing_token',
      });
      return next(
        new AppError('AUTHENTICATION_REQUIRED', {
          message: 'A valid owner API token is required. Send it as "Authorization: Bearer <token>".',
        }),
      );
    }
    req.ownerId = DEFAULT_OWNER_ID;
    return next();
  };
}
