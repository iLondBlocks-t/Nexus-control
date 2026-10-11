/**
 * In-memory storage driver.
 *
 * Used by the unit tests and as the base for the JSON file driver. Records are
 * plain objects; the driver never interprets task semantics.
 */

function clone(value) {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

export class MemoryStore {
  constructor() {
    this.devices = new Map();
    this.pairings = new Map();
    this.tasks = new Map();
    this.actions = new Map();
    this.state = new Map();
    this.closed = false;
  }

  async init() {
    this.closed = false;
  }

  async close() {
    this.closed = true;
  }

  get driverName() {
    return 'memory';
  }

  get persistent() {
    return false;
  }

  /* devices ---------------------------------------------------------- */

  async createDevice(record) {
    this.devices.set(record.id, clone(record));
    return clone(record);
  }

  async getDevice(deviceId) {
    return clone(this.devices.get(deviceId));
  }

  async findDeviceByTokenHash(tokenHash) {
    for (const device of this.devices.values()) {
      if (device.tokenHash === tokenHash) return clone(device);
    }
    return undefined;
  }

  async listDevices(ownerId) {
    return [...this.devices.values()]
      .filter((device) => (ownerId ? device.ownerId === ownerId : true))
      .map(clone)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  }

  async updateDevice(deviceId, patch) {
    const existing = this.devices.get(deviceId);
    if (!existing) return undefined;
    const next = { ...existing, ...patch };
    this.devices.set(deviceId, next);
    return clone(next);
  }

  /* pairing ---------------------------------------------------------- */

  async createPairing(record) {
    this.pairings.set(record.id, clone(record));
    return clone(record);
  }

  async getPairing(pairingId) {
    return clone(this.pairings.get(pairingId));
  }

  async updatePairing(pairingId, patch) {
    const existing = this.pairings.get(pairingId);
    if (!existing) return undefined;
    const next = { ...existing, ...patch };
    this.pairings.set(pairingId, next);
    return clone(next);
  }

  async listPairings() {
    return [...this.pairings.values()].map(clone);
  }

  async deleteExpiredPairings(now = Date.now()) {
    let removed = 0;
    for (const [id, pairing] of [...this.pairings.entries()]) {
      if (Date.parse(pairing.expiresAt) < now) {
        this.pairings.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /* tasks ------------------------------------------------------------ */

  async createTask(record) {
    this.tasks.set(record.id, clone(record));
    this.actions.set(record.id, []);
    return clone(record);
  }

  async getTask(taskId) {
    return clone(this.tasks.get(taskId));
  }

  async updateTask(taskId, patch) {
    const existing = this.tasks.get(taskId);
    if (!existing) return undefined;
    const next = { ...existing, ...patch };
    this.tasks.set(taskId, next);
    return clone(next);
  }

  async listTasks({ ownerId, deviceId, limit = 50 } = {}) {
    return [...this.tasks.values()]
      .filter((task) => (ownerId ? task.ownerId === ownerId : true))
      .filter((task) => (deviceId ? task.deviceId === deviceId : true))
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
      .slice(0, limit)
      .map(clone);
  }

  async listUnfinishedTasks() {
    return [...this.tasks.values()]
      .filter((task) => ['queued', 'planning', 'awaiting_approval', 'running'].includes(task.status))
      .map(clone);
  }

  async countUnfinishedTasksForDevice(deviceId) {
    return [...this.tasks.values()].filter(
      (task) => task.deviceId === deviceId && ['queued', 'planning', 'awaiting_approval', 'running'].includes(task.status),
    ).length;
  }

  /* actions ---------------------------------------------------------- */

  /**
   * Insert or replace an action record.
   *
   * The executor writes the record when an action starts and updates the same
   * record (same id) when it finishes, so this must be an upsert.
   */
  async upsertAction(record) {
    const list = this.actions.get(record.taskId) ?? [];
    const index = list.findIndex((entry) => entry.id === record.id);
    if (index === -1) list.push(clone(record));
    else list[index] = { ...list[index], ...clone(record) };
    list.sort((a, b) => a.sequence - b.sequence);
    this.actions.set(record.taskId, list);
    return clone(record);
  }

  async appendAction(record) {
    return this.upsertAction(record);
  }

  async listActions(taskId) {
    return clone(this.actions.get(taskId) ?? []);
  }

  /* maintenance ------------------------------------------------------ */

  async pruneTasksOlderThan(timestampIso) {
    let removed = 0;
    const cutoff = Date.parse(timestampIso);
    for (const [id, task] of [...this.tasks.entries()]) {
      const finished = task.finishedAt ? Date.parse(task.finishedAt) : null;
      const reference = finished ?? Date.parse(task.createdAt);
      if (reference < cutoff) {
        this.tasks.delete(id);
        this.actions.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  /* key/value -------------------------------------------------------- */

  async getState(key) {
    return clone(this.state.get(key));
  }

  async setState(key, value) {
    this.state.set(key, clone(value));
  }

  /** Serialise the whole store (used by the JSON file driver). */
  snapshot() {
    return {
      version: 1,
      devices: [...this.devices.values()],
      pairings: [...this.pairings.values()],
      tasks: [...this.tasks.values()],
      actions: [...this.actions.entries()].map(([taskId, list]) => ({ taskId, list })),
      state: [...this.state.entries()].map(([key, value]) => ({ key, value })),
    };
  }

  /** Restore a snapshot produced by `snapshot()`. */
  restore(data) {
    if (!data || typeof data !== 'object') return;
    this.devices = new Map((data.devices ?? []).map((entry) => [entry.id, entry]));
    this.pairings = new Map((data.pairings ?? []).map((entry) => [entry.id, entry]));
    this.tasks = new Map((data.tasks ?? []).map((entry) => [entry.id, entry]));
    this.actions = new Map((data.actions ?? []).map((entry) => [entry.taskId, entry.list ?? []]));
    this.state = new Map((data.state ?? []).map((entry) => [entry.key, entry.value]));
  }
}
