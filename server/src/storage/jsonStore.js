import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { MemoryStore } from './memoryStore.js';

/**
 * JSON file storage driver.
 *
 * Keeps the whole dataset in memory and writes an atomic snapshot to disk after
 * every mutation. It is the default driver because it needs no native module and
 * works on any host that provides a writable directory.
 *
 * LIMITATION: the data lives in the process, so it is only durable if the host
 * gives the container a persistent filesystem. Run exactly one server instance
 * per data file. See docs/DEPLOYMENT.md.
 */
export class JsonFileStore extends MemoryStore {
  constructor({ file = './data/nexus-store.json' } = {}) {
    super();
    this.file = path.resolve(process.cwd(), file);
    this.writeQueue = Promise.resolve();
  }

  get driverName() {
    return 'json';
  }

  get persistent() {
    return true;
  }

  async init() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    try {
      const raw = await fsp.readFile(this.file, 'utf8');
      if (raw.trim()) this.restore(JSON.parse(raw));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await this.#persist();
    }
    this.closed = false;
  }

  async #persist() {
    const data = JSON.stringify(this.snapshot(), null, 2);
    const temporary = `${this.file}.tmp`;
    // Serialise writes so two concurrent mutations cannot interleave.
    this.writeQueue = this.writeQueue.then(async () => {
      await fsp.writeFile(temporary, data, 'utf8');
      await fsp.rename(temporary, this.file);
    });
    return this.writeQueue;
  }

  async #commit() {
    if (this.closed) return;
    try {
      await this.#persist();
    } catch (error) {
      process.stderr.write(`nexus: failed to persist store: ${error.message}\n`);
    }
  }

  async createDevice(record) {
    const result = await super.createDevice(record);
    await this.#commit();
    return result;
  }

  async updateDevice(deviceId, patch) {
    const result = await super.updateDevice(deviceId, patch);
    if (result) await this.#commit();
    return result;
  }

  async createPairing(record) {
    const result = await super.createPairing(record);
    await this.#commit();
    return result;
  }

  async updatePairing(id, patch) {
    const result = await super.updatePairing(id, patch);
    if (result) await this.#commit();
    return result;
  }

  async deleteExpiredPairings(now) {
    const removed = await super.deleteExpiredPairings(now);
    if (removed) await this.#commit();
    return removed;
  }

  async createTask(record) {
    const result = await super.createTask(record);
    await this.#commit();
    return result;
  }

  async updateTask(id, patch) {
    const result = await super.updateTask(id, patch);
    if (result) await this.#commit();
    return result;
  }

  async upsertAction(record) {
    const result = await super.upsertAction(record);
    await this.#commit();
    return result;
  }

  async appendAction(record) {
    return this.upsertAction(record);
  }

  async pruneTasksOlderThan(timestampIso) {
    const removed = await super.pruneTasksOlderThan(timestampIso);
    if (removed) await this.#commit();
    return removed;
  }

  async setState(key, value) {
    await super.setState(key, value);
    await this.#commit();
  }

  async close() {
    await this.writeQueue.catch(() => {});
    if (!this.closed) await this.#persist();
    await super.close();
  }
}

export function defaultJsonPath() {
  return fs.existsSync(path.resolve(process.cwd(), 'data')) ? './data/nexus-store.json' : './data/nexus-store.json';
}
