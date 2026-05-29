import { randomUUID } from 'node:crypto';

import { inferTypeFromContent } from './capture-service.js';
import { listCurrentMemories, upsertCurrentMemory } from './projection-store.js';
import {
  classifyValue,
  detectPlausibility,
  jaccardSimilarity,
  normalizeContent,
  resolvePolicy,
  resolveSemanticThresholds,
} from './policy.js';

const SECTION_TYPE_RULES = Object.freeze([
  ['PREFERENCE', 'PREFERENCE'],
  ['DECISION', 'DECISION'],
  ['ENTITY', 'ENTITY'],
  ['EPISODE', 'EPISODE'],
  ['AGENT IDENTITY', 'AGENT_IDENTITY'],
  ['AGENT_IDENTITY', 'AGENT_IDENTITY'],
  ['USER FACT', 'USER_FACT'],
  ['USER_FACT', 'USER_FACT'],
  ['FACT', 'USER_FACT'],
]);

const DAILY_EPHEMERAL_RE = /\b(?:today|tonight|this morning|this afternoon|this evening|right now|currently|for now|temporary|temporarily|tired|hungry|busy)\b/i;

const inferChunkType = (chunk = {}) => {
  const section = String(chunk.section || '').toUpperCase();
  for (const [needle, type] of SECTION_TYPE_RULES) {
    if (section.includes(needle)) return type;
  }
  return inferTypeFromContent(chunk.content || '');
};

const inferChunkScope = (chunk = {}) => {
  const explicitScope = String(chunk.scope || '').trim();
  if (explicitScope) return explicitScope;
  if (String(chunk.source_kind || '') === 'memory_md') return 'profile:main';
  return 'shared';
};

const findExactDuplicate = (existingRows, normalized, scope) => {
  const key = `${String(scope || 'shared')}|${normalized}`;
  for (const row of existingRows) {
    const rowKey = `${String(row.scope || 'shared')}|${String(row.normalized || '')}`;
    if (rowKey === key && String(row.status || 'active') === 'active') return row;
  }
  return null;
};

const findSemanticDuplicate = (existingRows, content, scope, type, config) => {
  let best = null;
  for (const row of existingRows) {
    if (String(row.scope || 'shared') !== String(scope || 'shared')) continue;
    if (String(row.type || 'CONTEXT') !== String(type || 'CONTEXT')) continue;
    if (String(row.status || 'active') !== 'active') continue;
    const similarity = jaccardSimilarity(content, row.content || row.normalized || '');
    if (!best || similarity > best.similarity) {
      best = { row, similarity };
    }
  }
  if (!best) return null;
  const thresholds = resolveSemanticThresholds(type, config);
  return {
    ...best,
    thresholds,
  };
};

const shouldPromoteChunk = ({ chunk, type, scope, config, policy }) => {
  const sourceKind = String(chunk.source_kind || '');
  if (sourceKind === 'memory_md' && config?.nativePromotion?.promoteFromMemoryMd === false) {
    return { ok: false, reason: 'memory_md_disabled' };
  }
  if (sourceKind === 'daily_note' && config?.nativePromotion?.promoteFromDaily === false) {
    return { ok: false, reason: 'daily_disabled' };
  }
  if (!['memory_md', 'daily_note'].includes(sourceKind)) {
    return { ok: false, reason: 'source_kind_excluded' };
  }
  if (type === 'CONTEXT' || type === 'EPISODE') {
    return { ok: false, reason: 'situational_type' };
  }
  if (sourceKind === 'daily_note' && DAILY_EPHEMERAL_RE.test(String(chunk.content || ''))) {
    return { ok: false, reason: 'situational_daily' };
  }

  const confidence = sourceKind === 'memory_md' ? 0.86 : 0.72;
  if (confidence < Number(config?.nativePromotion?.minConfidence ?? 0.72)) {
    return { ok: false, reason: 'confidence_below_threshold' };
  }

  const plausibility = detectPlausibility({
    type,
    content: chunk.content || '',
    confidence,
    scope,
  }, policy);
  if (plausibility.actionableCount > 0) {
    return { ok: false, reason: 'plausibility_flag', plausibility };
  }

  const value = classifyValue({
    type,
    content: chunk.content || '',
    confidence,
    scope,
    status: 'active',
    updated_at: chunk.last_seen_at || chunk.first_seen_at || new Date().toISOString(),
  }, policy);
  if (value.action !== 'keep') {
    return { ok: false, reason: 'not_durable_enough', value };
  }

  return {
    ok: true,
    confidence,
    value,
  };
};

const VALID_PATH_RE = /^[a-zA-Z0-9_./:@~\-]+$/;

const validateSourcePath = (path) => {
  if (!path || typeof path !== 'string') return false;
  // Must match allowed characters and not contain path traversal sequences
  if (!VALID_PATH_RE.test(path)) return false;
  // Explicitly block path traversal attempts
  if (path.includes('..')) return false;
  // Must be reasonable length
  if (path.length > 4096) return false;
  return true;
};

