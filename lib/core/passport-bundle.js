import crypto from 'node:crypto';

import {
  ensureProjectionStore,
  listCurrentMemories,
  upsertCurrentMemory,
} from './projection-store.js';
import {
  ensureHostMemoryStore,
  expandMemorySourceLinks,
  linkMemorySource,
} from './host-memory-sync.js';
import { ensureEventStore, listTimeline, appendEvent } from './event-store.js';

// Portable, re-importable memory bundle — the round-trip counterpart to the
// (export-only) Memory Passport report.
//
// Design:
// - The SOURCE OF TRUTH is carried: every memory_current row (all statuses)
//   with its bi-temporal fields (content_time, valid_until), confidence, tags,
//   and full provenance (source_host/kind/path/line + memory_source_links).
// - The WORLD MODEL (beliefs, claim-slots, entities) is a DERIVED projection.
//   It is intentionally NOT serialized: after import, `gigabrainctl world
//   rebuild` (or the nightly run) reconstructs it deterministically from the
//   replayed memories. Carrying derived state would risk it drifting out of
//   sync with the memories it is derived from.
// - EMBEDDINGS are model-specific and are NOT carried. The manifest records a
//   re-embed-on-import contract; the receiving host re-embeds with its own
//   model. Recall is BM25/FTS5 lexical-first, so portability never depends on
//   shipping vectors.
// - INTEGRITY: a content hash over the canonical record set is stored in the
//   manifest and verified on import, so tampering or truncation is detected.

const BUNDLE_KIND = 'gigabrain.memory-passport-bundle';
const SCHEMA_VERSION = '1.0';
const EMBEDDING_CONTRACT = 're-embed-on-import';

const sha256 = (value = '') => crypto.createHash('sha256').update(String(value)).digest('hex');

// Stable subset of a memory row that defines its portable identity + content.
// Order matters: this is what the integrity hash is computed over.
const MEMORY_FIELDS = [
  'memory_id', 'type', 'content', 'normalized', 'normalized_hash',
  'source', 'source_agent', 'source_session', 'source_layer',
  'source_path', 'source_line', 'source_host', 'source_kind', 'sync_policy',
  'confidence', 'scope', 'status', 'value_score', 'value_label',
  'created_at', 'updated_at', 'archived_at', 'last_reviewed_at',
  'tags', 'superseded_by', 'content_time', 'valid_until',
];

const normalizeTags = (tags) => {
  if (Array.isArray(tags)) return tags.map((t) => String(t));
  if (typeof tags === 'string') {
    try {
      const parsed = JSON.parse(tags);
      return Array.isArray(parsed) ? parsed.map((t) => String(t)) : [];
    } catch {
      return [];
    }
  }
  return [];
};

const pickMemoryRecord = (row = {}) => {
  const record = {};
  for (const field of MEMORY_FIELDS) {
    if (field === 'tags') {
      record.tags = normalizeTags(row.tags);
      continue;
    }
    const value = row[field];
    record[field] = value === undefined ? null : value;
  }
  return record;
};

// Canonical, deterministic serialization for hashing: records sorted by id,
// keys in fixed order. Independent of row insertion / read order.
const canonicalize = (records = []) => {
  const sorted = [...records].sort((a, b) => String(a.memory_id).localeCompare(String(b.memory_id)));
  return JSON.stringify(sorted.map((record) => {
    const ordered = {};
    for (const field of MEMORY_FIELDS) ordered[field] = record[field] === undefined ? null : record[field];
    return ordered;
  }));
};

const computeContentHash = (records = []) => sha256(canonicalize(records));

