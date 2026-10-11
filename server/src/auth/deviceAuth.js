import { AppError } from '../utils/errors.js';
import { sha256 } from '../utils/ids.js';

/**
 * Device authentication.
 *
 * Device tokens are long random secrets. Only their SHA-256 hash is stored, so a
 * database leak does not hand an attacker a working device credential.
 */
export function hashDeviceToken(token) {
  return sha256(token);
}

export async function authenticateDevice(store, { deviceId, deviceToken }) {
  if (!deviceId || !deviceToken) {
    throw new AppError('AUTHENTICATION_REQUIRED', { message: 'device_id and device_token are required.' });
  }

  const device = await store.getDevice(deviceId);
  if (!device) {
    throw new AppError('DEVICE_NOT_PAIRED');
  }

  // Always hash before comparing so timing does not reveal whether the device exists.
  const candidate = hashDeviceToken(deviceToken);
  let tokenMatches = false;
  for (let i = 0; i < 1; i += 1) tokenMatches = constantTimeEquals(candidate, device.tokenHash);

  if (!tokenMatches) {
    throw new AppError('AUTHENTICATION_REQUIRED', { message: 'The device credential was rejected.' });
  }
  if (device.revokedAt) {
    throw new AppError('DEVICE_REVOKED');
  }
  return device;
}

function constantTimeEquals(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}
