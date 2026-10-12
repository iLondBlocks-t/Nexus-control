import { AppError } from '../utils/errors.js';

/**
 * Sliding-window rate limit middleware backed by `utils/rateLimit.js`.
 * Responds with 429 and a `Retry-After` header.
 */
export function rateLimit(limiter, { keyFor = (req) => req.ip, logger } = {}) {
  return function rateLimitMiddleware(req, res, next) {
    const key = keyFor(req);
    const verdict = limiter.consume(key);
    if (!verdict.allowed) {
      logger?.warn('http.rate_limited', { requestId: req.requestId, key, path: req.originalUrl });
      res.setHeader('retry-after', String(Math.ceil(verdict.retryAfterMs / 1000)));
      return next(new AppError('RATE_LIMITED', { details: { retryAfterMs: verdict.retryAfterMs } }));
    }
    res.setHeader('ratelimit-remaining', String(verdict.remaining));
    return next();
  };
}
