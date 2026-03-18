import fs from 'node:fs';
import path from 'node:path';

const LOCK_RETRY_MS = 25;
const LOCK_TIMEOUT_MS = 4000;
const LOCK_STALE_MS = 30000;

const DEFAULT_RELEVANT_REASONS = Object.freeze([
  'llm_unavailable',
  'remember_intent_missing_note',
  'capture_note_parse_failed',
  'semantic_borderline',
  'capture_missing_note',
  'capture_parse_failed',
  'duplicate_semantic',
  'capture_review_required',
  'memory_action_review',
]);

const clampInt = (value, min, max, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
};

const normalizeStringSet = (value) => {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value
      .map((item) => String(item || '').trim().toLowerCase())
      .filter(Boolean),
  );
};

const normalizeRetentionConfig = (config = {}) => {
  const relevantReasons = normalizeStringSet(config.relevantReasons);
  if (relevantReasons.size === 0) {
    for (const reason of DEFAULT_RELEVANT_REASONS) relevantReasons.add(reason);
  }
  return {
    enabled: config?.enabled !== false,
    keepPendingOnly: config?.keepPendingOnly !== false,
    requireExcerptForPending: config?.requireExcerptForPending !== false,
    maxRows: clampInt(config?.maxRows, 10, 200000, 2000),
    maxPendingRows: clampInt(config?.maxPendingRows, 1, 200000, 600),
    maxNonPendingRows: clampInt(config?.maxNonPendingRows, 0, 200000, 0),
    maxPendingAgeDays: clampInt(config?.maxPendingAgeDays, 1, 3650, 21),
    relevantReasons,
  };
};

const ensureQueueDir = (queuePath) => {
  fs.mkdirSync(path.dirname(queuePath), { recursive: true });
};

const sleepSync = (ms) => {
  const timeoutMs = Math.max(0, Number(ms) || 0);
  if (!timeoutMs) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, timeoutMs);
};

const lockMetadataForPath = (queuePath) => ({
  pid: process.pid,
  acquired_at: new Date().toISOString(),
  queue_path: String(queuePath || ''),
});

const queueLockPath = (queuePath) => `${queuePath}.lock`;

const readLockMetadata = (lockPath) => {
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
};

const isLockStale = (lockPath, staleMs) => {
  try {
    const stat = fs.statSync(lockPath);
    return (Date.now() - Number(stat.mtimeMs || 0)) >= staleMs;
  } catch {
    return true;
  }
};

const tryRemoveStaleLock = (lockPath, staleMs) => {
  if (!isLockStale(lockPath, staleMs)) return false;
  try {
    fs.rmSync(lockPath, { force: true });
    return true;
  } catch {
    return false;
  }
};

const acquireQueueLock = (queuePath, options = {}) => {
  ensureQueueDir(queuePath);
  const lockPath = queueLockPath(queuePath);
  const timeoutMs = Math.max(50, Number(options.timeoutMs || LOCK_TIMEOUT_MS));
  const retryMs = Math.max(5, Number(options.retryMs || LOCK_RETRY_MS));
  const staleMs = Math.max(1000, Number(options.staleMs || LOCK_STALE_MS));
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    try {
      const handle = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(handle, `${JSON.stringify(lockMetadataForPath(queuePath), null, 2)}\n`, 'utf8');
      } finally {
        fs.closeSync(handle);
      }
      return {
        lockPath,
        release: () => {
          try {
            fs.rmSync(lockPath, { force: true });
          } catch {
            // Best-effort cleanup.
          }
        },
      };
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      const removed = tryRemoveStaleLock(lockPath, staleMs);
      if (removed) continue;
      sleepSync(retryMs);
    }
  }

  const existing = readLockMetadata(lockPath);
  const owner = existing?.pid ? ` (held by pid ${existing.pid})` : '';
  throw new Error(`Timed out waiting for Gigabrain review-queue lock${owner} at ${lockPath}`);
};

const withQueueLock = (queuePath, options = {}, fn) => {
  const lock = acquireQueueLock(queuePath, options);
  try {
    return fn();
  } finally {
    lock.release();
  }
};

const parseRows = (raw) => {
  const rows = [];
  let malformed = 0;
  for (const line of String(raw || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row && typeof row === 'object') rows.push(row);
      else malformed += 1;
    } catch {
      malformed += 1;
    }
  }
  return { rows, malformed };
};

const rowTimestampMs = (row, fallback = 0) => {
  const candidates = [
    row?.queued_at,
    row?.created_at,
    row?.updated_at,
    row?.timestamp,
    row?.payload?.timestamp,
  ];
  for (const value of candidates) {
    const ms = Date.parse(String(value || ''));
    if (Number.isFinite(ms)) return ms;
  }
  return fallback;
};

const selectNewest = (list, limit) => {
  if (!Number.isFinite(Number(limit)) || Number(limit) < 0) return [];
  if (list.length <= limit) return list;
  return [...list]
    .sort((a, b) => Number(b.timestampMs || 0) - Number(a.timestampMs || 0) || Number(b.index || 0) - Number(a.index || 0))
    .slice(0, Math.max(0, Number(limit)))
    .sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
};

