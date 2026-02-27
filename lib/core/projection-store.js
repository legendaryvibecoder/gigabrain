import { hashNormalized, normalizeContent } from './policy.js';

const hasTable = (db, tableName) => {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(String(tableName || ''));
  return Boolean(row?.name);
};

const ALLOWED_TABLE_NAMES = new Set(['memories', 'memory_current', 'memory_native_chunks', 'memory_events', 'memory_entity_mentions', 'memory_quality_reviews', 'memory_native_sync_state']);
const hasColumn = (db, tableName, columnName) => {
  if (!hasTable(db, tableName)) return false;
  if (!ALLOWED_TABLE_NAMES.has(tableName)) {
    throw new Error(`hasColumn: invalid table '${tableName}'`);
  }
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return cols.some((col) => String(col?.name || '').toLowerCase() === String(columnName || '').toLowerCase());
};

const ensureLegacyMemoriesTable = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'CONTEXT',
      content TEXT NOT NULL,
      normalized TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'capture',
      source_agent TEXT,
      source_session TEXT,
      source_message_id TEXT,
      confidence REAL DEFAULT 0.6,
      status TEXT NOT NULL DEFAULT 'active',
      scope TEXT NOT NULL DEFAULT 'shared',
      tags TEXT,
      created_at TEXT,
      updated_at TEXT,
      last_injected_at TEXT,
      last_confirmed_at TEXT,
      ttl_days INTEGER,
      pinned INTEGER DEFAULT 0,
      superseded_by TEXT,
      concept TEXT,
      content_time TEXT,
      valid_until TEXT,
      value_score REAL,
      value_label TEXT,
      review_version TEXT,
      review_reason TEXT,
      archived_at TEXT,
      last_reviewed_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memories_status_scope ON memories(status, scope);
    CREATE INDEX IF NOT EXISTS idx_memories_normalized_scope ON memories(normalized, scope);
  `);
};

const ensureProjectionStore = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_current (
      memory_id TEXT PRIMARY KEY,
      type TEXT NOT NULL DEFAULT 'CONTEXT',
      content TEXT NOT NULL,
      normalized TEXT NOT NULL DEFAULT '',
      normalized_hash TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'capture',
      source_agent TEXT,
      source_session TEXT,
      confidence REAL DEFAULT 0.6,
      scope TEXT NOT NULL DEFAULT 'shared',
      status TEXT NOT NULL DEFAULT 'active',
      value_score REAL,
      value_label TEXT,
      created_at TEXT,
      updated_at TEXT,
      archived_at TEXT,
      last_reviewed_at TEXT,
      tags TEXT,
      superseded_by TEXT,
      content_time TEXT,
      valid_until TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memory_current_status_scope ON memory_current(status, scope);
    CREATE INDEX IF NOT EXISTS idx_memory_current_norm_scope ON memory_current(normalized_hash, scope, status);
  `);
  ensureLegacyMemoriesTable(db);
};

const toIso = (value, fallback = new Date().toISOString()) => {
  if (!value) return fallback;
  const text = String(value);
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return fallback;
  return new Date(parsed).toISOString();
};

const canonicalStatus = (status) => {
  const key = String(status || '').trim().toLowerCase();
  if (['active', 'archived', 'rejected', 'superseded'].includes(key)) return key;
  return 'active';
};