const loadCandidateChunks = (db, sourcePaths = []) => {
  const paths = Array.isArray(sourcePaths)
    ? sourcePaths
      .map((item) => String(item || '').trim())
      .filter((item) => validateSourcePath(item))
    : [];
  if (paths.length === 0) return [];
  const sql = `
    SELECT
      chunk_id, source_path, source_kind, source_date, section, line_start, line_end,
      content, normalized, linked_memory_id, first_seen_at, last_seen_at
    FROM memory_native_chunks
    WHERE status = 'active'
      AND linked_memory_id IS NULL
      AND source_path IN (${paths.map(() => '?').join(',')})
    ORDER BY last_seen_at DESC, source_path ASC, line_start ASC
  `;
  return db.prepare(sql).all(...paths);
};

const promoteNativeChunks = ({
  db,
  config,
  sourcePaths = [],
  dryRun = false,
} = {}) => {
  const summary = {
    scanned_chunks: 0,
    promoted_inserted: 0,
    linked_existing: 0,
    skipped_linked: 0,
    skipped_not_durable: 0,
    skipped_exact_duplicate: 0,
    skipped_semantic_duplicate: 0,
    changed_sources: Array.isArray(sourcePaths) ? sourcePaths.filter(Boolean) : [],
    promoted_ids: [],
  };
  const paths = Array.isArray(sourcePaths) ? sourcePaths.filter(Boolean) : [];
  if (paths.length === 0 || config?.nativePromotion?.enabled === false) return summary;

  const policy = resolvePolicy(config);
  const chunks = loadCandidateChunks(db, paths);
  const activeByScope = new Map();
  const linkChunk = db.prepare(`
    UPDATE memory_native_chunks
    SET linked_memory_id = ?
    WHERE chunk_id = ?
  `);

  const getExistingRows = (scope) => {
    if (!activeByScope.has(scope)) {
      activeByScope.set(scope, listCurrentMemories(db, {
        statuses: ['active'],
        scope,
        limit: 5000,
      }));
    }
    return activeByScope.get(scope);
  };

  for (const chunk of chunks) {
    summary.scanned_chunks += 1;
    if (chunk.linked_memory_id) {
      summary.skipped_linked += 1;
      continue;
    }

    const content = String(chunk.content || '').trim();
    const normalized = normalizeContent(content);
    if (!content || !normalized) {
      summary.skipped_not_durable += 1;
      continue;
    }

    const type = inferChunkType(chunk);
    const scope = inferChunkScope(chunk);
    const promoteCheck = shouldPromoteChunk({
      chunk,
      type,
      scope,
      config,
      policy,
    });
    if (!promoteCheck.ok) {
      summary.skipped_not_durable += 1;
      continue;
    }

    const existing = getExistingRows(scope);
    const exact = findExactDuplicate(existing, normalized, scope);
    if (exact) {
      if (!dryRun) {
        upsertCurrentMemory(db, {
          ...exact,
          source_layer: exact.source_path ? String(exact.source_layer || 'native') : 'promoted_native',
          source_path: exact.source_path || String(chunk.source_path || ''),
          source_line: exact.source_line || Number(chunk.line_start || 0) || null,
          updated_at: exact.updated_at || chunk.last_seen_at || new Date().toISOString(),
        });
        linkChunk.run(String(exact.memory_id || exact.id || ''), String(chunk.chunk_id || ''));
      }
      summary.linked_existing += 1;
      summary.skipped_exact_duplicate += 1;
      continue;
    }

    const semantic = findSemanticDuplicate(existing, content, scope, type, config);
    if (semantic && semantic.similarity >= Number(semantic.thresholds.auto)) {
      if (!dryRun) {
        upsertCurrentMemory(db, {
          ...semantic.row,
          source_layer: semantic.row.source_path ? String(semantic.row.source_layer || 'native') : 'promoted_native',
          source_path: semantic.row.source_path || String(chunk.source_path || ''),
          source_line: semantic.row.source_line || Number(chunk.line_start || 0) || null,
          updated_at: semantic.row.updated_at || chunk.last_seen_at || new Date().toISOString(),
        });
        linkChunk.run(String(semantic.row.memory_id || semantic.row.id || ''), String(chunk.chunk_id || ''));
      }
      summary.linked_existing += 1;
      summary.skipped_semantic_duplicate += 1;
      continue;
    }

    const memoryId = randomUUID();
    const rowPayload = {
      memory_id: memoryId,
      type,
      content,
      normalized,
      source: 'promoted_native',
      source_layer: 'promoted_native',
      source_path: String(chunk.source_path || ''),
      source_line: Number(chunk.line_start || 0) || null,
      confidence: promoteCheck.confidence,
      scope,
      status: 'active',
      value_score: Number(promoteCheck?.value?.value_score ?? 0.82),
      value_label: String(promoteCheck?.value?.value_label || 'core'),
      created_at: chunk.first_seen_at || new Date().toISOString(),
      updated_at: chunk.last_seen_at || new Date().toISOString(),
    };
    const row = dryRun ? rowPayload : upsertCurrentMemory(db, rowPayload);
    if (!dryRun) {
      linkChunk.run(memoryId, String(chunk.chunk_id || ''));
    }
    existing.push(row);
    summary.promoted_inserted += 1;
    summary.promoted_ids.push(memoryId);
  }

  return summary;
};

export {
  inferChunkScope,
  inferChunkType,
  promoteNativeChunks,
};