const isRelevantPending = (entry, config, pendingCutoffMs) => {
  const row = entry?.row || {};
  if (config.maxPendingAgeDays > 0 && Number(entry.timestampMs || 0) < Number(pendingCutoffMs || 0)) return false;

  const reason = String(row.reason || '').trim().toLowerCase();
  const reasonCode = String(row.reason_code || '').trim().toLowerCase();
  if (config.relevantReasons.size > 0) {
    const matchesReason = reason && config.relevantReasons.has(reason);
    const matchesCode = reasonCode && config.relevantReasons.has(reasonCode);
    if (!matchesReason && !matchesCode) return false;
  }

  if (!config.requireExcerptForPending) return true;
  const excerpt = String(row?.payload?.excerpt || '').trim();
  return Boolean(excerpt);
};

const applyQueueRetentionUnlocked = (queuePath, retentionConfig = {}, options = {}) => {
  const config = normalizeRetentionConfig(retentionConfig || {});
  if (!queuePath || config.enabled === false) {
    return {
      applied: false,
      before_rows: 0,
      after_rows: 0,
      dropped_rows: 0,
      dropped_pending_irrelevant: 0,
      dropped_non_pending: 0,
      malformed_rows: 0,
    };
  }

  if (!fs.existsSync(queuePath)) {
    ensureQueueDir(queuePath);
    fs.writeFileSync(queuePath, '', 'utf8');
    return {
      applied: true,
      before_rows: 0,
      after_rows: 0,
      dropped_rows: 0,
      dropped_pending_irrelevant: 0,
      dropped_non_pending: 0,
      malformed_rows: 0,
    };
  }

  const raw = fs.readFileSync(queuePath, 'utf8');
  const parsed = parseRows(raw);
  const beforeRows = parsed.rows.length;
  const pendingCutoffMs = Date.now() - (config.maxPendingAgeDays * 24 * 60 * 60 * 1000);

  const entries = parsed.rows.map((row, index) => ({
    row,
    index,
    status: String(row?.status || '').trim().toLowerCase(),
    timestampMs: rowTimestampMs(row, -1),
  }));

  const pending = [];
  const nonPending = [];
  let droppedPendingIrrelevant = 0;
  let droppedNonPending = 0;

  for (const entry of entries) {
    if (entry.status === 'pending') {
      if (isRelevantPending(entry, config, pendingCutoffMs)) pending.push(entry);
      else droppedPendingIrrelevant += 1;
      continue;
    }
    if (config.keepPendingOnly) {
      droppedNonPending += 1;
      continue;
    }
    nonPending.push(entry);
  }

  const keptPending = selectNewest(pending, config.maxPendingRows);
  const droppedPendingByLimit = Math.max(0, pending.length - keptPending.length);
  const keptNonPending = config.keepPendingOnly ? [] : selectNewest(nonPending, config.maxNonPendingRows);
  const droppedNonPendingByLimit = Math.max(0, nonPending.length - keptNonPending.length);

  let kept = [...keptPending, ...keptNonPending]
    .sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
  if (kept.length > config.maxRows) {
    kept = selectNewest(kept, config.maxRows);
  }

  const serialized = kept.map((entry) => JSON.stringify(entry.row)).join('\n');
  const nextRaw = serialized ? `${serialized}\n` : '';
  const dryRun = options?.dryRun === true;
  if (!dryRun && nextRaw !== raw) {
    ensureQueueDir(queuePath);
    const tempPath = `${queuePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, nextRaw, 'utf8');
    fs.renameSync(tempPath, queuePath);
  }

  const droppedRows = Math.max(0, beforeRows - kept.length);
  return {
    applied: true,
    before_rows: beforeRows,
    after_rows: kept.length,
    dropped_rows: droppedRows,
    dropped_pending_irrelevant: droppedPendingIrrelevant + droppedPendingByLimit,
    dropped_non_pending: droppedNonPending + droppedNonPendingByLimit,
    malformed_rows: parsed.malformed,
  };
};

const applyQueueRetention = (queuePath, retentionConfig = {}, options = {}) => {
  if (options?.skipLock === true) {
    return applyQueueRetentionUnlocked(queuePath, retentionConfig, options);
  }
  return withQueueLock(queuePath, options?.lock || {}, () => applyQueueRetentionUnlocked(queuePath, retentionConfig, options));
};

const appendQueueRow = (queuePath, row, options = {}) => {
  if (!queuePath) {
    return {
      appended: false,
      retention: null,
    };
  }
  return withQueueLock(queuePath, options?.lock || {}, () => {
    ensureQueueDir(queuePath);
    const nowIso = new Date().toISOString();
    const nextRow = {
      ...(row && typeof row === 'object' ? row : {}),
      queued_at: String(row?.queued_at || '').trim()
        || String(row?.created_at || '').trim()
        || String(row?.updated_at || '').trim()
        || nowIso,
    };
    fs.appendFileSync(queuePath, `${JSON.stringify(nextRow)}\n`, 'utf8');
    const retention = options?.applyRetention === false
      ? null
      : applyQueueRetentionUnlocked(queuePath, options?.retentionConfig || {}, {
        dryRun: options?.dryRun === true,
        skipLock: true,
      });
    return {
      appended: true,
      retention,
    };
  });
};

export {
  appendQueueRow,
  applyQueueRetention,
  acquireQueueLock,
};