const upsertCurrentMemory = (db, memory = {}, options = {}) => {
  ensureProjectionStore(db);
  const nowIso = new Date().toISOString();
  const memoryId = String(memory.memory_id || memory.id || '').trim();
  if (!memoryId) throw new Error('memory_id is required');
  const content = String(memory.content || '').trim();
  if (!content) throw new Error(`memory_id=${memoryId} content is required`);
  const normalized = String(memory.normalized || normalizeContent(content)).trim();
  const normalizedHash = hashNormalized(normalized);
  const row = {
    memory_id: memoryId,
    type: String(memory.type || 'CONTEXT').trim().toUpperCase() || 'CONTEXT',
    content,
    normalized,
    normalized_hash: normalizedHash,
    source: String(memory.source || 'capture'),
    source_agent: memory.source_agent ? String(memory.source_agent) : null,
    source_session: memory.source_session ? String(memory.source_session) : null,
    confidence: Number.isFinite(Number(memory.confidence)) ? Number(memory.confidence) : 0.6,
    scope: String(memory.scope || 'shared').trim() || 'shared',
    status: canonicalStatus(memory.status || 'active'),
    value_score: Number.isFinite(Number(memory.value_score)) ? Number(memory.value_score) : null,
    value_label: memory.value_label ? String(memory.value_label) : null,
    created_at: toIso(memory.created_at, nowIso),
    updated_at: toIso(memory.updated_at, nowIso),
    archived_at: memory.archived_at ? toIso(memory.archived_at, nowIso) : null,
    last_reviewed_at: memory.last_reviewed_at ? toIso(memory.last_reviewed_at, nowIso) : null,
    tags: Array.isArray(memory.tags) ? JSON.stringify(memory.tags) : (memory.tags ? String(memory.tags) : '[]'),
    superseded_by: memory.superseded_by ? String(memory.superseded_by) : null,
    content_time: memory.content_time ? String(memory.content_time) : null,
    valid_until: memory.valid_until ? String(memory.valid_until) : null,
  };

  const stmt = db.prepare(`
    INSERT INTO memory_current (
      memory_id, type, content, normalized, normalized_hash, source, source_agent, source_session,
      confidence, scope, status, value_score, value_label, created_at, updated_at, archived_at,
      last_reviewed_at, tags, superseded_by, content_time, valid_until
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(memory_id) DO UPDATE SET
      type = excluded.type,
      content = excluded.content,
      normalized = excluded.normalized,
      normalized_hash = excluded.normalized_hash,
      source = excluded.source,
      source_agent = excluded.source_agent,
      source_session = excluded.source_session,
      confidence = excluded.confidence,
      scope = excluded.scope,
      status = excluded.status,
      value_score = excluded.value_score,
      value_label = excluded.value_label,
      updated_at = excluded.updated_at,
      archived_at = excluded.archived_at,
      last_reviewed_at = excluded.last_reviewed_at,
      tags = excluded.tags,
      superseded_by = excluded.superseded_by,
      content_time = excluded.content_time,
      valid_until = excluded.valid_until
  `);
  stmt.run(
    row.memory_id,
    row.type,
    row.content,
    row.normalized,
    row.normalized_hash,
    row.source,
    row.source_agent,
    row.source_session,
    row.confidence,
    row.scope,
    row.status,
    row.value_score,
    row.value_label,
    row.created_at,
    row.updated_at,
    row.archived_at,
    row.last_reviewed_at,
    row.tags,
    row.superseded_by,
    row.content_time,
    row.valid_until,
  );

  if (options.syncLegacy !== false) {
    const legacyStmt = db.prepare(`
      INSERT INTO memories (
        id, type, content, normalized, source, source_agent, source_session,
        confidence, status, scope, tags, created_at, updated_at, superseded_by,
        content_time, valid_until, value_score, value_label, archived_at, last_reviewed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        content = excluded.content,
        normalized = excluded.normalized,
        source = excluded.source,
        source_agent = excluded.source_agent,
        source_session = excluded.source_session,
        confidence = excluded.confidence,
        status = excluded.status,
        scope = excluded.scope,
        tags = excluded.tags,
        updated_at = excluded.updated_at,
        superseded_by = excluded.superseded_by,
        content_time = excluded.content_time,
        valid_until = excluded.valid_until,
        value_score = excluded.value_score,
        value_label = excluded.value_label,
        archived_at = excluded.archived_at,
        last_reviewed_at = excluded.last_reviewed_at
    `);
    legacyStmt.run(
      row.memory_id,
      row.type,
      row.content,
      row.normalized,
      row.source,
      row.source_agent,
      row.source_session,
      row.confidence,
      row.status,
      row.scope,
      row.tags,
      row.created_at,
      row.updated_at,
      row.superseded_by,
      row.content_time,
      row.valid_until,
      row.value_score,
      row.value_label,
      row.archived_at,
      row.last_reviewed_at,
    );
  }
  return row;
};

