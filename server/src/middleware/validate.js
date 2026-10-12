import { AppError } from '../utils/errors.js';

/** Validate a request part with a Zod schema and replace it with the parsed value. */
export function validate(schema, part = 'body') {
  return function validateMiddleware(req, res, next) {
    const parsed = schema.safeParse(req[part]);
    if (!parsed.success) {
      return next(
        new AppError('INVALID_REQUEST', {
          message: 'The request failed validation.',
          details: {
            issues: parsed.error.issues.slice(0, 10).map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          },
        }),
      );
    }
    req[part] = parsed.data;
    return next();
  };
}
