import fs from 'node:fs';
import path from 'node:path';

/**
 * Minimal ".env" loader.
 *
 * Existing process environment variables always win, so a hosting provider's
 * secret store overrides anything committed in a local ".env" file.
 * The file is optional: the server runs from real environment variables alone.
 */
export function loadEnvFile(file = '.env') {
  const resolved = path.resolve(process.cwd(), file);
  let raw;
  try {
    raw = fs.readFileSync(resolved, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return { loaded: false, path: resolved, values: {} };
    throw error;
  }

  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!key) continue;
    values[key] = value;
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return { loaded: true, path: resolved, values };
}

export function splitList(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}
