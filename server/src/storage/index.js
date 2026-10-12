import { MemoryStore } from './memoryStore.js';
import { JsonFileStore } from './jsonStore.js';
import { SqliteStore, isSqliteAvailable } from './sqliteStore.js';
import { AppError } from '../utils/errors.js';

/**
 * Storage factory.
 *
 * Drivers:
 *  - "json"    : atomic JSON snapshots on disk (default, no native modules).
 *  - "sqlite"  : Node's built-in `node:sqlite` (Node.js >= 22.5, experimental).
 *  - "memory"  : no persistence at all (tests).
 */
export async function createStorage(config) {
  const requested = config.storage.driver;
  const pathOrUrl = config.storage.databaseUrl || config.storage.path;

  if (requested === 'memory') {
    const store = new MemoryStore();
    await store.init();
    return { store, driver: 'memory', persistent: false };
  }

  if (requested === 'sqlite') {
    if (!(await isSqliteAvailable())) {
      throw new AppError('INTERNAL_ERROR', {
        message:
          'STORAGE_DRIVER=sqlite requires Node.js >= 22.5 with the built-in node:sqlite module. Use STORAGE_DRIVER=json instead.',
      });
    }
    const store = new SqliteStore({ file: pathOrUrl || './data/nexus.db' });
    await store.init();
    return { store, driver: 'sqlite', persistent: true };
  }

  const store = new JsonFileStore({ file: pathOrUrl || './data/nexus-store.json' });
  await store.init();
  return { store, driver: 'json', persistent: true };
}

export { MemoryStore, JsonFileStore, SqliteStore };
