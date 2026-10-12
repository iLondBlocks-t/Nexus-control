import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * SQLite storage driver built on Node's built-in `node:sqlite` module
 * (Node.js >= 22.5, experimental). No native compilation, no extra dependency.
 *
 * The driver is loaded lazily so a host without `node:sqlite` can still run the
 * server with the JSON or memory driver.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  label TEXT,
  model TEXT,
  android_version TEXT,
  app_version TEXT,
  created_at TEXT NOT NULL,
  last_seen_at TEXT,
  connection_state TEXT,
  revoked_at TEXT,
  token_hash TEXT NOT NULL UNIQUE,
  accessibility_enabled INTEGER NOT NULL DEFAULT 0,
  launcher_packages TEXT
);

CREATE TABLE IF NOT EXISTS pairings (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  device_id TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  instruction TEXT NOT NULL,
  status TEXT NOT NULL,
  source TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  expires_at TEXT,
  action_count INTEGER NOT NULL DEFAULT 0,
  completed_actions INTEGER NOT NULL DEFAULT 0,
  requires_approval INTEGER NOT NULL DEFAULT 0,
  approval_state TEXT,
  result TEXT,
  error_code TEXT,
  plan_summary TEXT,
  current_action_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_owner ON tasks(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_device ON tasks(device_id, status);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  result TEXT,
  error_code TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  payload TEXT
);

CREATE INDEX IF NOT EXISTS idx_actions_task ON actions(task_id, sequence);

CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

function toDevice(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    ownerId: row.owner_id,
    label: row.label ?? undefined,
    model: row.model ?? undefined,
    androidVersion: row.android_version ?? undefined,
    appVersion: row.app_version ?? undefined,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at ?? undefined,
    connectionState: row.connection_state ?? undefined,
    revokedAt: row.revoked_at ?? undefined,
    tokenHash: row.token_hash,
    accessibilityEnabled: Boolean(row.accessibility_enabled),
    launcherPackages: row.launcher_packages ? JSON.parse(row.launcher_packages) : undefined,
  };
}

function toPairing(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    codeHash: row.code_hash,
    ownerId: row.owner_id,
    label: row.label ?? undefined,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at ?? undefined,
    failureCount: row.failure_count,
    deviceId: row.device_id ?? undefined,
  };
}

function toTask(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    ownerId: row.owner_id,
    deviceId: row.device_id,
    instruction: row.instruction,
    status: row.status,
    source: row.source ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    actionCount: row.action_count,
    completedActions: row.completed_actions,
    requiresApproval: Boolean(row.requires_approval),
    approvalState: row.approval_state ?? undefined,
    result: row.result ? JSON.parse(row.result) : undefined,
    errorCode: row.error_code ?? undefined,
    planSummary: row.plan_summary ?? undefined,
    currentActionId: row.current_action_id ?? undefined,
  };
}

function toAction(row) {
  if (!row) return undefined;
  return {
    id: row.id,
    taskId: row.task_id,
    sequence: row.sequence,
    type: row.type,
    status: row.status,
    createdAt: row.created_at,
    startedAt: row.started_at ?? undefined,
    finishedAt: row.finished_at ?? undefined,
    result: row.result ? JSON.parse(row.result) : undefined,
    errorCode: row.error_code ?? undefined,
    retryCount: row.retry_count,
    payload: row.payload ? JSON.parse(row.payload) : undefined,
  };
}

export async function isSqliteAvailable() {
  try {
    await import('node:sqlite');
    return true;
  } catch {
    return false;
  }
}

