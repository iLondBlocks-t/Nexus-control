/**
 * Machine readable error codes shared by every layer of the server.
 *
 * The codes below are part of the public API: the Android client and the bot
 * display the `message` field, while automation depends on `code`.
 */

export const ERROR_CODES = Object.freeze({
  INVALID_REQUEST: { http: 400, message: 'The request was malformed or failed validation.' },
  INVALID_PROTOCOL_VERSION: { http: 400, message: 'Unsupported protocol version.' },
  AUTHENTICATION_REQUIRED: { http: 401, message: 'Authentication is required.' },
  PERMISSION_DENIED: { http: 403, message: 'You are not allowed to perform this operation.' },
  NOT_FOUND: { http: 404, message: 'The requested resource does not exist.' },
  RATE_LIMITED: { http: 429, message: 'Too many requests. Please slow down.' },
  INTERNAL_ERROR: { http: 500, message: 'An unexpected internal error occurred.' },
  SERVICE_UNAVAILABLE: { http: 503, message: 'The service is not ready to handle this request.' },

  DEVICE_NOT_PAIRED: { http: 404, message: 'The device is not paired with this account.' },
  DEVICE_REVOKED: { http: 403, message: 'The device credential has been revoked.' },
  DEVICE_OFFLINE: { http: 409, message: 'The device is not currently connected.' },
  DEVICE_BUSY: { http: 409, message: 'The device already has an active task.' },
  ACCESSIBILITY_NOT_ENABLED: { http: 409, message: 'The NEXUS accessibility service is not enabled on the device.' },

  PAIRING_INVALID: { http: 400, message: 'The pairing code is not valid.' },
  PAIRING_EXPIRED: { http: 410, message: 'The pairing code has expired. Request a new one.' },
  PAIRING_USED: { http: 410, message: 'The pairing code has already been used.' },
  PAIRING_LOCKED: { http: 429, message: 'Too many failed pairing attempts. Request a new code.' },

  AI_PROVIDER_NOT_CONFIGURED: {
    http: 503,
    message: 'AI provider is not configured. Add a valid API key and supported model in the hosting environment.',
  },
  AI_PROVIDER_INVALID_CREDENTIALS: { http: 502, message: 'The AI provider rejected the configured credentials.' },
  AI_PROVIDER_RATE_LIMITED: { http: 429, message: 'The AI provider is rate limiting requests.' },
  AI_PROVIDER_TIMEOUT: { http: 504, message: 'The AI provider did not respond in time.' },
  AI_PROVIDER_ERROR: { http: 502, message: 'The AI provider returned an error.' },
  INVALID_AI_PLAN: { http: 502, message: 'The AI returned a plan that failed validation.' },

  ACTION_NOT_ALLOWED: { http: 400, message: 'The requested action is not allowed.' },
  APPROVAL_REQUIRED: { http: 409, message: 'This task requires approval before it can run.' },
  TASK_LIMIT_EXCEEDED: { http: 429, message: 'The task exceeds a configured limit.' },
  TASK_CANCELLED: { http: 409, message: 'The task was cancelled.' },
  TASK_EXPIRED: { http: 410, message: 'The task expired before it finished.' },
  TASK_NOT_ACTIONABLE: { http: 409, message: 'The task cannot be changed in its current state.' },
  ACTION_TIMEOUT: { http: 504, message: 'The device did not report the action result in time.' },
  TARGET_NOT_FOUND: { http: 409, message: 'The target element was not found on the current screen.' },
  SCREEN_BLOCKED: { http: 409, message: 'The current screen is protected; the action was not performed.' },
  APP_NOT_INSTALLED: { http: 404, message: 'The target application is not installed on the device.' },
  TARGET_AMBIGUOUS: { http: 409, message: 'The target element is ambiguous on the current screen.' },
});

export const TERMINAL_TASK_ERRORS = new Set([
  'TASK_CANCELLED',
  'TASK_EXPIRED',
  'DEVICE_OFFLINE',
  'DEVICE_REVOKED',
  'ACCESSIBILITY_NOT_ENABLED',
]);

/**
 * An application error carrying a stable machine readable code.
 */
export class AppError extends Error {
  constructor(code, options = {}) {
    const definition = ERROR_CODES[code] ?? ERROR_CODES.INTERNAL_ERROR;
    super(options.message ?? definition.message);
    this.name = 'AppError';
    this.code = ERROR_CODES[code] ? code : 'INTERNAL_ERROR';
    this.httpStatus = options.httpStatus ?? definition.http;
    this.details = options.details;
    this.cause = options.cause;
    this.retryable = options.retryable ?? false;
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

/**
 * Wrap any thrown value as an AppError so callers never leak stack traces.
 */
export function normalizeError(error, fallbackCode = 'INTERNAL_ERROR') {
  if (error instanceof AppError) return error;
  const wrapped = new AppError(fallbackCode, {
    cause: error,
    details: process.env.NODE_ENV === 'development' ? { reason: String(error?.message ?? error) } : undefined,
  });
  return wrapped;
}

export function isAppError(error, code) {
  return error instanceof AppError && (code === undefined || error.code === code);
}
