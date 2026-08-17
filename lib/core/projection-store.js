import { hashNormalized, normalizeContent } from './policy.js';
import { appendEvent } from './event-store.js';

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

// Scope visibility (U14-opt fix #4): 'shared' rows are by definition
// cross-visible, so ANY non-'shared' requested scope (project:X, profile:Y,
// or a BARE agent scope like 'main') sees its own rows PLUS shared.
// Previously bare agent scopes fell through the project:/profile: prefix
// pattern-match and saw ONLY their own rows — agent=main could not retrieve
// shared rows. Requesting 'shared' stays STRICT (shared rows only): the old
// dense leg's shared-sees-everything WAS the scope leak; do not reintroduce it.
const scopeWhereForRequested = (scope, options = {}) => {
  const requested = String(scope || '').trim();
  if (!requested) return { sql: '', params: [] };
  if (requested === 'shared') return { sql: 'memory_current.scope = ?', params: ['shared'] };
  const includeShared = options.includeShared !== false;
  // Recall read-paths opt into profile visibility: on a single-user machine,
  // personal (profile:*) memories must be findable from any project. Cross-project
  // isolation is preserved: other projects' project:* rows stay excluded. Governance-grade
  // surfaces (exports, beliefs-as-of) keep exact scoping by not opting in.
  if (options.includeProfile === true && requested.startsWith('project:')) {
    const clauses = ['memory_current.scope = ?'];
    if (includeShared) clauses.push("memory_current.scope = 'shared'");
    clauses.push("memory_current.scope LIKE 'profile:%'");
    return {
      sql: `(${clauses.join(' OR ')})`,
      params: [requested],
    };
  }
  if (!includeShared) return { sql: 'memory_current.scope = ?', params: [requested] };
  return { sql: "(memory_current.scope = ? OR memory_current.scope = 'shared')", params: [requested] };
};

