import { AppError } from '../utils/errors.js';
import { createId, createPairingCode, normalizePairingCode, sha256, safeEqual } from '../utils/ids.js';

/**
 * Short-lived, single-use pairing codes.
 *
 * The owner creates a code through an authenticated channel (HTTP API or bot).
 * The phone redeems it once; the server answers with a scoped device credential.
 * Only the hash of the code is stored, and failed attempts are counted so a code
 * cannot be brute forced.
 */
export class PairingService {
  constructor({ store, registry, config, logger }) {
    this.store = store;
    this.registry = registry;
    this.config = config;
    this.logger = logger;
    // Per-source failure tracking. A wrong code cannot be attributed to a single
    // pairing record, so attempts are counted per source (IP) instead: after
    // `maxAttempts` wrong codes inside the window, that source is locked out.
    this.failures = new Map();
  }

  /**
   * @returns {boolean} true when the source has exhausted its attempts.
   */
  isLockedOut(sourceKey) {
    const entry = this.failures.get(sourceKey);
    if (!entry) return false;
    if (Date.now() - entry.firstAt > this.config.pairing.failureWindowSeconds * 1000) {
      this.failures.delete(sourceKey);
      return false;
    }
    return entry.count >= this.config.pairing.maxAttempts;
  }

  registerAttemptFailure(sourceKey) {
    const now = Date.now();
    const entry = this.failures.get(sourceKey);
    if (!entry || now - entry.firstAt > this.config.pairing.failureWindowSeconds * 1000) {
      this.failures.set(sourceKey, { count: 1, firstAt: now });
      return 1;
    }
    entry.count += 1;
    return entry.count;
  }

  clearAttempts(sourceKey) {
    this.failures.delete(sourceKey);
  }

  async createCode({ ownerId, label }) {
    const code = createPairingCode();
    const now = Date.now();
    const pairing = await this.store.createPairing({
      id: createId('pairing'),
      codeHash: sha256(normalizePairingCode(code)),
      ownerId,
      label: label ?? null,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + this.config.pairing.ttlSeconds * 1000).toISOString(),
      usedAt: null,
      failureCount: 0,
      deviceId: null,
    });
    this.logger.info('pairing.created', {
      pairingId: pairing.id,
      ownerId,
      expiresAt: pairing.expiresAt,
    });
    return {
      pairing_id: pairing.id,
      code,
      expires_at: pairing.expiresAt,
      expires_in_seconds: this.config.pairing.ttlSeconds,
    };
  }

  /**
   * Redeem a pairing code.
   * @returns {Promise<{deviceId: string, deviceToken: string, device: object, ownerId: string}>}
   */
  async complete({ code, client = {} }) {
    const normalized = normalizePairingCode(code);
    if (normalized.length !== 8) {
      throw new AppError('PAIRING_INVALID');
    }

    const candidateHash = sha256(normalized);
    const pairings = await this.store.listPairings();
    const pairing = pairings.find((entry) => safeEqual(entry.codeHash, candidateHash));

    if (!pairing) {
      this.logger.warn('pairing.invalid_code', { codeLength: normalized.length });
      throw new AppError('PAIRING_INVALID');
    }

    if (pairing.usedAt) throw new AppError('PAIRING_USED');
    if (Date.parse(pairing.expiresAt) < Date.now()) {
      await this.store.updatePairing(pairing.id, { usedAt: new Date().toISOString() });
      throw new AppError('PAIRING_EXPIRED');
    }
    if (pairing.failureCount >= this.config.pairing.maxAttempts) {
      throw new AppError('PAIRING_LOCKED');
    }

    const { device, token } = await this.registry.register({
      ownerId: pairing.ownerId,
      label: pairing.label ?? client.device_model ?? 'Android device',
      model: client.device_model,
      androidVersion: client.android_version,
      appVersion: client.app_version,
      pairingId: pairing.id,
    });

    await this.store.updatePairing(pairing.id, {
      usedAt: new Date().toISOString(),
      deviceId: device.id,
    });

    this.logger.info('pairing.completed', { pairingId: pairing.id, deviceId: device.id, ownerId: pairing.ownerId });
    return { deviceId: device.id, deviceToken: token, device, ownerId: pairing.ownerId };
  }

  async registerFailure(code) {
    const normalized = normalizePairingCode(code);
    if (normalized.length !== 8) return { failureCount: 0 };
    const candidateHash = sha256(normalized);
    const pairings = await this.store.listPairings();
    const pairing = pairings.find((entry) => safeEqual(entry.codeHash, candidateHash));
    if (!pairing) return { failureCount: 0 };
    const updated = await this.store.updatePairing(pairing.id, { failureCount: (pairing.failureCount ?? 0) + 1 });
    return { failureCount: updated?.failureCount ?? pairing.failureCount };
  }

  async pruneExpired() {
    return this.store.deleteExpiredPairings(Date.now());
  }
}
