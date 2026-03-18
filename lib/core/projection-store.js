import { hashNormalized, normalizeContent } from './policy.js';

const SCOPE_SEGMENT_RE = /^[A-Za-z0-9._-]{1,128}$/;

const normalizeProjectionScope = (value = '', options = {}) => {
  const raw = String(value || '').trim();
  if (!raw) {
    if (options.allowEmpty === true) return '';
    return String(options.fallback || 'shared');
  }
  const lowered = raw.toLowerCase();
  if (lowered === 'default') return 'shared';
  if (lowered === 'shared' || lowered === 'main') return lowered;
  const segments = raw.split(':');
  if (segments.length === 1 && SCOPE_SEGMENT_RE.test(raw)) {
    return raw;
  }
  if (segments.length < 2 || !segments.every((segment) => SCOPE_SEGMENT_RE.test(String(segment || '')))) {
    throw new Error(`Invalid Gigabrain scope: ${raw}`);
  }
  return raw;
};

const escapeLikeValue = (value = '') => String(value || '').replace(/[\\%_]/g, '\\$&');

const hasTable = (db, tableName) => {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(String(tableName || ''));
  return Boolean(row?.name);
};

const ALLOWED_TABLE_NAMES = new Set(['memories', 'memory_current', 'memory_native_chunks', 'memory_events', 'memory_entity_mentions', 'memory_quality_reviews', 'memory_native_sync_state', 'memory_claims']);
const hasColumn = (db, tableName, columnName) => {
  if (!hasTable(db, tableName)) return false;
  if (!ALLOWED_TABLE_NAMES.has(tableName)) {
    throw new Error(`hasColumn: invalid table '${tableName}'`);
  }
  const cols = db.prepare(`PRAGMA table_info(${tableName})`).all();
  return cols.some((col) => String(col?.name || '').toLowerCase() === String(columnName || '').toLowerCase());
};

const ensureColumn = (db, tableName, columnName, definitionSql) => {
  if (hasColumn(db, tableName, columnName)) return;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definitionSql}`);
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
  ensureColumn(db, 'memories', 'source', "TEXT NOT NULL DEFAULT 'capture'");
  ensureColumn(db, 'memories', 'source_agent', 'TEXT');
  ensureColumn(db, 'memories', 'source_session', 'TEXT');
  ensureColumn(db, 'memories', 'confidence', 'REAL DEFAULT 0.6');
  ensureColumn(db, 'memories', 'status', "TEXT NOT NULL DEFAULT 'active'");
  ensureColumn(db, 'memories', 'scope', "TEXT NOT NULL DEFAULT 'shared'");
  ensureColumn(db, 'memories', 'tags', "TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, 'memories', 'created_at', 'TEXT');
  ensureColumn(db, 'memories', 'updated_at', 'TEXT');
  ensureColumn(db, 'memories', 'value_score', 'REAL');
  ensureColumn(db, 'memories', 'value_label', 'TEXT');
  ensureColumn(db, 'memories', 'archived_at', 'TEXT');
  ensureColumn(db, 'memories', 'last_reviewed_at', 'TEXT');
  ensureColumn(db, 'memories', 'superseded_by', 'TEXT');
  ensureColumn(db, 'memories', 'content_time', 'TEXT');
  ensureColumn(db, 'memories', 'valid_until', 'TEXT');
  ensureColumn(db, 'memories', 'source_layer', "TEXT NOT NULL DEFAULT 'registry'");
  ensureColumn(db, 'memories', 'source_path', 'TEXT');
  ensureColumn(db, 'memories', 'source_line', 'INTEGER');
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
  ensureColumn(db, 'memory_current', 'source_layer', "TEXT NOT NULL DEFAULT 'registry'");
  ensureColumn(db, 'memory_current', 'source_path', 'TEXT');
  ensureColumn(db, 'memory_current', 'source_line', 'INTEGER');
  try { ensureFTS5(db); } catch { /* FTS5 optional */ }
};

const FTS5_TABLE = 'memory_fts';

const ensureFTS5 = (db) => {
  const hasFts = hasTable(db, FTS5_TABLE);
  if (!hasFts) {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS5_TABLE} USING fts5(
        memory_id UNINDEXED,
        content,
        normalized,
        type UNINDEXED,
        tokenize = 'unicode61 remove_diacritics 2'
      );
    `);
    db.exec(`
      INSERT INTO ${FTS5_TABLE}(memory_id, content, normalized, type)
      SELECT memory_id, content, COALESCE(normalized, ''), type
      FROM memory_current
      WHERE status = 'active'
    `);
  }
};

