/**
 * Central secret redaction.
 *
 * Any value registered here is replaced with "[REDACTED]" before it can reach a
 * log line, an error message or an API response. Registration happens in the
 * logger module when configuration is loaded.
 */

const REDACTED = '[REDACTED]';
const secrets = new Set();

const KEY_PATTERN =
  /(authorization|proxy-authorization|x-nexus-owner-token|api[-_]?key|access[-_]?token|refresh[-_]?token|device[-_]?token|pairing[-_]?code|password|passwd|secret|otp|one[-_]?time|cookie|set-cookie|session[-_]?token|bot[-_]?token)/i;

const VALUE_PATTERNS = [
  // OpenAI style keys: sk-... (any project/scoped variants included)
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  // Telegram bot tokens: <id>:<35 chars>
  /\b\d{6,12}:[A-Za-z0-9_-]{35}\b/g,
  // NEXUS device tokens are secrets; device ids ("dev_" + ~16 chars) are not.
  /\bdev_[A-Za-z0-9_-]{28,}\b/g,
  // Bearer headers
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
];

export function registerSecret(value) {
  if (typeof value !== 'string') return;
  const trimmed = value.trim();
  if (trimmed.length >= 6) secrets.add(trimmed);
}

export function clearSecrets() {
  secrets.clear();
}

export function redactString(input) {
  let output = String(input);
  for (const secret of secrets) {
    if (output.includes(secret)) {
      output = output.split(secret).join(REDACTED);
    }
  }
  for (const pattern of VALUE_PATTERNS) {
    output = output.replace(pattern, REDACTED);
  }
  return output;
}

/**
 * Recursively redact a value. Object keys that look secret are dropped entirely,
 * everything else is scanned for known secret values and token shapes.
 */
export function redact(value) {
  if (value === null || value === undefined) return value;
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => redact(entry));

  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (KEY_PATTERN.test(key)) {
      result[key] = REDACTED;
      continue;
    }
    result[key] = redact(entry);
  }
  return result;
}

export { REDACTED, KEY_PATTERN };
