import fs from 'node:fs';

import { ensureProjectionStore } from './projection-store.js';

const safeNumber = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);

const getDbPageStats = (db) => {
  const pageCount = safeNumber(db.prepare('PRAGMA page_count').get()?.page_count, 0);
  const freelistCount = safeNumber(db.prepare('PRAGMA freelist_count').get()?.freelist_count, 0);
  const livePages = Math.max(0, pageCount - freelistCount);
  const freePageRatio = pageCount > 0 ? freelistCount / pageCount : 0;
  return {
    page_count: pageCount,
    freelist_count: freelistCount,
    live_pages: livePages,
    free_page_ratio: freePageRatio,
  };
};

const getDbFileStats = (dbPath) => {
  try {
    const stat = fs.statSync(dbPath);
    return {
      bytes: stat.size,
      mb: stat.size / (1024 * 1024),
      mtime: stat.mtime.toISOString(),
    };
  } catch {
    return {
      bytes: 0,
      mb: 0,
      mtime: null,
    };
  }
};

const COUNTBY_ALLOWED_FIELDS = new Set(['status', 'scope', 'type']);
const countBy = (db, field) => {
  if (!COUNTBY_ALLOWED_FIELDS.has(field)) {
    throw new Error(`countBy: invalid field '${field}', allowed: ${[...COUNTBY_ALLOWED_FIELDS].join(', ')}`);
  }
  ensureProjectionStore(db);
  const rows = db.prepare(`
    SELECT ${field} AS label, COUNT(*) AS count
    FROM memory_current
    GROUP BY ${field}
    ORDER BY count DESC
  `).all();
  const out = {};
  for (const row of rows) {
    out[String(row.label || 'unknown')] = safeNumber(row.count);
  }
  return out;
};

const captureSnapshotMetrics = (db, dbPath) => {
  ensureProjectionStore(db);
  const status = countBy(db, 'status');
  const scope = countBy(db, 'scope');
  const type = countBy(db, 'type');
  const page = getDbPageStats(db);
  const file = getDbFileStats(dbPath);
  return {
    totals: {
      active: safeNumber(status.active),
      archived: safeNumber(status.archived),
      rejected: safeNumber(status.rejected),
      superseded: safeNumber(status.superseded),
      all: Object.values(status).reduce((sum, value) => sum + safeNumber(value), 0),
    },
    by_status: status,
    by_scope: scope,
    by_type: type,
    db: {
      file,
      page,
    },
  };
};

const renderUsageLogEntry = ({ timestamp, runId, cleanupVersion, sequence, metrics, events, recallLatency = null }) => {
  const lines = [];
  lines.push(`## ${timestamp} - Gigabrain v3 nightly`);
  lines.push('');
  lines.push(`- run_id: \`${runId}\``);
  lines.push(`- cleanup_version: \`${cleanupVersion}\``);
  lines.push(`- sequence: ${sequence.join(' -> ')}`);
  lines.push(`- totals: active=${metrics.totals.active}, archived=${metrics.totals.archived}, rejected=${metrics.totals.rejected}, superseded=${metrics.totals.superseded}`);
  lines.push(`- db: ${metrics.db.file.mb.toFixed(2)} MB, pages=${metrics.db.page.page_count}, live_pages=${metrics.db.page.live_pages}, free_page_ratio=${(metrics.db.page.free_page_ratio * 100).toFixed(2)}%`);
  if (events && typeof events === 'object') {
    const eventBits = Object.entries(events).map(([key, value]) => `${key}=${safeNumber(value)}`);
    lines.push(`- events: ${eventBits.join(', ')}`);
  }
  if (recallLatency && Number(recallLatency.count || 0) > 0) {
    lines.push(
      `- recall_latency: count=${safeNumber(recallLatency.count)}, `
      + `min=${safeNumber(recallLatency.min)}ms, max=${safeNumber(recallLatency.max)}ms, `
      + `avg=${safeNumber(recallLatency.avg)}ms, p95=${safeNumber(recallLatency.p95)}ms`,
    );
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
};

const RECALL_LATENCY_RING_SIZE = 200;
const recallLatencyRing = [];

const recordRecallLatency = ({ ms, strategy = '', chars = 0, resultCount = 0 }) => {
  recallLatencyRing.push({
    ms: safeNumber(ms),
    strategy: String(strategy || ''),
    chars: safeNumber(chars),
    resultCount: safeNumber(resultCount),
    ts: Date.now(),
  });
  if (recallLatencyRing.length > RECALL_LATENCY_RING_SIZE) {
    recallLatencyRing.splice(0, recallLatencyRing.length - RECALL_LATENCY_RING_SIZE);
  }
};

const getRecallLatencyStats = () => {
  if (recallLatencyRing.length === 0) {
    return { count: 0, min: 0, max: 0, avg: 0, p95: 0 };
  }
  const values = recallLatencyRing.map((entry) => entry.ms);
  values.sort((a, b) => a - b);
  const sum = values.reduce((acc, val) => acc + val, 0);
  const p95Index = Math.min(values.length - 1, Math.floor(values.length * 0.95));
  return {
    count: values.length,
    min: values[0],
    max: values[values.length - 1],
    avg: Math.round(sum / values.length),
    p95: values[p95Index],
  };
};

export {
  safeNumber,
  getDbPageStats,
  getDbFileStats,
  countBy,
  captureSnapshotMetrics,
  renderUsageLogEntry,
  recordRecallLatency,
  getRecallLatencyStats,
};
