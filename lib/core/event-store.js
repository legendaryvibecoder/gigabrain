import { randomUUID } from 'node:crypto';

const ensureEventStore = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_events (
      event_id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      component TEXT NOT NULL,
      action TEXT NOT NULL,
      reason_codes TEXT NOT NULL DEFAULT '[]',
      memory_id TEXT NOT NULL,
      cleanup_version TEXT NOT NULL,
      run_id TEXT NOT NULL,
      review_version TEXT NOT NULL,
      similarity REAL,
      matched_memory_id TEXT,
      payload TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memory_events_memory_ts ON memory_events(memory_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_memory_events_review ON memory_events(review_version, action);
    CREATE INDEX IF NOT EXISTS idx_memory_events_run ON memory_events(run_id, timestamp);
  `);
};

const normalizeReasonCodes = (value) => {
  const arr = Array.isArray(value) ? value : [value];
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    const code = String(item || '').trim().toLowerCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
};

const buildEvent = (event = {}, defaults = {}) => {
  const timestamp = String(event.timestamp || defaults.timestamp || new Date().toISOString());
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  return {
    event_id: String(event.event_id || randomUUID()),
    timestamp,
    component: String(event.component || defaults.component || 'maintenance'),
    action: String(event.action || defaults.action || 'noop'),
    reason_codes: normalizeReasonCodes(event.reason_codes || defaults.reason_codes || []),
    memory_id: String(event.memory_id || defaults.memory_id || ''),
    cleanup_version: String(event.cleanup_version || defaults.cleanup_version || 'v3.0.0'),
    run_id: String(event.run_id || defaults.run_id || ''),
    review_version: String(event.review_version || defaults.review_version || ''),
    similarity: Number.isFinite(Number(event.similarity)) ? Number(event.similarity) : null,
    matched_memory_id: event.matched_memory_id ? String(event.matched_memory_id) : null,
    payload,
  };
};

const appendEvent = (db, event = {}, defaults = {}) => {
  ensureEventStore(db);
  const row = buildEvent(event, defaults);
  if (!row.memory_id && row.action !== 'maintenance_start' && row.action !== 'maintenance_end') {
    throw new Error(`memory_id is required for memory event action=${row.action}`);
  }
  const stmt = db.prepare(`
    INSERT INTO memory_events (
      event_id, timestamp, component, action, reason_codes, memory_id, cleanup_version,
      run_id, review_version, similarity, matched_memory_id, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    row.event_id,
    row.timestamp,
    row.component,
    row.action,
    JSON.stringify(row.reason_codes),
    row.memory_id,
    row.cleanup_version,
    row.run_id,
    row.review_version,
    row.similarity,
    row.matched_memory_id,
    JSON.stringify(row.payload || {}),
  );
  return row;
};

const appendEvents = (db, events = [], defaults = {}) => {
  if (!Array.isArray(events) || events.length === 0) return [];
  const rows = [];
  db.exec('BEGIN');
  try {
    for (const event of events) {
      rows.push(appendEvent(db, event, defaults));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return rows;
};

// Allowed property whitelist to prevent prototype pollution
const FORBIDDEN_JSON_PROPS = new Set(['__proto__', 'constructor', 'prototype']);

const sanitizeParsedJson = (obj) => {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => sanitizeParsedJson(item));
  }
  const sanitized = {};
  for (const key of Object.keys(obj)) {
    // Block prototype pollution keys
    if (FORBIDDEN_JSON_PROPS.has(key)) continue;
    const value = obj[key];
    if (value && typeof value === 'object') {
      sanitized[key] = sanitizeParsedJson(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
};

const parseJsonSafe = (value, fallback) => {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(String(value));
    // Sanitize to prevent prototype pollution
    return sanitizeParsedJson(parsed);
  } catch {
    return fallback;
  }
};

const listTimeline = (db, memoryId, options = {}) => {
  ensureEventStore(db);
  const limit = Math.max(1, Math.min(2000, Number(options.limit || 200) || 200));
  const rows = db.prepare(`
    SELECT
      event_id, timestamp, component, action, reason_codes, memory_id,
      cleanup_version, run_id, review_version, similarity, matched_memory_id, payload
    FROM memory_events
    WHERE memory_id = ?
    ORDER BY timestamp ASC
    LIMIT ?
  `).all(String(memoryId || ''), limit);
  return rows.map((row) => ({
    event_id: String(row.event_id),
    timestamp: String(row.timestamp),
    component: String(row.component),
    action: String(row.action),
    reason_codes: parseJsonSafe(row.reason_codes, []),
    memory_id: String(row.memory_id),
    cleanup_version: String(row.cleanup_version || ''),
    run_id: String(row.run_id || ''),
    review_version: String(row.review_version || ''),
    similarity: Number.isFinite(Number(row.similarity)) ? Number(row.similarity) : null,
    matched_memory_id: row.matched_memory_id ? String(row.matched_memory_id) : null,
    payload: parseJsonSafe(row.payload, {}),
  }));
};

const listEventsByReviewVersion = (db, reviewVersion) => {
  ensureEventStore(db);
  const rows = db.prepare(`
    SELECT
      event_id, timestamp, component, action, reason_codes, memory_id,
      cleanup_version, run_id, review_version, similarity, matched_memory_id, payload
    FROM memory_events
    WHERE review_version = ?
    ORDER BY timestamp ASC, event_id ASC
  `).all(String(reviewVersion || ''));
  return rows.map((row) => ({
    event_id: String(row.event_id),
    timestamp: String(row.timestamp),
    component: String(row.component),
    action: String(row.action),
    reason_codes: parseJsonSafe(row.reason_codes, []),
    memory_id: String(row.memory_id),
    cleanup_version: String(row.cleanup_version || ''),
    run_id: String(row.run_id || ''),
    review_version: String(row.review_version || ''),
    similarity: Number.isFinite(Number(row.similarity)) ? Number(row.similarity) : null,
    matched_memory_id: row.matched_memory_id ? String(row.matched_memory_id) : null,
    payload: parseJsonSafe(row.payload, {}),
  }));
};

export {
  ensureEventStore,
  normalizeReasonCodes,
  buildEvent,
  appendEvent,
  appendEvents,
  listTimeline,
  listEventsByReviewVersion,
};
