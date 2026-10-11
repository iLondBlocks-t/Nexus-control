import crypto from 'node:crypto';

const ID_PREFIX = {
  device: 'dev',
  task: 'task',
  action: 'act',
  pairing: 'pr',
  message: 'msg',
};

/**
 * Short, sortable, URL safe identifier: "<prefix>_<timebase36><random>".
 */
export function createId(prefix) {
  const tag = ID_PREFIX[prefix] ?? prefix;
  const stamp = Date.now().toString(36);
  const random = crypto.randomBytes(5).toString('hex');
  return `${tag}_${stamp}${random}`;
}

/** Cryptographically secure device token (never stored in plain text). */
export function createDeviceToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Human readable one-time pairing code: "ABCD-EFGH" (no ambiguous characters). */
export function createPairingCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(8);
  let raw = '';
  for (let i = 0; i < 8; i += 1) raw += alphabet[bytes[i] % alphabet.length];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function normalizePairingCode(value) {
  return String(value ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, '');
}

/** SHA-256 hash used for storing device tokens and pairing codes. */
export function sha256(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex');
}

/** Constant time comparison of two secret strings. */
export function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

/** Safe comparison against a list of accepted secrets. */
export function matchesAny(candidate, list) {
  if (!candidate) return false;
  let matched = false;
  for (const entry of list) {
    if (safeEqual(candidate, entry)) matched = true;
  }
  return matched;
}