const exportPassportBundle = ({ db, scope = '', includeEvents = false, generatedAt = null } = {}) => {
  if (!db) throw new Error('exportPassportBundle requires db');
  ensureProjectionStore(db);
  ensureHostMemoryStore(db);

  const rows = listCurrentMemories(db, {
    scope: String(scope || '').trim(),
    limit: 1000000,
  });
  const memories = rows.map(pickMemoryRecord);

  const sourceLinks = [];
  for (const memory of memories) {
    const links = expandMemorySourceLinks(db, memory.memory_id);
    for (const link of links) {
      sourceLinks.push({
        memory_id: memory.memory_id,
        source_host: String(link.source_host || ''),
        source_kind: String(link.source_kind || ''),
        sync_policy: String(link.sync_policy || ''),
        source_path: link.source_path ? String(link.source_path) : null,
        source_line: Number.isFinite(Number(link.source_line)) ? Number(link.source_line) : null,
        content_hash: link.content_hash ? String(link.content_hash) : null,
      });
    }
  }

  let events = null;
  if (includeEvents) {
    ensureEventStore(db);
    events = [];
    for (const memory of memories) {
      for (const event of listTimeline(db, memory.memory_id, { limit: 2000 })) {
        events.push(event);
      }
    }
  }

  const contentHash = computeContentHash(memories);

  return {
    kind: BUNDLE_KIND,
    schema_version: SCHEMA_VERSION,
    generated_at: String(generatedAt || new Date().toISOString()),
    manifest: {
      scope: String(scope || '').trim() || null,
      memory_count: memories.length,
      source_link_count: sourceLinks.length,
      event_count: events ? events.length : 0,
      events_included: Boolean(events),
      embeddings_included: false,
      embedding_contract: EMBEDDING_CONTRACT,
      content_hash: contentHash,
      world_model_included: false,
      world_model_note: 'World model is derived; rebuild with `gigabrainctl world rebuild` after import.',
    },
    memories,
    source_links: sourceLinks,
    events,
  };
};

const validateBundleShape = (bundle) => {
  if (!bundle || typeof bundle !== 'object') throw new Error('passport bundle must be an object');
  if (bundle.kind !== BUNDLE_KIND) throw new Error(`unsupported bundle kind: ${bundle.kind || '(none)'}`);
  const major = String(bundle.schema_version || '').split('.')[0];
  if (major !== '1') throw new Error(`unsupported bundle schema_version: ${bundle.schema_version || '(none)'}`);
  if (!Array.isArray(bundle.memories)) throw new Error('bundle.memories must be an array');
  if (!bundle.manifest || typeof bundle.manifest !== 'object') throw new Error('bundle.manifest is required');
};

const importPassportBundle = ({
  db,
  bundle,
  skipIntegrityCheck = false,
  runId = '',
} = {}) => {
  if (!db) throw new Error('importPassportBundle requires db');
  validateBundleShape(bundle);
  ensureProjectionStore(db);
  ensureHostMemoryStore(db);
  ensureEventStore(db);

  // Integrity: recompute the content hash from the carried memories and compare
  // to the manifest. Detects tampering / truncation before anything is written.
  const recomputed = computeContentHash(bundle.memories);
  const declared = String(bundle.manifest.content_hash || '');
  const integrityOk = declared === recomputed;
  if (!integrityOk && !skipIntegrityCheck) {
    throw new Error(
      `passport bundle integrity check failed: manifest content_hash does not match memories (expected ${declared || '(none)'}, recomputed ${recomputed})`,
    );
  }

  const result = {
    ok: true,
    integrity_ok: integrityOk,
    integrity_skipped: Boolean(skipIntegrityCheck && !integrityOk),
    imported_memories: 0,
    imported_source_links: 0,
    imported_events: 0,
    content_hash: recomputed,
  };

  db.exec('BEGIN');
  try {
    for (const memory of bundle.memories) {
      upsertCurrentMemory(db, memory);
      result.imported_memories += 1;
    }
    for (const link of (bundle.source_links || [])) {
      if (!link || !link.memory_id || !link.source_host) continue;
      linkMemorySource(db, {
        memory_id: link.memory_id,
        source_host: link.source_host,
        source_kind: link.source_kind || 'native_memory',
        source_path: link.source_path || null,
        source_line: link.source_line || null,
        sync_policy: link.sync_policy || 'read_only',
        content_hash: link.content_hash || null,
      });
      result.imported_source_links += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Stamp a provenance event per imported memory (best-effort, outside the
  // memory write txn so an event-store hiccup can't lose imported memories).
  for (const memory of bundle.memories) {
    try {
      appendEvent(db, {
        component: 'passport_import',
        action: 'import',
        memory_id: memory.memory_id,
        run_id: String(runId || ''),
        reason_codes: ['passport_bundle_import'],
        payload: {
          schema_version: bundle.schema_version,
          generated_at: bundle.generated_at || null,
          integrity_ok: integrityOk,
        },
      });
      result.imported_events += 1;
    } catch {
      /* event log is advisory for import provenance */
    }
  }

  result.world_model_rebuild_required = true;
  return result;
};

export {
  BUNDLE_KIND,
  SCHEMA_VERSION,
  EMBEDDING_CONTRACT,
  computeContentHash,
  exportPassportBundle,
  importPassportBundle,
  validateBundleShape,
};
