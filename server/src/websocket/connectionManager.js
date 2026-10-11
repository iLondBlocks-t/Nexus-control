import { getLogger } from '../logging/logger.js';

/**
 * Presence registry: which device currently has a live, authenticated socket.
 *
 * The server never opens connections to a phone. Phones connect outwards, which
 * is why "online" here means "a device has an authenticated socket right now".
 */
export class ConnectionManager {
  constructor({ registry, logger = getLogger({ component: 'presence' }) } = {}) {
    this.registry = registry;
    this.logger = logger;
    this.connections = new Map();
  }

  get size() {
    return this.connections.size;
  }

  has(deviceId) {
    const entry = this.connections.get(deviceId);
    return Boolean(entry && entry.socket.readyState === entry.socket.OPEN);
  }

  isOnline(deviceId) {
    return this.has(deviceId);
  }

  /**
   * Attach a socket to a device. A second connection for the same device
   * replaces the first one (the phone reconnected before the old socket died).
   */
  add(deviceId, socket, metadata = {}) {
    const existing = this.connections.get(deviceId);
    if (existing && existing.socket !== socket) {
      this.logger.warn('device.connection_replaced', { deviceId });
      try {
        existing.socket.close(4001, 'superseded');
      } catch {
        /* socket already gone */
      }
    }
    this.connections.set(deviceId, { socket, deviceId, since: Date.now(), ...metadata });
    return existing ? 'replaced' : 'added';
  }

  remove(deviceId, socket) {
    const entry = this.connections.get(deviceId);
    if (!entry) return false;
    if (socket && entry.socket !== socket) return false;
    this.connections.delete(deviceId);
    return true;
  }

  get(deviceId) {
    const entry = this.connections.get(deviceId);
    if (!entry) return null;
    if (entry.socket.readyState !== entry.socket.OPEN) {
      this.connections.delete(deviceId);
      return null;
    }
    return entry;
  }

  onlineDeviceIds() {
    return [...this.connections.keys()].filter((id) => this.has(id));
  }

  setAccessibility(deviceId, enabled) {
    const entry = this.connections.get(deviceId);
    if (entry) entry.accessibilityEnabled = Boolean(enabled);
    return entry ?? null;
  }

  isAccessibilityEnabled(deviceId) {
    return Boolean(this.connections.get(deviceId)?.accessibilityEnabled);
  }

  closeAll(code = 1001, reason = 'server_shutdown') {
    for (const entry of this.connections.values()) {
      try {
        entry.socket.close(code, reason);
      } catch {
        /* ignore */
      }
    }
    this.connections.clear();
  }
}