const rowVisibleForRequestedScope = (rowScope = '', requestedScope = '', options = {}) => {
  const requested = String(requestedScope || '').trim();
  if (!requested) return true;
  const actual = String(rowScope || '').trim();
  if (requested === 'shared') return actual === 'shared';
  if (options.includeProfile === true && requested.startsWith('project:') && actual.startsWith('profile:')) {
    return true;
  }
  return actual === requested || (options.includeShared !== false && actual === 'shared');
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

const ALLOWED_TABLE_NAMES = new Set(['memories', 'memory_current', 'memory_native_chunks', 'memory_events', 'memory_entity_mentions', 'memory_quality_reviews', 'memory_native_sync_state', 'memory_claims', 'memory_source_links', 'memory_host_sync_runs']);
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

// U18: the legacy `memories` table is deprecated (U9) and slated for a
// containment-gated physical drop. ensureLegacyMemoriesTable historically ran
// unconditionally in projection setup, which re-materialized the table on EVERY
// fresh install — defeating the drop and leaving every new DB carrying a dead
// table. The CREATE is now gated: it only fires when the table ALREADY exists
// (so existing/upgraded DBs keep their schema migrated, fully backward
// compatible) OR when an explicit opt-in (config.migration?.keepLegacyTable) is
// supplied (back-compat dual-write path / tooling that still wants it). When
// neither holds — the fresh-install case — this is a no-op and no `memories`
// table is materialized. Callers that genuinely need the table (the opt-in
// dual-write in upsertCurrentMemory, the deprecation test) pass
// { force: true }. The column-backfill loop runs only after a CREATE, so it
// never touches a DB that has no legacy table.
const ensureLegacyMemoriesTable = (db, options = {}) => {
  const force = options.force === true || options.keepLegacyTable === true;
  const alreadyPresent = hasTable(db, 'memories');
  if (!force && !alreadyPresent) {
    // Fresh install with no opt-in: do not materialize the deprecated table.
    return false;
  }
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
  ensureColumn(db, 'memories', 'source_host', "TEXT NOT NULL DEFAULT 'gigabrain'");
  ensureColumn(db, 'memories', 'source_kind', "TEXT NOT NULL DEFAULT 'registry'");
  ensureColumn(db, 'memories', 'sync_policy', "TEXT NOT NULL DEFAULT 'read_only'");
  return true;
};

const ensureProjectionStore = (db, options = {}) => {
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
      valid_until TEXT,
      valid_from TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memory_current_status_scope ON memory_current(status, scope);
    CREATE INDEX IF NOT EXISTS idx_memory_current_norm_scope ON memory_current(normalized_hash, scope, status);
  `);
  // U18: gated — only ensures/migrates the deprecated `memories` table when it
  // already exists (upgraded DBs) or the migration opt-in is set. Fresh installs
  // no longer auto-materialize it (so the containment-gated drop stays dropped).
  ensureLegacyMemoriesTable(db, { keepLegacyTable: options.keepLegacyTable === true || options.migration?.keepLegacyTable === true });
  ensureColumn(db, 'memory_current', 'source_layer', "TEXT NOT NULL DEFAULT 'registry'");
  ensureColumn(db, 'memory_current', 'source_path', 'TEXT');
  ensureColumn(db, 'memory_current', 'source_line', 'INTEGER');
  ensureColumn(db, 'memory_current', 'source_host', "TEXT NOT NULL DEFAULT 'gigabrain'");
  ensureColumn(db, 'memory_current', 'source_kind', "TEXT NOT NULL DEFAULT 'registry'");
  ensureColumn(db, 'memory_current', 'sync_policy', "TEXT NOT NULL DEFAULT 'read_only'");
  // U12 bi-temporal: valid_from opens the EVENT-time interval that valid_until
  // closes ("when was this true in the world"), while created_at + the
  // verdict/supersede events carry TRANSACTION time ("when did the store learn
  // it"). One-time migration: when the column is first added on a pre-U12 DB,
  // backfill valid_from = created_at (fallback updated_at, then now) inside a
  // savepoint so the ALTER + backfill land atomically and every existing row
  // gets a non-NULL event-time start. New writes derive it in
  // upsertCurrentMemory; idempotent because hasColumn gates the whole block.
  if (!hasColumn(db, 'memory_current', 'valid_from')) {
    db.exec('SAVEPOINT gb_u12_valid_from');
    try {
      try {
        db.exec('ALTER TABLE memory_current ADD COLUMN valid_from TEXT');
      } catch (alterErr) {
        // Concurrent double-open (MCP server + CLI): both pass the hasColumn
        // gate, the loser's ALTER hits "duplicate column name" — the column
        // existing IS success; the backfill below still runs. (A re-check
        // inside the savepoint would NOT close this window: SAVEPOINT takes
        // no write lock until its first write, which is the ALTER itself.)
        if (!/duplicate column name/i.test(String(alterErr?.message || ''))) throw alterErr;
      }
      db.prepare(`
        UPDATE memory_current
        SET valid_from = COALESCE(created_at, updated_at, ?)
        WHERE valid_from IS NULL
      `).run(new Date().toISOString());
      db.exec('RELEASE gb_u12_valid_from');
    } catch (err) {
      try { db.exec('ROLLBACK TO gb_u12_valid_from'); db.exec('RELEASE gb_u12_valid_from'); } catch { /* savepoint already gone */ }
      throw err;
    }
  }
  // NOTE (review #8, rejected on apply): an at-open self-heal stamping NULL
  // valid_from was tried and reverted — the savepoint already makes
  // ALTER+backfill atomic (no crash window), and stamping changes NULL's
  // observable recall semantics ("no event-time claim") for rows inserted
  // outside upsertCurrentMemory. The remaining downgrade path (pre-U12 binary
  // writing post-migration) is covered by COALESCE at the read boundaries.
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

// EN+DE stopwords stripped at QUERY time only (never at index time, so bm25 IDF
// stays intact). Without this, common words like "was/ist/das/the/is" match nearly
// every row and let an irrelevant high-value row outrank the exact phrase match.
const FTS_STOPWORDS = new Set([
  'wer', 'ist', 'war', 'was', 'wie', 'wo', 'wann', 'warum', 'wieso', 'ueber', 'über',
  'und', 'oder', 'der', 'die', 'das', 'ein', 'eine', 'einer', 'einem', 'einen', 'den',
  'dem', 'des', 'mit', 'von', 'zu', 'im', 'in', 'am', 'an', 'auf', 'gibt', 'gibts',
  'about', 'tell', 'me', 'who', 'is', 'the', 'a', 'an', 'and', 'or', 'to', 'for',
  'please', 'bitte', 'what', 'how', 'when', 'where', 'why', 'of', 'on', 'do', 'does',
]);

// U14 (R11): \p{L}\p{N} property classes instead of [a-z0-9äöüß] — the old
// class silently DELETED every non-Latin letter, so Cyrillic/CJK/Greek queries
// tokenized to nothing and the FTS5 leg returned zero rows. The index side
// (unicode61 remove_diacritics 2) always handled full Unicode; only the query
// tokenizer was lossy. Strictly additive for ASCII+German queries: \p{L} is a
// superset of [a-zäöüß], punctuation/underscore still map to whitespace.
const tokenizeFtsQuery = (query) => String(query || '').trim().toLowerCase()
  .replace(/[^\p{L}\p{N}\s]/gu, ' ')
  .split(/\s+/)
  .filter((token) => token.length >= 2)
  .slice(0, 12);

// Build an FTS5 MATCH expression with implicit-AND (space-joined), prefix only on
// the LAST content token, and each token quote-sanitized so FTS5 operators can't
// leak. Returns '' if nothing usable remains.
const buildFtsMatch = (tokens) => {
  if (!tokens.length) return '';
  return tokens.map((t, i) => {
    const safe = `"${String(t).replace(/"/g, '""')}"`;
    return i === tokens.length - 1 ? `${safe}*` : safe;
  }).join(' ');
};