const syncFTS5Row = (db, memoryId, content, normalized, type, status) => {
  const existing = db.prepare(`SELECT rowid FROM ${FTS5_TABLE} WHERE memory_id = ?`).get(memoryId);
  if (existing) {
    db.prepare(`DELETE FROM ${FTS5_TABLE} WHERE rowid = ?`).run(existing.rowid);
  }
  if (status === 'active' && content) {
    db.prepare(`INSERT INTO ${FTS5_TABLE}(memory_id, content, normalized, type) VALUES (?, ?, ?, ?)`).run(
      memoryId,
      content,
      normalized || '',
      type || 'CONTEXT',
    );
  }
};

const rebuildFTS5 = (db) => {
  try { db.exec(`DROP TABLE IF EXISTS ${FTS5_TABLE}`); } catch { /* ignore */ }
  ensureFTS5(db);
};

const searchFTS5 = (db, query, options = {}) => {
  const topK = Math.max(1, Math.min(100, Number(options.topK || 20) || 20));
  const tokens = String(query || '').trim().toLowerCase()
    .replace(/[^a-z0-9äöüß\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length >= 2)
    .slice(0, 10);
  if (tokens.length === 0) return [];
  const ftsQuery = tokens.map((token) => `"${token}"*`).join(' OR ');
  try {
    return db.prepare(`
      SELECT memory_id, rank
      FROM ${FTS5_TABLE}
      WHERE ${FTS5_TABLE} MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsQuery, topK);
  } catch {
    return [];
  }
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
    source_layer: memory.source_layer ? String(memory.source_layer) : 'registry',
    source_path: memory.source_path ? String(memory.source_path) : null,
    source_line: Number.isFinite(Number(memory.source_line)) ? Math.max(1, Math.trunc(Number(memory.source_line))) : null,
    confidence: Number.isFinite(Number(memory.confidence)) ? Number(memory.confidence) : 0.6,
    scope: normalizeProjectionScope(memory.scope || 'shared'),
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
      source_layer, source_path, source_line, confidence, scope, status, value_score, value_label,
      created_at, updated_at, archived_at, last_reviewed_at, tags, superseded_by, content_time, valid_until
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(memory_id) DO UPDATE SET
      type = excluded.type,
      content = excluded.content,
      normalized = excluded.normalized,
      normalized_hash = excluded.normalized_hash,
      source = excluded.source,
      source_agent = excluded.source_agent,
      source_session = excluded.source_session,
      source_layer = excluded.source_layer,
      source_path = excluded.source_path,
      source_line = excluded.source_line,
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
    row.source_layer,
    row.source_path,
    row.source_line,
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
        source_layer, source_path, source_line, confidence, status, scope, tags,
        created_at, updated_at, superseded_by, content_time, valid_until, value_score,
        value_label, archived_at, last_reviewed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        type = excluded.type,
        content = excluded.content,
        normalized = excluded.normalized,
        source = excluded.source,
        source_agent = excluded.source_agent,
        source_session = excluded.source_session,
        source_layer = excluded.source_layer,
        source_path = excluded.source_path,
        source_line = excluded.source_line,
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
      row.source_layer,
      row.source_path,
      row.source_line,
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
  try { syncFTS5Row(db, row.memory_id, row.content, row.normalized, row.type, row.status); } catch { /* FTS5 optional */ }
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
        last_reviewed_at = ?,
        superseded_by = COALESCE(?, superseded_by)
      WHERE id = ?
    `);
    legacyStmt.run(
      targetStatus,
      Number.isFinite(Number(extra.value_score)) ? Number(extra.value_score) : null,
      extra.value_label ? String(extra.value_label) : null,
      nowIso,
      archivedAt,
      extra.last_reviewed_at ? toIso(extra.last_reviewed_at) : nowIso,
      extra.superseded_by ? String(extra.superseded_by) : null,
      String(memoryId),
    );
  }
  return run.changes || 0;
};

const getCurrentMemory = (db, memoryId) => {
  ensureProjectionStore(db);
  const hasClaims = hasTable(db, 'memory_claims');
  const row = db.prepare(`
    SELECT
      memory_current.memory_id, memory_current.type, memory_current.content, memory_current.normalized, memory_current.normalized_hash, memory_current.source, memory_current.source_agent, memory_current.source_session,
      memory_current.source_layer, memory_current.source_path, memory_current.source_line, memory_current.confidence, memory_current.scope, memory_current.status, memory_current.value_score, memory_current.value_label,
      memory_current.created_at, memory_current.updated_at, memory_current.archived_at, memory_current.last_reviewed_at, memory_current.tags, memory_current.superseded_by, memory_current.content_time, memory_current.valid_until
      ${hasClaims ? `,
      c.memory_tier,
      c.claim_slot,
      c.consolidation_op,
      c.source_strength,
      c.surface_candidate,
      c.updated_at AS claim_updated_at` : ''}
    FROM memory_current
    ${hasClaims ? 'LEFT JOIN memory_claims c ON c.memory_id = memory_current.memory_id' : ''}
    WHERE memory_current.memory_id = ?
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
  const hasClaims = hasTable(db, 'memory_claims');
  const statuses = Array.isArray(options.statuses) && options.statuses.length > 0
    ? options.statuses.map((item) => canonicalStatus(item))
    : [];
  const scope = normalizeProjectionScope(options.scope || '', { allowEmpty: true });
  const memoryTiers = Array.isArray(options.memoryTiers)
    ? options.memoryTiers.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const limit = Math.max(1, Math.min(10000, Number(options.limit || 1000) || 1000));
  const where = [];
  const params = [];
  if (statuses.length > 0) {
    where.push(`memory_current.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (scope) {
    where.push('memory_current.scope = ?');
    params.push(scope);
  }
  if (hasClaims && memoryTiers.length > 0) {
    where.push(`c.memory_tier IN (${memoryTiers.map(() => '?').join(',')})`);
    params.push(...memoryTiers);
  }
  const sql = `
    SELECT
      memory_current.memory_id, memory_current.type, memory_current.content, memory_current.normalized, memory_current.normalized_hash, memory_current.source, memory_current.source_agent, memory_current.source_session,
      memory_current.source_layer, memory_current.source_path, memory_current.source_line, memory_current.confidence, memory_current.scope, memory_current.status, memory_current.value_score, memory_current.value_label,
      memory_current.created_at, memory_current.updated_at, memory_current.archived_at, memory_current.last_reviewed_at, memory_current.tags, memory_current.superseded_by, memory_current.content_time, memory_current.valid_until
      ${hasClaims ? `,
      c.memory_tier,
      c.claim_slot,
      c.consolidation_op,
      c.source_strength,
      c.surface_candidate,
      c.updated_at AS claim_updated_at` : ''}
    FROM memory_current
    ${hasClaims ? 'LEFT JOIN memory_claims c ON c.memory_id = memory_current.memory_id' : ''}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY memory_current.updated_at DESC
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
  const hasClaims = hasTable(db, 'memory_claims');
  const query = String(options.query || '').trim();
  if (!query) return [];
  const topK = Math.max(1, Math.min(100, Number(options.topK || 8) || 8));
  const scope = normalizeProjectionScope(options.scope || '', { allowEmpty: true });
  const memoryTiers = Array.isArray(options.memoryTiers)
    ? options.memoryTiers.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  const statuses = Array.isArray(options.statuses) && options.statuses.length > 0
    ? options.statuses.map((status) => canonicalStatus(status))
    : ['active'];
  const tokens = normalizeContent(query).split(/\s+/).filter(Boolean).slice(0, 8);
  if (tokens.length === 0) return [];

  const where = [];
  const params = [];
  if (statuses.length > 0) {
    where.push(`memory_current.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (scope) {
    where.push('memory_current.scope = ?');
    params.push(scope);
  }
  if (hasClaims && memoryTiers.length > 0) {
    where.push(`c.memory_tier IN (${memoryTiers.map(() => '?').join(',')})`);
    params.push(...memoryTiers);
  }
  where.push(`(${tokens.map(() => "(memory_current.content LIKE ? ESCAPE '\\' OR memory_current.normalized LIKE ? ESCAPE '\\')").join(' OR ')})`);
  for (const token of tokens) {
    const like = `%${escapeLikeValue(token)}%`;
    params.push(like, like);
  }

  const sql = `
    SELECT
      memory_current.memory_id, memory_current.type, memory_current.content, memory_current.normalized, memory_current.confidence, memory_current.scope, memory_current.status,
      memory_current.value_score, memory_current.value_label, memory_current.created_at, memory_current.updated_at, memory_current.archived_at,
      memory_current.content_time, memory_current.valid_until
      ${hasClaims ? `,
      c.memory_tier,
      c.claim_slot,
      c.consolidation_op,
      c.source_strength,
      c.surface_candidate,
      c.updated_at AS claim_updated_at` : ''}
    FROM memory_current
    ${hasClaims ? 'LEFT JOIN memory_claims c ON c.memory_id = memory_current.memory_id' : ''}
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(memory_current.value_score, memory_current.confidence, 0) DESC, memory_current.updated_at DESC
    LIMIT ?
  `;
  params.push(Math.max(20, topK * 10));
  const rows = db.prepare(sql).all(...params);

  const ftsBoost = new Map();
  try {
    const ftsHits = searchFTS5(db, query, { topK: Math.max(20, topK * 3) });
    for (let index = 0; index < ftsHits.length; index += 1) {
      const bonus = Math.max(0, 1 - (index / Math.max(ftsHits.length, 1))) * 0.25;
      ftsBoost.set(ftsHits[index].memory_id, bonus);
    }
  } catch {
    // FTS5 is optional in some SQLite builds.
  }

  const scored = rows.map((row) => {
    const scoreLexical = lexicalScore(row.content || row.normalized || '', tokens);
    const valueScore = Number.isFinite(Number(row.value_score)) ? Number(row.value_score) : 0;
    const confidence = Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0;
    const fts5Bonus = ftsBoost.get(row.memory_id) || 0;
    const total = (scoreLexical / Math.max(tokens.length, 1)) * 0.5
      + valueScore * 0.25
      + confidence * 0.1
      + fts5Bonus;
    return {
      ...row,
      score_lexical: scoreLexical,
      score_total: total,
    };
  });

  const lexicalIds = new Set(scored.filter((row) => row.score_lexical > 0).map((row) => row.memory_id));
  for (const [memoryId, bonus] of ftsBoost) {
    if (lexicalIds.has(memoryId)) continue;
    try {
      const ftsRow = db.prepare(`
        SELECT
          memory_current.memory_id,
          memory_current.type,
          memory_current.content,
          memory_current.normalized,
          memory_current.confidence,
          memory_current.scope,
          memory_current.status,
          memory_current.value_score,
          memory_current.value_label,
          memory_current.created_at,
          memory_current.updated_at,
          memory_current.archived_at,
          memory_current.content_time,
          memory_current.valid_until
          ${hasClaims ? `,
          c.memory_tier,
          c.claim_slot,
          c.consolidation_op,
          c.source_strength,
          c.surface_candidate,
          c.updated_at AS claim_updated_at` : ''}
        FROM memory_current
        ${hasClaims ? 'LEFT JOIN memory_claims c ON c.memory_id = memory_current.memory_id' : ''}
        WHERE memory_current.memory_id = ?
        LIMIT 1
      `).get(memoryId);
      if (ftsRow) {
        if (statuses.length > 0 && !statuses.includes(canonicalStatus(ftsRow.status))) continue;
        if (scope && String(ftsRow.scope || '').trim() !== scope) continue;
        if (hasClaims && memoryTiers.length > 0 && !memoryTiers.includes(String(ftsRow.memory_tier || '').trim())) continue;
        scored.push({
          ...ftsRow,
          score_lexical: 0,
          score_total: bonus,
        });
      }
    } catch {
      // Ignore malformed FTS rows and keep the lexical results.
    }
  }

  return scored
    .filter((row) => Number(row.score_lexical || 0) > 0 || ftsBoost.has(row.memory_id))
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
      ${col('source_layer', "'registry'")},
      ${col('source_path', 'NULL')},
      ${col('source_line', 'NULL')},
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
        source_layer: row.source_layer,
        source_path: row.source_path,
        source_line: row.source_line,
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
  normalizeProjectionScope,
  upsertCurrentMemory,
  updateCurrentStatus,
  getCurrentMemory,
  listCurrentMemories,
  searchCurrentMemories,
  materializeProjectionFromMemories,
  rebuildFTS5,
  searchFTS5,
  tableStats,
};
