import { AppError, normalizeError } from '../utils/errors.js';

/**
 * Terminal error handler.
 *
 * Converts every error into the documented `{ error: { code, message } }` shape.
 * Stack traces and internal details never reach the client.
 */
export function errorHandler({ logger, includeStack = false } = {}) {
  return function errorHandlerMiddleware(error, req, res, _next) {
    const appError = normalizeError(error);
    const status = appError.httpStatus ?? 500;

    logger?.error('http.error', {
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl,
      status,
      errorCode: appError.code,
      error: appError.message,
      ...(includeStack && error?.stack ? { stack: error.stack } : {}),
    });

    if (res.headersSent) {
      res.end();
      return;
    }

    res.status(status).json({
      error: {
        code: appError.code,
        message: appError.message,
        ...(appError.details ? { details: appError.details } : {}),
        request_id: req.requestId,
      },
    });
  };
}

/** 404 for unknown routes, in the same error shape as everything else. */
export function notFound({ logger } = {}) {
  return function notFoundMiddleware(req, res, next) {
    logger?.debug('http.not_found', { requestId: req.requestId, path: req.originalUrl });
    next(new AppError('NOT_FOUND', { message: `No route matches ${req.method} ${req.originalUrl}.` }));
  };
}
