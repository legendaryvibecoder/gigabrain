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
  return db;
};

export {
  loadDatabaseSync,
  openDatabase,
  BUSY_TIMEOUT_MS,
  parseBusyTimeoutMs,
};