const searchFTS5 = (db, query, options = {}) => {
  const topK = Math.max(1, Math.min(100, Number(options.topK || 20) || 20));
  const allTokens = tokenizeFtsQuery(query);
  if (allTokens.length === 0) return [];
  // Drop stopwords; if everything was a stopword, fall back to the raw tokens so
  // a pure-stopword query still returns something.
  const content = allTokens.filter((t) => !FTS_STOPWORDS.has(t));
  let working = content.length > 0 ? content : allTokens;

  const runMatch = (tokens) => {
    const expr = buildFtsMatch(tokens);
    if (!expr) return null;
    try {
      const hits = db.prepare(`
        SELECT memory_id, rank, -bm25(${FTS5_TABLE}) AS bm25_score
        FROM ${FTS5_TABLE}
        WHERE ${FTS5_TABLE} MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(expr, topK);
      return hits;
    } catch {
      return null;
    }
  };

  // Implicit-AND relaxation ladder: AND of all content tokens is strict and may
  // return nothing on short multilingual queries. If empty, drop the last token
  // and retry, down to a single token — so AND never collapses to zero results.
  try {
    while (working.length > 0) {
      const hits = runMatch(working);
      if (hits && hits.length > 0) return hits;
      if (working.length === 1) break;
      working = working.slice(0, -1);
    }
    return [];
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
  if (!content) throw new Error('content is required');
  const normalized = String(memory.normalized || normalizeContent(content)).trim();
  const normalizedHash = hashNormalized(normalized);
  const createdAtIso = toIso(memory.created_at, nowIso);
  // U13(c) clock defense: content_time is an ASSERTED event time and a clock-
  // gaming vector — a future-dated stamp (2099) would win arbiter recency and,
  // via U12, open a future valid_from. Clamp to min(asserted, ingest) at the
  // write, BEFORE valid_from derivation; past stamps pass through verbatim.
  let contentTime = memory.content_time ? String(memory.content_time) : null;
  if (contentTime) {
    const assertedMs = Date.parse(contentTime);
    if (Number.isFinite(assertedMs) && assertedMs > Date.parse(nowIso)) contentTime = nowIso;
  }
  // U12 valid_from precedence: explicit valid_from > extraction-time
  // content_time > the row's existing valid_from (so a partial re-upsert never
  // regresses a verdict-stamped or content_time-derived start) > created_at.
  // Always normalized to full ISO so the lexicographic interval comparison in
  // listBeliefsAsOf is sound; never NULL by construction.
  // U14b (#22): the "existing valid_from" leg of the precedence lives in the
  // upsert SQL itself — the conflict arm computes
  // COALESCE(incoming, valid_from, excluded.valid_from) where `incoming` is
  // NULL unless an explicit/content_time start was supplied — instead of a
  // per-call prefetch SELECT (an N+1 on the bulk host-sync path). RETURNING
  // keeps the returned row's valid_from truthful without re-reading.
  const explicitValidFrom = memory.valid_from || contentTime || null;
  const incomingValidFrom = explicitValidFrom ? toIso(explicitValidFrom, createdAtIso) : null;
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
    source_line: (memory.source_line === null || memory.source_line === undefined || memory.source_line === '')
      ? null
      : (Number.isFinite(Number(memory.source_line)) ? Math.max(1, Math.trunc(Number(memory.source_line))) : null),
    source_host: memory.source_host ? String(memory.source_host) : 'gigabrain',
    source_kind: memory.source_kind ? String(memory.source_kind) : 'registry',
    sync_policy: memory.sync_policy ? String(memory.sync_policy) : 'read_only',
    confidence: Number.isFinite(Number(memory.confidence)) ? Number(memory.confidence) : 0.6,
    scope: normalizeProjectionScope(memory.scope || 'shared'),
    status: canonicalStatus(memory.status || 'active'),
    value_score: (memory.value_score === null || memory.value_score === undefined || memory.value_score === '')
      ? null
      : (Number.isFinite(Number(memory.value_score)) ? Number(memory.value_score) : null),
    value_label: memory.value_label ? String(memory.value_label) : null,
    created_at: createdAtIso,
    updated_at: toIso(memory.updated_at, nowIso),
    archived_at: memory.archived_at ? toIso(memory.archived_at, nowIso) : null,
    last_reviewed_at: memory.last_reviewed_at ? toIso(memory.last_reviewed_at, nowIso) : null,
    tags: Array.isArray(memory.tags) ? JSON.stringify(memory.tags) : (memory.tags ? String(memory.tags) : '[]'),
    superseded_by: memory.superseded_by ? String(memory.superseded_by) : null,
    content_time: contentTime,
    valid_until: memory.valid_until ? String(memory.valid_until) : null,
    valid_from: incomingValidFrom || createdAtIso,
  };

  const stmt = db.prepare(`
    INSERT INTO memory_current (
      memory_id, type, content, normalized, normalized_hash, source, source_agent, source_session,
      source_layer, source_path, source_line, source_host, source_kind, sync_policy, confidence, scope, status, value_score, value_label,
      created_at, updated_at, archived_at, last_reviewed_at, tags, superseded_by, content_time, valid_until, valid_from
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      source_host = excluded.source_host,
      source_kind = excluded.source_kind,
      sync_policy = excluded.sync_policy,
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
      valid_until = excluded.valid_until,
      valid_from = COALESCE(?, valid_from, excluded.valid_from)
    RETURNING valid_from
  `);
  const persisted = stmt.get(
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
    row.source_host,
    row.source_kind,
    row.sync_policy,
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
    row.valid_from,
    incomingValidFrom,
  );
  row.valid_from = persisted?.valid_from ?? row.valid_from;

  // U9: memory_current is the sole mutable store. The legacy `memories`
  // dual-write is OFF by default (opt in with { syncLegacy: true } for
  // back-compat only). Nothing in the engine reads `memories` during normal
  // operation — the only reader is the one-time reverse-migration backfill
  // (materializeProjectionFromMemories), which fires solely when memory_current
  // is empty — so skipping this write is read-neutral. The table is left in
  // place (not dropped) so the change is reversible; the physical drop is
  // deferred until a verified parity snapshot is available.
  if (options.syncLegacy === true) {
    // U18: ensureProjectionStore no longer auto-creates the deprecated table on
    // fresh installs, so the opt-in dual-write must force its presence here.
    ensureLegacyMemoriesTable(db, { force: true });
    const legacyStmt = db.prepare(`
      INSERT INTO memories (
        id, type, content, normalized, source, source_agent, source_session,
        source_layer, source_path, source_line, source_host, source_kind, sync_policy, confidence, status, scope, tags,
        created_at, updated_at, superseded_by, content_time, valid_until, value_score,
        value_label, archived_at, last_reviewed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        source_host = excluded.source_host,
        source_kind = excluded.source_kind,
        sync_policy = excluded.sync_policy,
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
      row.source_host,
      row.source_kind,
      row.sync_policy,
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
  // COALESCE keeps an existing superseded_by unless a new one is supplied, so a
  // plain NULL can never clear it; reinstatement (R2) passes
  // `extra.clear_superseded_by: true` to NULL it explicitly.
  const clearSupersededBy = extra.clear_superseded_by === true ? 1 : 0;
  // Reinstatement must also reopen valid time: a capture-CONTRADICT loser gets
  // valid_until=now at supersession, and isLiveRecallRow hard-filters expired
  // rows — without clearing it a flipped winner comes back active but
  // permanently recall-dead.
  const clearValidUntil = extra.clear_valid_until === true ? 1 : 0;
  // Status-preserving reviews (audit KEEP) must not rewrite updated_at: the
  // nightly audit touches every row, and a wholesale bump collapses the whole
  // store onto one timestamp, destroying recency for recent/recall ranking.
  const preserveUpdatedAt = extra.preserve_updated_at === true ? 1 : 0;
  const stmt = db.prepare(`
    UPDATE memory_current
    SET
      status = ?,
      value_score = COALESCE(?, value_score),
      value_label = COALESCE(?, value_label),
      updated_at = CASE WHEN ? = 1 THEN updated_at ELSE ? END,
      archived_at = ?,
      last_reviewed_at = ?,
      superseded_by = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, superseded_by) END,
      valid_until = CASE WHEN ? = 1 THEN NULL ELSE valid_until END
    WHERE memory_id = ?
  `);
  const run = stmt.run(
    targetStatus,
    Number.isFinite(Number(extra.value_score)) ? Number(extra.value_score) : null,
    extra.value_label ? String(extra.value_label) : null,
    preserveUpdatedAt,
    nowIso,
    archivedAt,
    extra.last_reviewed_at ? toIso(extra.last_reviewed_at) : nowIso,
    clearSupersededBy,
    extra.superseded_by ? String(extra.superseded_by) : null,
    clearValidUntil,
    String(memoryId),
  );

  // U14b (#23): keep the FTS index fresh on status flips. Supersession/
  // archive/reject removes the row from memory_fts immediately — dead rows
  // otherwise linger until the nightly rebuild, consuming topK slots and
  // skewing bm25 — and reinstatement re-adds it. Same FTS5-optional guard as
  // the upsert path.
  if (run.changes > 0) {
    try {
      const ftsSource = db.prepare(
        'SELECT content, normalized, type, status FROM memory_current WHERE memory_id = ?',
      ).get(String(memoryId));
      if (ftsSource) {
        syncFTS5Row(db, String(memoryId), ftsSource.content, ftsSource.normalized, ftsSource.type, ftsSource.status);
      }
    } catch { /* FTS5 optional */ }
  }

  // U9: legacy dual-write OFF by default (opt in with { syncLegacy: true }).
  if (options.syncLegacy === true) {
    // U18: force the deprecated table's presence for the opt-in dual-write
    // (fresh installs no longer auto-create it).
    ensureLegacyMemoriesTable(db, { force: true });
    const legacyStmt = db.prepare(`
      UPDATE memories
      SET
        status = ?,
        value_score = ?,
        value_label = ?,
        updated_at = ?,
        archived_at = ?,
        last_reviewed_at = ?,
        superseded_by = CASE WHEN ? = 1 THEN NULL ELSE COALESCE(?, superseded_by) END
      WHERE id = ?
    `);
    legacyStmt.run(
      targetStatus,
      Number.isFinite(Number(extra.value_score)) ? Number(extra.value_score) : null,
      extra.value_label ? String(extra.value_label) : null,
      nowIso,
      archivedAt,
      extra.last_reviewed_at ? toIso(extra.last_reviewed_at) : nowIso,
      clearSupersededBy,
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
      memory_current.source_layer, memory_current.source_path, memory_current.source_line, memory_current.source_host, memory_current.source_kind, memory_current.sync_policy, memory_current.confidence, memory_current.scope, memory_current.status, memory_current.value_score, memory_current.value_label,
      memory_current.created_at, memory_current.updated_at, memory_current.archived_at, memory_current.last_reviewed_at, memory_current.tags, memory_current.superseded_by, memory_current.content_time, memory_current.valid_until, memory_current.valid_from
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
    const scopeWhere = scopeWhereForRequested(scope, {
      includeProfile: options.includeProfile !== false,
      includeShared: options.includeShared !== false,
    });
    where.push(scopeWhere.sql);
    params.push(...scopeWhere.params);
  }
  if (hasClaims && memoryTiers.length > 0) {
    where.push(`c.memory_tier IN (${memoryTiers.map(() => '?').join(',')})`);
    params.push(...memoryTiers);
  }
  const sql = `
    SELECT
      memory_current.memory_id, memory_current.type, memory_current.content, memory_current.normalized, memory_current.normalized_hash, memory_current.source, memory_current.source_agent, memory_current.source_session,
      memory_current.source_layer, memory_current.source_path, memory_current.source_line, memory_current.source_host, memory_current.source_kind, memory_current.sync_policy, memory_current.confidence, memory_current.scope, memory_current.status, memory_current.value_score, memory_current.value_label,
      memory_current.created_at, memory_current.updated_at, memory_current.archived_at, memory_current.last_reviewed_at, memory_current.tags, memory_current.superseded_by, memory_current.content_time, memory_current.valid_until, memory_current.valid_from
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
    ORDER BY COALESCE(memory_current.content_time, memory_current.valid_from, memory_current.created_at) DESC
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
    const scopeWhere = scopeWhereForRequested(scope, {
      includeProfile: options.includeProfile !== false,
      includeShared: options.includeShared !== false,
    });
    where.push(scopeWhere.sql);
    params.push(...scopeWhere.params);
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
      memory_current.content_time, memory_current.valid_until, memory_current.valid_from,
      memory_current.source_agent, memory_current.source_layer, memory_current.source_host
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

  // Real corpus-weighted FTS5 bm25() relevance per memory_id, normalized to [0,1]
  // across this query's hits. This becomes the primary lexical-relevance signal
  // (see _fts_bm25 below + recall-service rankActiveRow/rankNativeRow), replacing
  // the dead constant-IDF bm25ScoreForRow. A small rank-based boost is kept for
  // back-compat with the supplementary FTS-only fetch path.
  const ftsBoost = new Map();
  const ftsBm25 = new Map();
  try {
    const ftsHits = searchFTS5(db, query, { topK: Math.max(20, topK * 3) });
    let maxScore = 0;
    for (const hit of ftsHits) {
      const sc = Number(hit.bm25_score);
      if (Number.isFinite(sc) && sc > maxScore) maxScore = sc;
    }
    for (let index = 0; index < ftsHits.length; index += 1) {
      const hit = ftsHits[index];
      const bonus = Math.max(0, 1 - (index / Math.max(ftsHits.length, 1))) * 0.25;
      ftsBoost.set(hit.memory_id, bonus);
      const sc = Number(hit.bm25_score);
      ftsBm25.set(hit.memory_id, maxScore > 0 && Number.isFinite(sc) ? Math.max(0, sc) / maxScore : 0);
    }
  } catch {
    // FTS5 is optional in some SQLite builds.
  }

  const scored = rows.map((row) => {
    const scoreLexical = lexicalScore(row.content || row.normalized || '', tokens);
    const valueScore = Number.isFinite(Number(row.value_score)) ? Number(row.value_score) : 0;
    const confidence = Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0;
    const fts5Bm25 = ftsBm25.get(row.memory_id) || 0;
    const fts5Bonus = ftsBoost.get(row.memory_id) || 0;
    // Corpus-weighted FTS5 bm25() is the PRIMARY relevance signal and must dominate
    // ordering; the substring lexicalScore is only a fallback when FTS5 produced no
    // score, and value_score/confidence are tie-breakers (not the primary sort key
    // the old `ORDER BY value_score` made them). This is what makes the exact-phrase
    // match outrank a high-value tangential row.
    const lexicalRelevance = fts5Bm25 > 0
      ? fts5Bm25
      : (scoreLexical / Math.max(tokens.length, 1)) * 0.4;
    const total = lexicalRelevance
      + valueScore * 0.12
      + confidence * 0.06
      + fts5Bonus * 0.2;
    return {
      ...row,
      score_lexical: scoreLexical,
      score_total: total,
      _fts_bm25: fts5Bm25,
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
          memory_current.valid_until,
          memory_current.valid_from
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
        if (scope && !rowVisibleForRequestedScope(ftsRow.scope, scope, {
          includeProfile: options.includeProfile !== false,
          includeShared: options.includeShared !== false,
        })) continue;
        if (hasClaims && memoryTiers.length > 0 && !memoryTiers.includes(String(ftsRow.memory_tier || '').trim())) continue;
        scored.push({
          ...ftsRow,
          score_lexical: 0,
          score_total: bonus,
          _fts_bm25: ftsBm25.get(memoryId) || 0,
        });
      }
    } catch {
      // Ignore malformed FTS rows and keep the lexical results.
    }
  }

  return scored
    .filter((row) => Number(row.score_lexical || 0) > 0 || ftsBoost.has(row.memory_id))
    .sort((a, b) => {
      // Primary: corpus-weighted FTS5 bm25 relevance (a true exact/phrase match
      // leads); tie-break on the blended score_total (value/confidence/substring).
      const fb = Number(b._fts_bm25 || 0) - Number(a._fts_bm25 || 0);
      if (Math.abs(fb) > 1e-9) return fb;
      return Number(b.score_total || 0) - Number(a.score_total || 0);
    })
    .slice(0, topK);
};

// U9: reverse-migration backfill ONLY. Reads the legacy `memories` table and
// materializes it into memory_current. This is intentionally the single
// remaining reader of `memories`, and it is a guarded one-time path: callers
// (openPreparedDb) invoke it solely when memory_current is empty, i.e. when
// opening a legacy DB that predates the projection store. It is NOT part of
// normal operation. It must be retained (not no-op'd) so upgrades from
// legacy-only DBs do not lose data; removing it would be a data-loss
// regression. When memory_current already has rows, this never runs.
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
      ${col('source_host', "'gigabrain'")},
      ${col('source_kind', "'registry'")},
      ${col('sync_policy', "'read_only'")},
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
        source_host: row.source_host,
        source_kind: row.source_kind,
        sync_policy: row.sync_policy,
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

// U18 containment check: is every legacy `memories` row represented in the
// authoritative memory_current projection? An ORPHAN is a legacy row whose `id`
// has NO matching memory_current.memory_id — dropping the legacy table while
// orphans exist would silently lose those facts. The physical drop must be
// REFUSED while orphanCount > 0. When the legacy table is absent (fresh install
// post-drop) containment is trivially clean (nothing to contain). Returns the
// counts plus a bounded sample of orphan ids/content for the operator report.
const checkLegacyContainment = (db) => {
  if (!hasTable(db, 'memories')) {
    return { tablePresent: false, containedCount: 0, orphanCount: 0, orphans: [] };
  }
  ensureProjectionStore(db);
  const containedRow = db.prepare(`
    SELECT COUNT(*) AS c
    FROM memories m
    WHERE EXISTS (SELECT 1 FROM memory_current mc WHERE mc.memory_id = m.id)
  `).get();
  const orphanRow = db.prepare(`
    SELECT COUNT(*) AS c
    FROM memories m
    WHERE NOT EXISTS (SELECT 1 FROM memory_current mc WHERE mc.memory_id = m.id)
  `).get();
  const orphans = db.prepare(`
    SELECT m.id, m.content, m.status, m.scope
    FROM memories m
    WHERE NOT EXISTS (SELECT 1 FROM memory_current mc WHERE mc.memory_id = m.id)
    ORDER BY m.id ASC
    LIMIT 50
  `).all().map((row) => ({
    id: String(row.id || ''),
    content: String(row.content || '').slice(0, 200),
    status: String(row.status || ''),
    scope: String(row.scope || ''),
  }));
  return {
    tablePresent: true,
    containedCount: Number(containedRow?.c || 0),
    orphanCount: Number(orphanRow?.c || 0),
    orphans,
  };
};

// U18 containment-gated physical drop of the deprecated `memories` table.
// Refuses unless containment passes (no orphan legacy rows). When `snapshot` is
// a path, a `VACUUM INTO` snapshot of the WHOLE DB is written BEFORE the DROP so
// the operation is recoverable; the DROP then runs and EXACTLY ONE ledger event
// (action 'migrate:legacy_drop') is appended via the same appendEvent API used
// by every other migration/arbitration record. The whole thing rides one
// SAVEPOINT so a failed DROP leaves no half-recorded ledger entry. A no-op when
// the table is already absent (returns dropped:false, idempotent).
const LEGACY_DROP_ACTION = 'migrate:legacy_drop';

const dropLegacyMemoriesTable = (db, options = {}) => {
  ensureProjectionStore(db);
  const snapshot = options.snapshot ? String(options.snapshot) : null;

  if (!hasTable(db, 'memories')) {
    // Already gone (fresh install or prior drop): clean no-op, nothing to record.
    return {
      dropped: false,
      reason: 'no_legacy_table',
      containment: checkLegacyContainment(db),
      snapshotPath: null,
      event: null,
    };
  }

  const containment = checkLegacyContainment(db);
  if (containment.orphanCount > 0) {
    throw new Error(
      `legacy drop refused: ${containment.orphanCount} legacy 'memories' row(s) are not contained in memory_current`,
    );
  }

  // Snapshot BEFORE dropping (outside the savepoint — VACUUM cannot run inside a
  // transaction). VACUUM INTO writes a fresh, fully-recoverable copy of the DB.
  let snapshotPath = null;
  if (snapshot) {
    db.prepare('VACUUM INTO ?').run(snapshot);
    snapshotPath = snapshot;
  }

  db.exec('SAVEPOINT gb_legacy_drop');
  let event = null;
  try {
    db.exec('DROP TABLE IF EXISTS memories');
    // EXACTLY ONE ledger event for the drop, on the append-only event log,
    // reusing the same appendEvent contract as recordVerdict/recordAdjudication.
    event = appendEvent(db, {
      component: 'migration',
      action: LEGACY_DROP_ACTION,
      reason_codes: ['legacy_drop', 'containment_passed'],
      memory_id: LEGACY_DROP_ACTION,
      timestamp: toIso(options.timestamp || new Date().toISOString()),
      payload: {
        contained_count: containment.containedCount,
        orphan_count: containment.orphanCount,
        snapshot_path: snapshotPath,
      },
    });
    db.exec('RELEASE gb_legacy_drop');
  } catch (err) {
    try { db.exec('ROLLBACK TO gb_legacy_drop'); db.exec('RELEASE gb_legacy_drop'); } catch { /* savepoint already gone */ }
    throw err;
  }

  return {
    dropped: true,
    reason: 'dropped',
    containment,
    snapshotPath,
    event,
  };
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

// Arbitration ledger entry point (R1/R2). Records a judgment ABOUT rival facts
// on the append-only event log and drives supersession on the losers. No new
// table: the verdict rides `action` + `reason_codes` + `payload` + `agent_id`,
// and losers are marked via the existing `superseded_by`/`status='superseded'`
// machinery (updateCurrentStatus). The store never keeps a rival copy.
const recordVerdict = (db, { winnerId, loserIds = [], signals = {}, agentId = null, reason } = {}, options = {}) => {
  ensureProjectionStore(db);
  const winner = String(winnerId || '').trim();
  if (!winner) throw new Error('recordVerdict requires winnerId');
  const losers = (Array.isArray(loserIds) ? loserIds : [loserIds])
    .map((id) => String(id || '').trim())
    .filter(Boolean);
  const agent = agentId ? String(agentId) : null;
  const nowIso = toIso(options.timestamp || new Date().toISOString());
  const reasonCodes = reason === undefined || reason === null ? [] : reason;

  // Wrap the verdict + N supersede writes in a SAVEPOINT so the ledger entry is
  // atomic: a failure on the Nth loser cannot leave a verdict event with a
  // half-written supersession trail. SAVEPOINT (not BEGIN) nests safely whether
  // or not the caller already holds an outer transaction (e.g. a world-model rebuild).
  db.exec('SAVEPOINT gb_record_verdict');
  try {
    // (0) Attestation guards (R2): a verdict must judge a real, coherent rivalry.
    // A winner that is also a loser, or a winner the store has never seen, would
    // put an unreplayable judgment on the ledger — reject inside the savepoint so
    // a bad verdict leaves no partial write.
    if (losers.includes(winner)) {
      throw new Error(`recordVerdict winner ${winner} cannot also be a loser`);
    }
    const winnerRow = getCurrentMemory(db, winner);
    if (!winnerRow) {
      throw new Error(`recordVerdict winner ${winner} does not exist in memory_current`);
    }

    // (a) Append the verdict event. The decision and its provenance are the
    // first-class record; payload carries the full who-beat-whom + signals.
    const verdictEvent = appendEvent(db, {
      component: 'arbiter',
      action: 'arbiter:verdict',
      reason_codes: reasonCodes,
      memory_id: winner,
      agent_id: agent,
      timestamp: nowIso,
      payload: {
        winnerId: winner,
        loserIds: losers,
        signals: signals && typeof signals === 'object' ? signals : {},
      },
    });

    // (b) Verdict flip (R2): a winner that lost an earlier verdict is reinstated
    // instead of being stranded superseded — set it active, clear superseded_by,
    // and append an arbiter:reinstate event referencing the prior verdict it
    // overturns so the flip stays replayable from the ledger alone. Without this
    // a flip leaves BOTH rivals superseded (supersession cycle, fact vanishes).
    let reinstateEvent = null;
    if (String(winnerRow.status || '').toLowerCase() === 'superseded') {
      const previouslySupersededBy = winnerRow.superseded_by ? String(winnerRow.superseded_by) : null;
      const previousValidUntil = winnerRow.valid_until ? String(winnerRow.valid_until) : null;
      const priorSupersede = db.prepare(`
        SELECT event_id FROM memory_events
        WHERE action = 'arbiter:supersede' AND memory_id = ?
        ORDER BY timestamp DESC, rowid DESC
        LIMIT 1
      `).get(winner);
      updateCurrentStatus(db, winner, 'active', {
        clear_superseded_by: true,
        clear_valid_until: true,
        timestamp: nowIso,
      }, options);
      reinstateEvent = appendEvent(db, {
        component: 'arbiter',
        action: 'arbiter:reinstate',
        reason_codes: reasonCodes,
        memory_id: winner,
        matched_memory_id: previouslySupersededBy,
        agent_id: agent,
        timestamp: nowIso,
        payload: {
          winnerId: winner,
          previously_superseded_by: previouslySupersededBy,
          previous_valid_until: previousValidUntil,
          prior_supersede_event_id: priorSupersede?.event_id || null,
          verdict_event_id: verdictEvent.event_id,
        },
      });
    }

    // (b2) Event-time flip (U12): the verdict opens the winner's valid time and
    // closes every loser's at the SAME nowIso, inside this savepoint, so
    // "believed true at T" flips atomically from loser to winner at the verdict
    // instant. A reinstated winner re-opens here too — (b) cleared its stale
    // valid_until, this stamp gives it valid_from = the flip timestamp. For an
    // already-active winner, a leftover valid_until <= the new valid_from would
    // invert the interval (valid_until < valid_from) and leave the winning row
    // recall-dead behind isLiveRecallRow — clear it, same rationale as the
    // reinstatement clear_valid_until; a genuinely future valid_until survives.
    db.prepare(`
      UPDATE memory_current
      SET valid_from = ?,
          valid_until = CASE WHEN valid_until IS NOT NULL AND valid_until <= ? THEN NULL ELSE valid_until END
      WHERE memory_id = ?
    `).run(nowIso, nowIso, winner);

    // (c) Mark each loser superseded by the winner and emit a supersede event so
    // the supersession is replayable from the ledger alone.
    const supersedeEvents = [];
    const closeLoserValidTime = db.prepare(`
      UPDATE memory_current
      SET valid_until = CASE WHEN valid_until IS NULL OR valid_until > ? THEN ? ELSE valid_until END
      WHERE memory_id = ?
    `);
    for (const loserId of losers) {
      updateCurrentStatus(db, loserId, 'superseded', {
        superseded_by: winner,
        timestamp: nowIso,
      }, options);
      // U12 loser close: the belief window ends at the verdict instant. An
      // earlier valid_until is kept (a verdict must not extend how long the
      // loser counted as believed-true); NULL/later closes pull in to nowIso.
      closeLoserValidTime.run(nowIso, nowIso, loserId);
      supersedeEvents.push(appendEvent(db, {
        component: 'arbiter',
        action: 'arbiter:supersede',
        reason_codes: reasonCodes,
        memory_id: loserId,
        matched_memory_id: winner,
        agent_id: agent,
        timestamp: nowIso,
        payload: { winnerId: winner, loserId },
      }));
    }

    db.exec('RELEASE gb_record_verdict');
    return { verdictEvent, reinstateEvent, supersedeEvents };
  } catch (err) {
    try { db.exec('ROLLBACK TO gb_record_verdict'); db.exec('RELEASE gb_record_verdict'); } catch { /* savepoint already gone */ }
    throw err;
  }
};

// Write-time state adjudication ledger (R8b/U11). The capture decision pass
// emits one KEEP/STALE/REPLACE/UNKNOWN verdict per retrieved neighbor; every
// verdict is appended to memory_events (action 'capture_state_adjudication',
// memory_id = the adjudicated neighbor) — KEEP no-ops included — so the ledger
// can answer "when did we learn X was stale" from the events alone.
const ADJUDICATION_ACTION = 'capture_state_adjudication';
const ADJUDICATION_STATE_SET = new Set(['KEEP', 'STALE', 'REPLACE', 'UNKNOWN']);

const recordAdjudication = (db, {
  memoryId,
  state,
  candidateContent = '',
  decisionOp = '',
  confidence = null,
  reason = '',
  scope = '',
  agentId = null,
  runId = '',
  reviewVersion = '',
  cleanupVersion = '',
} = {}, options = {}) => {
  ensureProjectionStore(db);
  const id = String(memoryId || '').trim();
  if (!id) throw new Error('recordAdjudication requires memoryId');
  const stateKey = String(state || '').trim().toUpperCase();
  if (!ADJUDICATION_STATE_SET.has(stateKey)) {
    throw new Error(`recordAdjudication invalid state: ${state}`);
  }
  return appendEvent(db, {
    component: 'capture',
    action: ADJUDICATION_ACTION,
    reason_codes: ['state_adjudication', `adjudication_${stateKey.toLowerCase()}`],
    memory_id: id,
    agent_id: agentId ? String(agentId) : null,
    timestamp: toIso(options.timestamp || new Date().toISOString()),
    run_id: runId || '',
    review_version: reviewVersion || '',
    cleanup_version: cleanupVersion || '',
    payload: {
      state: stateKey,
      decision_op: String(decisionOp || '').trim().toUpperCase(),
      candidate_content: String(candidateContent || ''),
      confidence: Number.isFinite(Number(confidence)) ? Number(confidence) : null,
      reason: String(reason || '').slice(0, 240),
      scope: String(scope || ''),
    },
  });
};

// Ledger query for adjudications: "when did we learn X was stale" =
// listAdjudications(db, { memoryId: X, states: ['STALE'] })[0].timestamp.
const listAdjudications = (db, options = {}) => {
  if (!hasTable(db, 'memory_events')) return [];
  const memoryId = String(options.memoryId || '').trim();
  const states = (Array.isArray(options.states) ? options.states : [])
    .map((item) => String(item || '').trim().toUpperCase())
    .filter((item) => ADJUDICATION_STATE_SET.has(item));
  const limit = Math.max(1, Math.min(1000, Number(options.limit || 100) || 100));
  const where = ['action = ?'];
  const params = [ADJUDICATION_ACTION];
  if (memoryId) {
    where.push('memory_id = ?');
    params.push(memoryId);
  }
  const rows = db.prepare(`
    SELECT event_id, timestamp, memory_id, agent_id, run_id, reason_codes, payload
    FROM memory_events
    WHERE ${where.join(' AND ')}
    ORDER BY timestamp DESC, rowid DESC
    LIMIT ?
  `).all(...params, limit);
  const parsed = rows.map((row) => {
    let payload = {};
    try { payload = JSON.parse(String(row.payload || '{}')) || {}; } catch { payload = {}; }
    return { ...row, payload, state: String(payload.state || '').toUpperCase() };
  });
  return states.length > 0 ? parsed.filter((row) => states.includes(row.state)) : parsed;
};

// U12 event-time snapshot: "what was believed true at time T", for winners AND
// losers. Interval semantics: valid_from <= T AND (valid_until IS NULL OR
// valid_until > T) — half-open [valid_from, valid_until), so at the exact flip
// instant the winner is in and the loser is out. Superseded rows are included
// by default because they WERE believed true inside their interval; pass
// options.statuses to narrow. This is an event-time query only — transaction
// time ("when did the store learn it") lives in created_at + the
// verdict/supersede/reinstate events and is NOT filtered here. valid_from is
// COALESCEd with created_at as belt-and-braces for rows that predate a
// completed U12 backfill (the migration guarantees non-NULL).
const listBeliefsAsOf = (db, options = {}) => {
  ensureProjectionStore(db);
  const atMs = Date.parse(String(options.at || ''));
  if (!Number.isFinite(atMs)) throw new Error('listBeliefsAsOf requires a parseable `at` timestamp');
  const atIso = new Date(atMs).toISOString();
  const scope = normalizeProjectionScope(options.scope || '', { allowEmpty: true });
  const statuses = Array.isArray(options.statuses) && options.statuses.length > 0
    ? options.statuses.map((item) => canonicalStatus(item))
    : ['active', 'superseded'];
  const limit = Math.max(1, Math.min(10000, Number(options.limit || 1000) || 1000));
  const where = [
    'COALESCE(memory_current.valid_from, memory_current.created_at) <= ?',
    '(memory_current.valid_until IS NULL OR memory_current.valid_until > ?)',
    `memory_current.status IN (${statuses.map(() => '?').join(',')})`,
  ];
  const params = [atIso, atIso, ...statuses];
  if (scope) {
    const scopeWhere = scopeWhereForRequested(scope);
    where.push(scopeWhere.sql);
    params.push(...scopeWhere.params);
  }
  return db.prepare(`
    SELECT
      memory_current.memory_id, memory_current.type, memory_current.content, memory_current.normalized,
      memory_current.source, memory_current.confidence, memory_current.scope, memory_current.status,
      memory_current.value_score, memory_current.value_label, memory_current.created_at, memory_current.updated_at,
      memory_current.tags, memory_current.superseded_by, memory_current.content_time,
      memory_current.valid_from, memory_current.valid_until
    FROM memory_current
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(memory_current.valid_from, memory_current.created_at) DESC, memory_current.memory_id ASC
    LIMIT ?
  `).all(...params, limit);
};

export {
  hasTable,
  hasColumn,
  ensureLegacyMemoriesTable,
  checkLegacyContainment,
  dropLegacyMemoriesTable,
  ensureProjectionStore,
  normalizeProjectionScope,
  upsertCurrentMemory,
  updateCurrentStatus,
  recordVerdict,
  recordAdjudication,
  listAdjudications,
  listBeliefsAsOf,
  getCurrentMemory,
  listCurrentMemories,
  searchCurrentMemories,
  materializeProjectionFromMemories,
  rebuildFTS5,
  searchFTS5,
  tokenizeFtsQuery,
  rowVisibleForRequestedScope,
  scopeWhereForRequested,
  tableStats,
};