/** Turn "sqlite://./data/nexus.db" / "file:./data/nexus.db" / "/abs/path" into a path. */
export function normalizeSqlitePath(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return path.resolve(process.cwd(), 'data', 'nexus.db');
  return path.resolve(process.cwd(), raw.replace(/^(sqlite(\+file)?|file):\/\//, '').replace(/^file:/, ''));
}

export class SqliteStore {
  constructor({ file } = {}) {
    this.file = normalizeSqlitePath(file);
    this.db = null;
  }

  get driverName() {
    return 'sqlite';
  }

  get persistent() {
    return true;
  }

  async init() {
    const { DatabaseSync } = await import('node:sqlite');
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  async close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  #run(sql, params = []) {
    return this.db.prepare(sql).run(...params);
  }

  /* devices ---------------------------------------------------------- */

  async createDevice(record) {
    this.#run(
      `INSERT INTO devices (id, owner_id, label, model, android_version, app_version, created_at,
        last_seen_at, connection_state, revoked_at, token_hash, accessibility_enabled, launcher_packages)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.ownerId,
        record.label ?? null,
        record.model ?? null,
        record.androidVersion ?? null,
        record.appVersion ?? null,
        record.createdAt,
        record.lastSeenAt ?? null,
        record.connectionState ?? 'offline',
        record.revokedAt ?? null,
        record.tokenHash,
        record.accessibilityEnabled ? 1 : 0,
        record.launcherPackages ? JSON.stringify(record.launcherPackages.slice(0, 200)) : null,
      ],
    );
    return this.getDevice(record.id);
  }

  async getDevice(deviceId) {
    return toDevice(this.db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId));
  }

  async findDeviceByTokenHash(tokenHash) {
    return toDevice(this.db.prepare('SELECT * FROM devices WHERE token_hash = ?').get(tokenHash));
  }

  async listDevices(ownerId) {
    const rows = ownerId
      ? this.db.prepare('SELECT * FROM devices WHERE owner_id = ? ORDER BY created_at DESC').all(ownerId)
      : this.db.prepare('SELECT * FROM devices ORDER BY created_at DESC').all();
    return rows.map(toDevice);
  }

  async updateDevice(deviceId, patch) {
    const existing = await this.getDevice(deviceId);
    if (!existing) return undefined;
    const next = { ...existing, ...patch };
    this.#run(
      `UPDATE devices SET owner_id = ?, label = ?, model = ?, android_version = ?, app_version = ?,
        last_seen_at = ?, connection_state = ?, revoked_at = ?, token_hash = ?, accessibility_enabled = ?,
        launcher_packages = ?
       WHERE id = ?`,
      [
        next.ownerId,
        next.label ?? null,
        next.model ?? null,
        next.androidVersion ?? null,
        next.appVersion ?? null,
        next.lastSeenAt ?? null,
        next.connectionState ?? null,
        next.revokedAt ?? null,
        next.tokenHash,
        next.accessibilityEnabled ? 1 : 0,
        next.launcherPackages ? JSON.stringify(next.launcherPackages.slice(0, 200)) : null,
        deviceId,
      ],
    );
    return this.getDevice(deviceId);
  }

  /* pairing ---------------------------------------------------------- */

  async createPairing(record) {
    this.#run(
      `INSERT INTO pairings (id, code_hash, owner_id, label, created_at, expires_at, used_at, failure_count, device_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.codeHash,
        record.ownerId,
        record.label ?? null,
        record.createdAt,
        record.expiresAt,
        record.usedAt ?? null,
        record.failureCount ?? 0,
        record.deviceId ?? null,
      ],
    );
    return this.getPairing(record.id);
  }

  async getPairing(pairingId) {
    return toPairing(this.db.prepare('SELECT * FROM pairings WHERE id = ?').get(pairingId));
  }

  async listPairings() {
    return this.db.prepare('SELECT * FROM pairings ORDER BY created_at DESC').all().map(toPairing);
  }

  async updatePairing(pairingId, patch) {
    const existing = await this.getPairing(pairingId);
    if (!existing) return undefined;
    const next = { ...existing, ...patch };
    this.#run(
      `UPDATE pairings SET code_hash = ?, owner_id = ?, label = ?, expires_at = ?, used_at = ?,
        failure_count = ?, device_id = ? WHERE id = ?`,
      [
        next.codeHash,
        next.ownerId,
        next.label ?? null,
        next.expiresAt,
        next.usedAt ?? null,
        next.failureCount ?? 0,
        next.deviceId ?? null,
        pairingId,
      ],
    );
    return this.getPairing(pairingId);
  }

  async deleteExpiredPairings(now = Date.now()) {
    const result = this.#run('DELETE FROM pairings WHERE expires_at < ?', [new Date(now).toISOString()]);
    return Number(result.changes ?? 0);
  }

  /* tasks ------------------------------------------------------------ */

  async createTask(record) {
    this.#run(
      `INSERT INTO tasks (id, owner_id, device_id, instruction, status, source, created_at, updated_at,
        started_at, finished_at, expires_at, action_count, completed_actions, requires_approval,
        approval_state, result, error_code, plan_summary, current_action_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        record.id,
        record.ownerId,
        record.deviceId,
        record.instruction,
        record.status,
        record.source ?? null,
        record.createdAt,
        record.updatedAt ?? record.createdAt,
        record.startedAt ?? null,
        record.finishedAt ?? null,
        record.expiresAt ?? null,
        record.actionCount ?? 0,
        record.completedActions ?? 0,
        record.requiresApproval ? 1 : 0,
        record.approvalState ?? null,
        record.result ? JSON.stringify(record.result) : null,
        record.errorCode ?? null,
        record.planSummary ?? null,
        record.currentActionId ?? null,
      ],
    );
    return this.getTask(record.id);
  }

  async getTask(taskId) {
    return toTask(this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId));
  }

  async updateTask(taskId, patch) {
    const existing = await this.getTask(taskId);
    if (!existing) return undefined;
    const next = { ...existing, ...patch };
    this.#run(
      `UPDATE tasks SET status = ?, updated_at = ?, started_at = ?, finished_at = ?, expires_at = ?,
        action_count = ?, completed_actions = ?, requires_approval = ?, approval_state = ?, result = ?,
        error_code = ?, plan_summary = ?, current_action_id = ?, instruction = ?, device_id = ?
       WHERE id = ?`,
      [
        next.status,
        next.updatedAt ?? existing.updatedAt,
        next.startedAt ?? null,
        next.finishedAt ?? null,
        next.expiresAt ?? null,
        next.actionCount ?? 0,
        next.completedActions ?? 0,
        next.requiresApproval ? 1 : 0,
        next.approvalState ?? null,
        next.result ? JSON.stringify(next.result) : null,
        next.errorCode ?? null,
        next.planSummary ?? null,
        next.currentActionId ?? null,
        next.instruction,
        next.deviceId,
        taskId,
      ],
    );
    return this.getTask(taskId);
  }

  async listTasks({ ownerId, deviceId, limit = 50 } = {}) {
    let rows;
    if (ownerId && deviceId) {
      rows = this.db
        .prepare('SELECT * FROM tasks WHERE owner_id = ? AND device_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(ownerId, deviceId, limit);
    } else if (ownerId) {
      rows = this.db
        .prepare('SELECT * FROM tasks WHERE owner_id = ? ORDER BY created_at DESC LIMIT ?')
        .all(ownerId, limit);
    } else {
      rows = this.db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit);
    }
    return rows.map(toTask);
  }

  async listUnfinishedTasks() {
    const rows = this.db
      .prepare(`SELECT * FROM tasks WHERE status IN ('queued','planning','awaiting_approval','running')`)
      .all();
    return rows.map(toTask);
  }

  async countUnfinishedTasksForDevice(deviceId) {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM tasks
         WHERE device_id = ? AND status IN ('queued','planning','awaiting_approval','running')`,
      )
      .get(deviceId);
    return Number(row?.count ?? 0);
  }

  /* actions ---------------------------------------------------------- */

  async upsertAction(record) {
    this.#run(
      `INSERT INTO actions (id, task_id, sequence, type, status, created_at, started_at, finished_at,
        result, error_code, retry_count, payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         task_id = excluded.task_id,
         sequence = excluded.sequence,
         type = excluded.type,
         status = excluded.status,
         started_at = excluded.started_at,
         finished_at = excluded.finished_at,
         result = excluded.result,
         error_code = excluded.error_code,
         retry_count = excluded.retry_count,
         payload = excluded.payload`,
      [
        record.id,
        record.taskId,
        record.sequence,
        record.type,
        record.status,
        record.createdAt,
        record.startedAt ?? null,
        record.finishedAt ?? null,
        record.result ? JSON.stringify(record.result) : null,
        record.errorCode ?? null,
        record.retryCount ?? 0,
        record.payload ? JSON.stringify(record.payload) : null,
      ],
    );
    return record;
  }

  async appendAction(record) {
    return this.upsertAction(record);
  }

  async listActions(taskId) {
    return this.db
      .prepare('SELECT * FROM actions WHERE task_id = ? ORDER BY sequence ASC')
      .all(taskId)
      .map(toAction);
  }

  /* maintenance ------------------------------------------------------ */

  async pruneTasksOlderThan(timestampIso) {
    const tasks = this.db.prepare('SELECT id FROM tasks WHERE COALESCE(finished_at, created_at) < ?').all(timestampIso);
    for (const task of tasks) {
      this.#run('DELETE FROM actions WHERE task_id = ?', [task.id]);
      this.#run('DELETE FROM tasks WHERE id = ?', [task.id]);
    }
    return tasks.length;
  }

  /* key/value -------------------------------------------------------- */

  async getState(key) {
    const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key);
    return row ? JSON.parse(row.value) : undefined;
  }

  async setState(key, value) {
    this.#run('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [
      key,
      JSON.stringify(value),
    ]);
  }
}