const updateCurrentStatus = (db, memoryId, status, extra = {}, options = {}) => {
  ensureProjectionStore(db);
  const targetStatus = canonicalStatus(status);
  const nowIso = toIso(extra.timestamp || new Date().toISOString());
  const archivedAt = targetStatus === 'archived'
    ? toIso(extra.archived_at || nowIso)
    : null;
  const stmt = db.prepare(`
    UPDATE memory_current
    SET
      status = ?,
      value_score = ?,
      value_label = ?,
      updated_at = ?,
      archived_at = ?,
      last_reviewed_at = ?,
      superseded_by = COALESCE(?, superseded_by)
    WHERE memory_id = ?
  `);
  const run = stmt.run(
    targetStatus,
    Number.isFinite(Number(extra.value_score)) ? Number(extra.value_score) : null,
    extra.value_label ? String(extra.value_label) : null,
    nowIso,
    archivedAt,
    extra.last_reviewed_at ? toIso(extra.last_reviewed_at) : nowIso,
    extra.superseded_by ? String(extra.superseded_by) : null,
    String(memoryId),
  );

  if (options.syncLegacy !== false) {
    const legacyStmt = db.prepare(`
      UPDATE memories
      SET
        status = ?,
        value_score = ?,
        value_label = ?,
        updated_at = ?,
        archived_at = ?,
        last_reviewed_at = ?
      WHERE id = ?
    `);
    legacyStmt.run(
      targetStatus,
      Number.isFinite(Number(extra.value_score)) ? Number(extra.value_score) : null,
      extra.value_label ? String(extra.value_label) : null,
      nowIso,
      archivedAt,
      extra.last_reviewed_at ? toIso(extra.last_reviewed_at) : nowIso,
      String(memoryId),
    );
  }
  return run.changes || 0;
};

const getCurrentMemory = (db, memoryId) => {
  ensureProjectionStore(db);
  const row = db.prepare(`
    SELECT
      memory_id, type, content, normalized, normalized_hash, source, source_agent, source_session,
      confidence, scope, status, value_score, value_label, created_at, updated_at, archived_at,
      last_reviewed_at, tags, superseded_by, content_time, valid_until
    FROM memory_current
    WHERE memory_id = ?
    LIMIT 1
  `).get(String(memoryId || ''));
  if (!row) return null;
  return {
    ...row,
    confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0.6,
    value_score: Number.isFinite(Number(row.value_score)) ? Number(row.value_score) : null,
    tags: (() => {
      try { return JSON.parse(String(row.tags || '[]')); } catch { return []; }
    })(),
  };
};

const listCurrentMemories = (db, options = {}) => {
  ensureProjectionStore(db);
  const statuses = Array.isArray(options.statuses) && options.statuses.length > 0
    ? options.statuses.map((item) => canonicalStatus(item))
    : [];
  const scope = String(options.scope || '').trim();
  const limit = Math.max(1, Math.min(10000, Number(options.limit || 1000) || 1000));
  const where = [];
  const params = [];
  if (statuses.length > 0) {
    where.push(`status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (scope) {
    where.push('scope = ?');
    params.push(scope);
  }
  const sql = `
    SELECT
      memory_id, type, content, normalized, normalized_hash, source, source_agent, source_session,
      confidence, scope, status, value_score, value_label, created_at, updated_at, archived_at,
      last_reviewed_at, tags, superseded_by, content_time, valid_until
    FROM memory_current
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY updated_at DESC
    LIMIT ?
  `;
  params.push(limit);
  return db.prepare(sql).all(...params);
};

const lexicalScore = (text, tokens) => {
  const normalized = normalizeContent(text);
  const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const hasToken = (token) => {
    if (!token) return false;
    const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegex(token)}([^\\p{L}\\p{N}_]|$)`, 'iu');
    return re.test(normalized);
  };
  let score = 0;
  for (const token of tokens) {
    if (!token) continue;
    if (hasToken(token)) score += 1;
  }
  return score;
};

