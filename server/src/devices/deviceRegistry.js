import { AppError } from '../utils/errors.js';
import { createId, createDeviceToken } from '../utils/ids.js';
import { hashDeviceToken } from '../auth/deviceAuth.js';

/**
 * Device registry: pairing output, presence, revocation.
 */
export class DeviceRegistry {
  constructor({ store, logger }) {
    this.store = store;
    this.logger = logger;
  }

  /** Create a device record and return the one-time plaintext token. */
  async register({ ownerId, label, model, androidVersion, appVersion, pairingId }) {
    const token = createDeviceToken();
    const now = new Date().toISOString();
    const device = await this.store.createDevice({
      id: createId('device'),
      ownerId,
      label: label ?? model ?? 'Android device',
      model,
      androidVersion,
      appVersion,
      createdAt: now,
      lastSeenAt: null,
      connectionState: 'never_connected',
      revokedAt: null,
      tokenHash: hashDeviceToken(token),
      accessibilityEnabled: false,
    });
    this.logger?.info('device.registered', {
      deviceId: device.id,
      ownerId,
      pairingId: pairingId ?? null,
      model: model ?? null,
    });
    return { device, token };
  }

  async list(ownerId) {
    return this.store.listDevices(ownerId);
  }

  async get(deviceId) {
    return this.store.getDevice(deviceId);
  }

  /** Fetch a device only if it belongs to the owner. */
  async getForOwner(ownerId, deviceId) {
    const device = await this.store.getDevice(deviceId);
    if (!device || device.ownerId !== ownerId) throw new AppError('DEVICE_NOT_PAIRED');
    return device;
  }

  async revoke(ownerId, deviceId) {
    const device = await this.getForOwner(ownerId, deviceId);
    if (device.revokedAt) return device;
    const updated = await this.store.updateDevice(deviceId, {
      revokedAt: new Date().toISOString(),
      connectionState: 'revoked',
    });
    this.logger?.warn('device.revoked', { deviceId, ownerId });
    return updated;
  }

  async markSeen(deviceId, patch = {}) {
    return this.store.updateDevice(deviceId, {
      lastSeenAt: new Date().toISOString(),
      ...patch,
    });
  }

  async findByTokenHash(tokenHash) {
    return this.store.findDeviceByTokenHash(tokenHash);
  }

  /** Resolve a device and reject anything that may not receive commands. */
  async requireControllable(ownerId, deviceId) {
    const device = await this.getForOwner(ownerId, deviceId);
    if (device.revokedAt) throw new AppError('DEVICE_REVOKED');
    return device;
  }

  toPublicRecord(device, { online = false } = {}) {
    return {
      device_id: device.id,
      label: device.label,
      model: device.model ?? null,
      android_version: device.androidVersion ?? null,
      app_version: device.appVersion ?? null,
      created_at: device.createdAt,
      last_seen_at: device.lastSeenAt ?? null,
      connection_state: online ? 'connected' : device.connectionState ?? 'offline',
      online,
      accessibility_enabled: Boolean(device.accessibilityEnabled),
      revoked_at: device.revokedAt ?? null,
    };
  }
}
