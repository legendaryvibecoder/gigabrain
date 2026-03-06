import { randomUUID } from 'node:crypto';

import { appendEvent } from './event-store.js';
import { listCurrentMemories, upsertCurrentMemory } from './projection-store.js';
import { jaccardSimilarity, normalizeContent, resolvePolicy, detectJunk, detectPlausibility, resolveSemanticThresholds } from './policy.js';
import { appendQueueRow } from './review-queue.js';

const createMemoryNoteRe = () => /<memory_note\b(?=[^>]*=)([^>]*)>([\s\S]*?)<\/memory_note>/gi;
const MEMORY_NOTE_ATTR_RE = /([a-zA-Z_][\w-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

const normalizeType = (value) => {
  const key = String(value || '').trim().toUpperCase();
  if (!key) return 'CONTEXT';
  if (key === 'FACT' || key === 'USERFACT') return 'USER_FACT';
  if (['USER_FACT', 'PREFERENCE', 'DECISION', 'ENTITY', 'EPISODE', 'AGENT_IDENTITY', 'CONTEXT'].includes(key)) return key;
  return 'CONTEXT';
};

const inferTypeFromContent = (content) => {
  const text = String(content || '').trim();
  if (!text) return 'CONTEXT';
  if (/\b(?:user|owner)\s+(?:likes?|loves?|prefers?|dislikes?|hates?)\b/i.test(text)) return 'PREFERENCE';
  if (/\b(?:my personality|agent identity|agent evolution)\b/i.test(text)) return 'AGENT_IDENTITY';
  if (/\b(?:decided|decision|we will|we should|always)\b/i.test(text)) return 'DECISION';
  if (/\b(?:met|happened|today|yesterday|tomorrow)\b/i.test(text)) return 'EPISODE';
  return 'USER_FACT';
};

const parseAttributes = (raw) => {
  const attrs = {};
  const source = String(raw || '');
  let match = MEMORY_NOTE_ATTR_RE.exec(source);
  while (match) {
    const key = String(match[1] || '').trim().toLowerCase();
    const value = String(match[3] ?? match[4] ?? match[5] ?? '').trim();
    if (key) attrs[key] = value;
    match = MEMORY_NOTE_ATTR_RE.exec(source);
  }
  MEMORY_NOTE_ATTR_RE.lastIndex = 0;
  return attrs;
};

const DEFAULT_CONFIDENCE = 0.65;

const parseConfidence = (raw) => {
  if (raw == null) return DEFAULT_CONFIDENCE;
  const value = String(raw).trim().toLowerCase();
  if (!value) return DEFAULT_CONFIDENCE;
  const num = Number(value);
  if (Number.isFinite(num)) return clamp01(num);
  if (value === 'high') return 0.9;
  if (value === 'medium') return 0.7;
  if (value === 'low') return 0.4;
  return DEFAULT_CONFIDENCE;
};

const parseMemoryNotes = (inputText) => {
  const text = String(inputText || '');
  const notes = [];
  const MEMORY_NOTE_RE = createMemoryNoteRe();
  let match = MEMORY_NOTE_RE.exec(text);
  while (match) {
    const attrs = parseAttributes(match[1] || '');
    const type = normalizeType(attrs.type || '');
    const content = String(match[2] || '').replace(/\s+/g, ' ').trim();
    const confidence = parseConfidence(attrs.confidence);
    const nestedTag = /<\/?memory_note\b/i.test(content);
    if (content && !nestedTag && content.length <= 1200) {
      notes.push({
        type: type || inferTypeFromContent(content),
        content,
        confidence,
        scope: attrs.scope || null,
      });
    }
    match = MEMORY_NOTE_RE.exec(text);
  }
  return notes;
};

const MAX_QUEUE_EXCERPT_CHARS = 280;

const valueToText = (value, depth = 0) => {
  if (depth > 5 || value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => valueToText(item, depth + 1))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value === 'object') {
    const record = value;
    const preferredKeys = ['text', 'content', 'output_text', 'message', 'response', 'output', 'result', 'final'];
    const parts = [];
    for (const key of preferredKeys) {
      if (!(key in record)) continue;
      const piece = valueToText(record[key], depth + 1);
      if (piece) parts.push(piece);
    }
    if (parts.length > 0) return parts.join('\n');
    try {
      return JSON.stringify(record);
    } catch {
      return String(record);
    }
  }
  return '';
};

const extractCandidateText = (event = {}) => {
  const parts = [];
  const seen = new Set();
  const pushPart = (value) => {
    const text = valueToText(value)
      .replace(/\r/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    parts.push(text);
  };

  pushPart(event?.text);
  pushPart(event?.output);
  pushPart(event?.response);
  pushPart(event?.result);
  pushPart(event?.final);

  if (Array.isArray(event?.messages)) {
    for (const msg of event.messages) {
      const role = String(msg?.role || msg?.author || '').toLowerCase();
      if (role && role !== 'assistant' && role !== 'model') continue;
      pushPart(msg?.content ?? msg?.text ?? msg?.output);
    }
  }

  return parts.join('\n').trim();
};

const shouldQueueNoNotes = (event = {}, sourceText = '') => {
  const text = String(sourceText || '');
  if (/\<memory_note\b/i.test(text)) return 'capture_note_parse_failed';

  const flags = [
    event?.llmUnavailable,
    event?.modelUnavailable,
    event?.memoryExtractionUnavailable,
    event?.meta?.llmUnavailable,
    event?.meta?.modelUnavailable,
    event?.metadata?.llmUnavailable,
    event?.metadata?.modelUnavailable,
  ];
  return flags.some((flag) => flag === true) ? 'llm_unavailable' : '';
};

const buildQueueExcerpt = (event = {}, sourceText = '') => {
  const compact = String(sourceText || '').replace(/\s+/g, ' ').trim();
  if (compact) return compact.slice(0, MAX_QUEUE_EXCERPT_CHARS);
  const fallback = valueToText(event).replace(/\s+/g, ' ').trim();
  return fallback.slice(0, MAX_QUEUE_EXCERPT_CHARS);
};

const findExactDuplicate = (existingRows, normalized, scope) => {
  const key = `${String(scope || 'shared')}|${normalized}`;
  for (const row of existingRows) {
    const rowKey = `${String(row.scope || 'shared')}|${String(row.normalized || '')}`;
    if (rowKey === key && String(row.status || 'active') === 'active') return row;
  }
  return null;
};

const findSemanticDuplicate = (existingRows, content, scope, type) => {
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
  return best;
};

const queueReasonCode = (reason) => {
  if (reason === 'llm_unavailable') return 'llm_unavailable';
  if (reason === 'capture_note_parse_failed') return 'capture_parse_failed';
  if (reason === 'semantic_borderline') return 'duplicate_semantic';
  return 'capture_review_required';
};

const captureFromEvent = ({
  db,
  config,
  event = {},
  logger,
  runId,
  reviewVersion = '',
}) => {
  const policy = resolvePolicy(config);
  const scope = String(event.scope || event.agentId || 'shared').trim() || 'shared';
  const sourceText = extractCandidateText(event);
  const notes = parseMemoryNotes(sourceText);
  const nowIso = new Date().toISOString();
  const cleanupVersion = String(config?.runtime?.cleanupVersion || 'v3.0.0');
  const queuePath = String(config?.runtime?.paths?.reviewQueuePath || '').trim();
  const existing = listCurrentMemories(db, { statuses: ['active'], scope, limit: 5000 });

  const summary = {
    processed: 0,
    inserted: 0,
    rejected_junk: 0,
    dropped_exact_duplicate: 0,
    dropped_semantic_duplicate: 0,
    queued_review: 0,
    inserted_ids: [],
  };

  if (notes.length === 0) {
    const missingReason = shouldQueueNoNotes(event, sourceText);
    if (missingReason && config?.capture?.queueOnModelUnavailable !== false) {
      const row = {
        timestamp: nowIso,
        status: 'pending',
        reason: missingReason,
        reason_code: queueReasonCode(missingReason),
        action: 'capture_review',
        payload: {
          source: 'agent_end',
          excerpt: buildQueueExcerpt(event, sourceText),
        },
      };
      appendQueueRow(queuePath, row, {
        retentionConfig: config?.runtime?.reviewQueueRetention,
      });
      summary.queued_review += 1;
      logger?.warn?.(`[gigabrain] capture queued reason=${missingReason} scope=${scope}`);
    }
    return summary;
  }

  for (const note of notes) {
    summary.processed += 1;
    const content = String(note.content || '').trim();
    const type = normalizeType(note.type || inferTypeFromContent(content));
    const noteScope = note.scope ? String(note.scope).trim() : scope;
    const normalized = normalizeContent(content);
    const junk = detectJunk(content, {
      minChars: Math.max(1, Number(config?.capture?.minContentChars ?? policy.minContentChars)),
      junkPatterns: policy.junkPatterns,
      highValueShortEnabled: policy.highValueShortEnabled,
      highValueShortPatterns: policy.highValueShortPatterns,
    });

    if (junk.junk && config?.quality?.junkFilterEnabled !== false) {
      summary.rejected_junk += 1;
      appendEvent(db, {
        timestamp: nowIso,
        component: 'capture',
        action: 'capture_rejected',
        reason_codes: [junk.reason || 'junk_system_prompt'],
        memory_id: `candidate:${randomUUID()}`,
        cleanup_version: cleanupVersion,
        run_id: runId || '',
        review_version: reviewVersion || '',
        payload: {
          content,
          matched_pattern: junk.matchedPattern || null,
          scope,
          type,
        },
      });
      continue;
    }

    const exact = findExactDuplicate(existing, normalized, noteScope);
    if (exact) {
      summary.dropped_exact_duplicate += 1;
      appendEvent(db, {
        timestamp: nowIso,
        component: 'capture',
        action: 'capture_dropped_exact_duplicate',
        reason_codes: ['duplicate_exact'],
        memory_id: String(exact.memory_id || exact.id),
        cleanup_version: cleanupVersion,
        run_id: runId || '',
        review_version: reviewVersion || '',
        payload: {
          candidate_content: content,
          matched_memory_id: String(exact.memory_id || exact.id),
        },
      });
      continue;
    }

    if (config?.dedupe?.semanticEnabled !== false) {
      const semantic = findSemanticDuplicate(existing, content, noteScope, type);
      const semanticThresholds = resolveSemanticThresholds(type, config);
      if (semantic && semantic.similarity >= Number(semanticThresholds.auto)) {
        summary.dropped_semantic_duplicate += 1;
        appendEvent(db, {
          timestamp: nowIso,
          component: 'capture',
          action: 'capture_dropped_semantic_duplicate',
          reason_codes: ['duplicate_semantic'],
          memory_id: String(semantic.row.memory_id || semantic.row.id),
          cleanup_version: cleanupVersion,
          run_id: runId || '',
          review_version: reviewVersion || '',
          similarity: semantic.similarity,
          matched_memory_id: String(semantic.row.memory_id || semantic.row.id),
          payload: {
            candidate_content: content,
            matched_content: semantic.row.content,
            scope: noteScope,
          },
        });
        continue;
      }
      if (semantic && semantic.similarity >= Number(semanticThresholds.review)) {
        summary.queued_review += 1;
        appendQueueRow(queuePath, {
          timestamp: nowIso,
          status: 'auto_rejected',
          reason: 'semantic_borderline',
          reason_code: queueReasonCode('semantic_borderline'),
          action: 'capture_review',
          similarity: semantic.similarity,
          matched_memory_id: String(semantic.row.memory_id || semantic.row.id),
          payload: {
            type,
            content,
            scope,
          },
        }, {
          retentionConfig: config?.runtime?.reviewQueueRetention,
        });
        appendEvent(db, {
          timestamp: nowIso,
          component: 'capture',
          action: 'capture_queued_review',
          reason_codes: ['duplicate_semantic'],
          memory_id: String(semantic.row.memory_id || semantic.row.id),
          cleanup_version: cleanupVersion,
          run_id: runId || '',
          review_version: reviewVersion || '',
          similarity: semantic.similarity,
          matched_memory_id: String(semantic.row.memory_id || semantic.row.id),
          payload: {
            candidate_content: content,
            scope: noteScope,
          },
        });
        continue;
      }
    }

    const plausibility = detectPlausibility({
      type,
      content,
      confidence: note.confidence,
    }, policy);
    if (
      type === 'USER_FACT'
      && Number(note.confidence ?? config?.capture?.minConfidence ?? 0.65) < 0.7
      && plausibility.actionableCount > 0
    ) {
      summary.queued_review += 1;
      appendQueueRow(queuePath, {
        timestamp: nowIso,
        status: 'pending',
        reason: 'capture_review_required',
        reason_code: queueReasonCode('capture_review_required'),
        action: 'capture_review',
        payload: {
          type,
          content,
          scope: noteScope,
          plausibility_flags: plausibility.flags,
          matched_pattern: plausibility.matchedPattern,
        },
      }, {
        retentionConfig: config?.runtime?.reviewQueueRetention,
      });
      appendEvent(db, {
        timestamp: nowIso,
        component: 'capture',
        action: 'capture_queued_review',
        reason_codes: ['capture_review_required', 'plausibility_flag'],
        memory_id: `candidate:${randomUUID()}`,
        cleanup_version: cleanupVersion,
        run_id: runId || '',
        review_version: reviewVersion || '',
        payload: {
          type,
          scope: noteScope,
          content,
          plausibility_flags: plausibility.flags,
          matched_pattern: plausibility.matchedPattern,
        },
      });
      continue;
    }

    const memoryId = randomUUID();
    const row = upsertCurrentMemory(db, {
      memory_id: memoryId,
      type,
      content,
      normalized,
      source: 'capture',
      source_agent: event.agentId || null,
      source_session: event.sessionKey || null,
      confidence: Number.isFinite(Number(note.confidence))
        ? clamp01(note.confidence)
        : Number(config?.capture?.minConfidence ?? 0.65),
      scope: noteScope,
      status: 'active',
      created_at: nowIso,
      updated_at: nowIso,
    });
    existing.push(row);
    summary.inserted += 1;
    summary.inserted_ids.push(memoryId);
    appendEvent(db, {
      timestamp: nowIso,
      component: 'capture',
      action: 'capture_inserted',
      reason_codes: ['capture_success'],
      memory_id: memoryId,
      cleanup_version: cleanupVersion,
      run_id: runId || '',
      review_version: reviewVersion || '',
      payload: {
        type,
        scope: noteScope,
        source: 'agent_end',
      },
    });
  }

  logger?.info?.(`[gigabrain] capture processed=${summary.processed} inserted=${summary.inserted} junk=${summary.rejected_junk} exact=${summary.dropped_exact_duplicate} semantic=${summary.dropped_semantic_duplicate} queued=${summary.queued_review}`);
  return summary;
};

export {
  parseMemoryNotes,
  inferTypeFromContent,
  captureFromEvent,
};
