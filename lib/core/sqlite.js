import fs from 'node:fs';
import { createRequire } from 'node:module';

import { ensureSupportedNodeRuntime } from './runtime-guard.js';

const require = createRequire(import.meta.url);
let cachedDatabaseSync = null;

const parseBusyTimeoutMs = (value, fallback = 5000) => {
  const trimmed = typeof value === 'string' ? value.trim() : value;
  if (trimmed === '') return fallback;
  const num = Number(trimmed);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(0, Math.min(600000, Math.trunc(num)));
};

const BUSY_TIMEOUT_MS = parseBusyTimeoutMs(process.env.GB_SQLITE_BUSY_TIMEOUT_MS, 5000);

const loadDatabaseSync = () => {
  ensureSupportedNodeRuntime({
    component: 'Gigabrain SQLite runtime',
  });
  if (!cachedDatabaseSync) {
    cachedDatabaseSync = require('node:sqlite').DatabaseSync;
  }
  return cachedDatabaseSync;
};

const openDatabase = (dbPath, options = {}) => {
  const DatabaseSync = loadDatabaseSync();
  const db = new DatabaseSync(dbPath, options);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  } catch {
    // Best-effort hardening for older SQLite builds.
  }
  try {
    db.exec('PRAGMA foreign_keys = ON');
  } catch {
    // Best-effort on older or restricted SQLite builds.
  }
  // WAL is required because several same-host processes share this database
  // (two MCP servers, nightly, lifecycle hooks, CLI). Rollback-journal mode
  // creates/deletes registry.sqlite-journal on every write txn, which racing
  // openers observe as transient SQLITE_CANTOPEN(14) — an error class no
  // busy_timeout retries — and writers block all readers. WAL removes both
  // and makes synchronous=NORMAL safe. Persistent per DB file; fails
  // harmlessly on read-only connections.
  try {
    db.exec('PRAGMA journal_mode = WAL');
  } catch {
    // read-only open or immutable media — keep existing journal mode
  }
  // The registry can hold personal memory content; the
  // default umask leaves it world-readable. Idempotent tighten to 0600.
  try {
    if (options?.readOnly !== true && typeof dbPath === 'string' && dbPath !== ':memory:' && fs.existsSync(dbPath)) {
      fs.chmodSync(dbPath, 0o600);
    }
  } catch {
    // best-effort (e.g. foreign-owned file) — never fail the open
  }
  return db;
};

export {
  loadDatabaseSync,
  openDatabase,
  BUSY_TIMEOUT_MS,
  parseBusyTimeoutMs,
};
