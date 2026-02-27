import { DatabaseSync } from 'node:sqlite';

const BUSY_TIMEOUT_MS = Math.max(
  0,
  Number.parseInt(process.env.GB_SQLITE_BUSY_TIMEOUT_MS || '5000', 10) || 5000,
);

const openDatabase = (dbPath, options = {}) => {
  const db = new DatabaseSync(dbPath, options);
  try {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  } catch {
    // Best-effort hardening for older SQLite builds.
  }
  return db;
};

export {
  DatabaseSync,
  openDatabase,
  BUSY_TIMEOUT_MS,
};
