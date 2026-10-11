import { redact, registerSecret } from './redact.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

function resolveLevel(name) {
  return LEVELS[String(name ?? 'info').toLowerCase()] ?? LEVELS.info;
}

/**
 * Minimal structured logger.
 *
 * Emits one JSON object per line (default) so a hosting provider can index it.
 * Every payload passes through the redactor before it is written.
 */
export class Logger {
  constructor({ level = 'info', format = 'json', base = {}, write = (line) => process.stdout.write(line) } = {}) {
    this.threshold = resolveLevel(level);
    this.format = format;
    this.base = base;
    this.write = write;
  }

  child(base = {}) {
    return new Logger({
      level: levelName(this.threshold),
      format: this.format,
      base: { ...this.base, ...base },
      write: this.write,
    });
  }

  isLevelEnabled(name) {
    return resolveLevel(name) >= this.threshold;
  }

  #emit(level, event, fields = {}) {
    if (resolveLevel(level) < this.threshold) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      event,
      ...this.base,
      ...fields,
    };
    if (record.error instanceof Error) {
      record.error = { name: record.error.name, message: redact(record.error.message), code: record.error.code };
    }
    const safe = redact(record);
    const line = this.format === 'pretty'
      ? `${safe.ts} ${level.toUpperCase().padEnd(5)} ${event} ${safeFields(safe)}`
      : `${JSON.stringify(safe)}\n`;
    this.write(line);
  }

  debug(event, fields) {
    this.#emit('debug', event, fields);
  }

  info(event, fields) {
    this.#emit('info', event, fields);
  }

  warn(event, fields) {
    this.#emit('warn', event, fields);
  }

  error(event, fields) {
    this.#emit('error', event, fields);
  }
}

function safeFields(record) {
  const { ts, level, event, ...rest } = record;
  return Object.keys(rest).length ? JSON.stringify(rest) : '';
}

function levelName(threshold) {
  return Object.keys(LEVELS).find((name) => LEVELS[name] === threshold) ?? 'info';
}

let root = new Logger({ level: process.env.LOG_LEVEL ?? 'info' });

export function configureLogger({ level, format, base }) {
  root = new Logger({
    level: level ?? process.env.LOG_LEVEL ?? 'info',
    format: format ?? process.env.LOG_FORMAT ?? 'json',
    base: base ?? {},
  });
  return root;
}

export function getLogger(base) {
  return base ? root.child(base) : root;
}

/** Register values that must never be logged (tokens, API keys, pairing codes). */
export function protectSecret(value) {
  registerSecret(value);
}
