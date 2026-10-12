import crypto from 'node:crypto';

/** Adds a request id and logs one line per request (without secrets). */
export function requestContext({ logger }) {
  return function requestContextMiddleware(req, res, next) {
    req.requestId = req.headers['x-request-id']?.toString() || crypto.randomBytes(8).toString('hex');
    req.log = logger.child({ requestId: req.requestId });
    res.setHeader('x-request-id', req.requestId);
    const started = Date.now();
    res.on('finish', () => {
      req.log.info('http.request', {
        method: req.method,
        path: req.originalUrl,
        status: res.statusCode,
        durationMs: Date.now() - started,
      });
    });
    next();
  };
}