const searchCurrentMemories = (db, options = {}) => {
  ensureProjectionStore(db);
  const query = String(options.query || '').trim();
  if (!query) return [];
  const topK = Math.max(1, Math.min(100, Number(options.topK || 8) || 8));
  const scope = String(options.scope || '').trim();
  const statuses = Array.isArray(options.statuses) && options.statuses.length > 0
    ? options.statuses.map((status) => canonicalStatus(status))
    : ['active'];
  const tokens = normalizeContent(query).split(/\s+/).filter(Boolean).slice(0, 8);
  if (tokens.length === 0) return [];

  const where = [];
  const params = [];
  if (statuses.length > 0) {
    where.push(`status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (scope) {
    where.push('scope = ?');
    params.push(scope);
  }
  where.push(`(${tokens.map(() => '(content LIKE ? OR normalized LIKE ?)').join(' OR ')})`);
  for (const token of tokens) {
    const like = `%${token}%`;
    params.push(like, like);
  }

  const sql = `
    SELECT
      memory_id, type, content, normalized, confidence, scope, status,
      value_score, value_label, created_at, updated_at, archived_at
    FROM memory_current
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(value_score, confidence, 0) DESC, updated_at DESC
    LIMIT ?
  `;
  params.push(Math.max(20, topK * 10));
  const rows = db.prepare(sql).all(...params);
  return rows
    .map((row) => {
      const scoreLexical = lexicalScore(row.content || row.normalized || '', tokens);
      const valueScore = Number.isFinite(Number(row.value_score)) ? Number(row.value_score) : 0;
      const confidence = Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0;
      const total = (scoreLexical / Math.max(tokens.length, 1)) * 0.6 + valueScore * 0.3 + confidence * 0.1;
      return {
        ...row,
        score_lexical: scoreLexical,
        score_total: total,
      };
    })
    .filter((row) => Number(row.score_lexical || 0) > 0)
    .sort((a, b) => Number(b.score_total || 0) - Number(a.score_total || 0))
    .slice(0, topK);
};

const materializeProjectionFromMemories = (db) => {
  ensureProjectionStore(db);
  if (!hasTable(db, 'memories')) return { imported: 0 };

  const columns = new Set(db.prepare('PRAGMA table_info(memories)').all().map((col) => String(col.name || '').toLowerCase()));
  const col = (name, fallbackSql) => (columns.has(name) ? name : `${fallbackSql} AS ${name}`);
  const rows = db.prepare(`
    SELECT
      ${col('id', "''")},
      ${col('type', "'CONTEXT'")},
      ${col('content', "''")},
      ${col('normalized', "LOWER(TRIM(content))")},
      ${col('source', "'capture'")},
      ${col('source_agent', "''")},
      ${col('source_session', "''")},
      ${col('confidence', '0.6')},
      ${col('scope', "'shared'")},
      ${col('status', "'active'")},
      ${col('value_score', 'NULL')},
      ${col('value_label', 'NULL')},
      ${col('created_at', 'NULL')},
      ${col('updated_at', 'NULL')},
      ${col('archived_at', 'NULL')},
      ${col('last_reviewed_at', 'NULL')},
      ${col('tags', "'[]'")},
      ${col('superseded_by', 'NULL')},
      ${col('content_time', 'NULL')},
      ${col('valid_until', 'NULL')}
    FROM memories
    ORDER BY ${columns.has('updated_at') ? 'updated_at' : columns.has('created_at') ? 'created_at' : 'id'} ASC
  `).all();

  let imported = 0;
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      upsertCurrentMemory(db, {
        memory_id: row.id,
        type: row.type,
        content: row.content,
        normalized: row.normalized,
        source: row.source,
        source_agent: row.source_agent,
        source_session: row.source_session,
        confidence: row.confidence,
        scope: row.scope,
        status: row.status,
        value_score: row.value_score,
        value_label: row.value_label,
        created_at: row.created_at,
        updated_at: row.updated_at,
        archived_at: row.archived_at,
        last_reviewed_at: row.last_reviewed_at,
        tags: row.tags,
        superseded_by: row.superseded_by,
        content_time: row.content_time,
        valid_until: row.valid_until,
      }, { syncLegacy: false });
      imported += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { imported };
};

const tableStats = (db) => {
  ensureProjectionStore(db);
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count
    FROM memory_current
    GROUP BY status
  `).all();
  const status = {};
  for (const row of rows) {
    status[String(row.status || 'unknown')] = Number(row.count || 0);
  }
  return {
    status,
    total: Object.values(status).reduce((sum, value) => sum + Number(value || 0), 0),
  };
};

export {
  hasTable,
  hasColumn,
  ensureLegacyMemoriesTable,
  ensureProjectionStore,
  upsertCurrentMemory,
  updateCurrentStatus,
  getCurrentMemory,
  listCurrentMemories,
  searchCurrentMemories,
  materializeProjectionFromMemories,
  tableStats,
};
