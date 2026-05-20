import path from 'node:path';

import { hashNormalized, normalizeContent } from './policy.js';
import {
  ensureProjectionStore,
  getCurrentMemory,
  upsertCurrentMemory,
} from './projection-store.js';
import {
  ensureHostMemoryStore,
  linkMemorySource,
  normalizeHost,
  normalizeKind,
  normalizePolicy,
  recordSyncRun,
} from './host-memory-sync.js';
import { openDatabase } from './sqlite.js';

const DEFAULT_SOURCE_HOST = 'openclaw';
const DEFAULT_SOURCE_KIND = 'native_memory';
const DEFAULT_SYNC_POLICY = 'read_only';

const hasTable = (db, tableName) => {
  const row = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
    LIMIT 1
  `).get(String(tableName || ''));
  return Boolean(row?.name);
};

const tableColumns = (db, tableName) => new Set(
  db.prepare(`PRAGMA table_info(${tableName})`).all().map((row) => String(row.name || '')),
);

const col = (columns, name, fallbackSql = 'NULL') => columns.has(name) ? name : `${fallbackSql} AS ${name}`;

const parseTags = (value) => {
  if (Array.isArray(value)) return value;
  const text = String(value || '').trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item || '')).filter(Boolean);
  } catch {
    // Keep legacy comma text as a single tag source below.
  }
  return text.split(',').map((item) => item.trim()).filter(Boolean);
};

const sourcePathForMemory = (registryPath, memoryId) => `${path.resolve(registryPath)}#memories/${encodeURIComponent(memoryId)}`;

const ensureImportEvidenceTable = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_import_evidence (
      memory_id TEXT NOT NULL,
      source_host TEXT NOT NULL,
      source_path TEXT NOT NULL,
      evidence_index INTEGER NOT NULL,
      text_snippet TEXT NOT NULL,
      created_at TEXT,
      PRIMARY KEY(memory_id, source_host, source_path, evidence_index)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_import_evidence_memory
      ON memory_import_evidence(memory_id);
  `);
};

const statusCounts = (rows = []) => {
  const out = {};
  for (const row of rows) {
    const key = String(row.status || 'active');
    out[key] = Number(out[key] || 0) + 1;
  }
  return out;
};

const loadLegacyRows = (sourceDb) => {
  if (!hasTable(sourceDb, 'memories')) {
    throw new Error('OpenClaw registry does not contain a memories table');
  }
  const columns = tableColumns(sourceDb, 'memories');
  return sourceDb.prepare(`
    SELECT
      ${col(columns, 'id')},
      ${col(columns, 'type', "'CONTEXT'")},
      ${col(columns, 'content', "''")},
      ${col(columns, 'normalized', "''")},
      ${col(columns, 'source', "'openclaw'")},
      ${col(columns, 'source_agent')},
      ${col(columns, 'source_session')},
      ${col(columns, 'source_message_id')},
      ${col(columns, 'confidence', '0.6')},
      ${col(columns, 'status', "'active'")},
      ${col(columns, 'scope', "'shared'")},
      ${col(columns, 'tags', "'[]'")},
      ${col(columns, 'created_at')},
      ${col(columns, 'updated_at')},
      ${col(columns, 'last_confirmed_at')},
      ${col(columns, 'pinned', '0')},
      ${col(columns, 'superseded_by')},
      ${col(columns, 'concept')},
      ${col(columns, 'value_score')},
      ${col(columns, 'value_label')},
      ${col(columns, 'review_version')},
      ${col(columns, 'review_reason')},
      ${col(columns, 'archived_at')},
      ${col(columns, 'last_reviewed_at')}
    FROM memories
    ORDER BY COALESCE(updated_at, created_at, id) ASC
  `).all();
};

const loadEvidence = (sourceDb) => {
  if (!hasTable(sourceDb, 'evidence')) return new Map();
  const rows = sourceDb.prepare(`
    SELECT memory_id, text_snippet, created_at
    FROM evidence
    ORDER BY id ASC
  `).all();
  const byMemory = new Map();
  for (const row of rows) {
    const memoryId = String(row.memory_id || '').trim();
    const snippet = String(row.text_snippet || '').trim();
    if (!memoryId || !snippet) continue;
    if (!byMemory.has(memoryId)) byMemory.set(memoryId, []);
    byMemory.get(memoryId).push({
      text_snippet: snippet,
      created_at: row.created_at ? String(row.created_at) : null,
    });
  }
  return byMemory;
};

const existingCanonical = (db, { memoryId, normalizedHash, normalized, scope } = {}) => {
  const byId = getCurrentMemory(db, memoryId);
  if (byId) return byId;
  return db.prepare(`
    SELECT memory_id
    FROM memory_current
    WHERE (normalized_hash = ? OR normalized = ?) AND scope = ? AND status = 'active'
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(String(normalizedHash || ''), String(normalized || ''), String(scope || 'shared')) || null;
};

const importOpenClawRegistry = ({
  db,
  registryPath,
  memoryRoot = '',
  sourceHost = DEFAULT_SOURCE_HOST,
  sourceLabel = '',
  dryRun = false,
} = {}) => {
  if (!db) throw new Error('importOpenClawRegistry requires target db');
  if (!registryPath) throw new Error('importOpenClawRegistry requires registryPath');

  const normalizedSourceHost = normalizeHost(sourceHost || DEFAULT_SOURCE_HOST);
  const normalizedSourceKind = normalizeKind(DEFAULT_SOURCE_KIND);
  const normalizedSyncPolicy = normalizePolicy(DEFAULT_SYNC_POLICY);
  const sourceDb = openDatabase(path.resolve(registryPath), { readOnly: true });
  try {
    ensureProjectionStore(db);
    ensureHostMemoryStore(db);
    ensureImportEvidenceTable(db);

    const rows = loadLegacyRows(sourceDb);
    const evidence = loadEvidence(sourceDb);
    const result = {
      ok: true,
      command: 'import-openclaw',
      dry_run: dryRun === true,
      registry_path: path.resolve(registryPath),
      memory_root: memoryRoot ? path.resolve(memoryRoot) : '',
      source_host: normalizedSourceHost,
      source_label: String(sourceLabel || ''),
      source_count: rows.length,
      evidence_count: Array.from(evidence.values()).reduce((sum, items) => sum + items.length, 0),
      status_counts: statusCounts(rows),
      imported_count: 0,
      updated_count: 0,
      linked_count: 0,
      duplicate_count: 0,
      skipped_count: 0,
      evidence_imported_count: 0,
      warnings: [],
    };

    const runId = `openclaw-import:${normalizedSourceHost}:${hashNormalized(`${registryPath}:${sourceLabel}:${Date.now()}`).slice(0, 16)}`;
    const apply = () => {
      for (const row of rows) {
        const memoryId = String(row.id || '').trim();
        const content = String(row.content || '').trim();
        if (!memoryId || !content) {
          result.skipped_count += 1;
          continue;
        }
        const normalized = String(row.normalized || normalizeContent(content)).trim();
        const normalizedHash = hashNormalized(normalized);
        const scope = String(row.scope || 'shared').trim() || 'shared';
        const existing = existingCanonical(db, { memoryId, normalizedHash, normalized, scope });
        const canonicalId = existing?.memory_id || memoryId;
        const sourcePath = sourcePathForMemory(registryPath, memoryId);
        const tags = [
          ...parseTags(row.tags),
          'openclaw_import',
          `source_host:${normalizedSourceHost}`,
          sourceLabel ? `source_label:${sourceLabel}` : '',
          Number(row.pinned || 0) ? 'pinned' : '',
        ].filter(Boolean);

        if (existing?.memory_id && existing.memory_id !== memoryId) {
          result.duplicate_count += 1;
        }

        if (dryRun !== true && !existing) {
          upsertCurrentMemory(db, {
            memory_id: memoryId,
            type: row.type || 'CONTEXT',
            content,
            normalized,
            source: row.source || 'openclaw',
            source_agent: row.source_agent || 'openclaw',
            source_session: row.source_session || null,
            source_layer: 'openclaw_registry',
            source_path: sourcePath,
            source_line: 1,
            source_host: normalizedSourceHost,
            source_kind: normalizedSourceKind,
            sync_policy: normalizedSyncPolicy,
            confidence: row.confidence,
            scope,
            status: row.status || 'active',
            value_score: row.value_score,
            value_label: row.value_label,
            created_at: row.created_at,
            updated_at: row.updated_at || row.created_at,
            archived_at: row.archived_at,
            last_reviewed_at: row.last_reviewed_at,
            tags,
            superseded_by: row.superseded_by,
          });
          result.imported_count += 1;
        } else if (dryRun !== true && existing?.memory_id === memoryId) {
          upsertCurrentMemory(db, {
            memory_id: memoryId,
            type: row.type || existing.type || 'CONTEXT',
            content,
            normalized,
            source: row.source || existing.source || 'openclaw',
            source_agent: row.source_agent || existing.source_agent || 'openclaw',
            source_session: row.source_session || existing.source_session || null,
            source_layer: 'openclaw_registry',
            source_path: sourcePath,
            source_line: 1,
            source_host: normalizedSourceHost,
            source_kind: normalizedSourceKind,
            sync_policy: normalizedSyncPolicy,
            confidence: row.confidence,
            scope,
            status: row.status || existing.status || 'active',
            value_score: row.value_score,
            value_label: row.value_label,
            created_at: row.created_at,
            updated_at: row.updated_at || row.created_at,
            archived_at: row.archived_at,
            last_reviewed_at: row.last_reviewed_at,
            tags,
            superseded_by: row.superseded_by,
          });
          result.updated_count += 1;
        }

        if (dryRun !== true) {
          linkMemorySource(db, {
            memory_id: canonicalId,
            source_host: normalizedSourceHost,
            source_kind: normalizedSourceKind,
            source_path: sourcePath,
            source_line: 1,
            sync_policy: normalizedSyncPolicy,
            content_hash: normalizedHash,
          });
          const snippets = evidence.get(memoryId) || [];
          snippets.forEach((item, index) => {
            db.prepare(`
              INSERT INTO memory_import_evidence (
                memory_id, source_host, source_path, evidence_index, text_snippet, created_at
              ) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(memory_id, source_host, source_path, evidence_index) DO UPDATE SET
                text_snippet = excluded.text_snippet,
                created_at = excluded.created_at
            `).run(canonicalId, normalizedSourceHost, sourcePath, index + 1, item.text_snippet, item.created_at);
            result.evidence_imported_count += 1;
          });
        }
        result.linked_count += 1;
      }
    };

    if (dryRun === true) {
      apply();
    } else {
      db.exec('BEGIN');
      try {
        apply();
        recordSyncRun(db, {
          run_id: runId,
          source_host: normalizedSourceHost,
          source_kind: normalizedSourceKind,
          sync_policy: normalizedSyncPolicy,
          source_path: path.resolve(registryPath),
          status: 'ok',
          indexed_count: result.source_count,
          linked_count: result.linked_count,
          skipped_count: result.skipped_count,
          synced_at: new Date().toISOString(),
        });
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }

    result.summary = {
      source_count: result.source_count,
      imported_count: result.imported_count,
      updated_count: result.updated_count,
      duplicate_count: result.duplicate_count,
      linked_count: result.linked_count,
      skipped_count: result.skipped_count,
      evidence_imported_count: result.evidence_imported_count,
    };
    return result;
  } finally {
    sourceDb.close();
  }
};

export {
  importOpenClawRegistry,
  loadLegacyRows,
};
