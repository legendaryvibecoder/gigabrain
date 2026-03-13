import { randomUUID } from 'node:crypto';

import { appendEvent } from './event-store.js';
import { getCurrentMemory, listCurrentMemories, updateCurrentStatus, upsertCurrentMemory } from './projection-store.js';
import { appendQueueRow } from './review-queue.js';
import { classifyValue, jaccardSimilarity, normalizeContent, resolvePolicy } from './policy.js';
import { writeNativeMemoryEntry } from './native-memory.js';

const MEMORY_ACTION_RE = /<(memory_action|memory_note)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
const MEMORY_ACTION_ATTR_RE = /([a-zA-Z_][\w-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
const VALID_ACTIONS = new Set(['remember', 'update', 'replace', 'forget', 'protect', 'do_not_store']);
const DEFAULT_CONFIDENCE = 0.65;
const REMEMBER_NATIVE_ONLY_RE = /\b(?:today|tonight|this morning|this afternoon|this evening|right now|currently|for now|temporary|temporarily|tired|hungry|busy)\b/i;
const AMBIGUOUS_DELTA = 0.08;
const MIN_TARGET_SCORE = 0.72;
const ACTION_REVIEW_REASON = 'memory_action_review';

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
  if (/\b(?:user|owner|chris)\s+(?:likes?|loves?|prefers?|dislikes?|hates?)\b/i.test(text)) return 'PREFERENCE';
  if (/\b(?:my personality|agent identity|agent evolution)\b/i.test(text)) return 'AGENT_IDENTITY';
  if (/\b(?:decided|decision|we will|we should|always)\b/i.test(text)) return 'DECISION';
  if (/\b(?:met|happened|today|yesterday|tomorrow|interview|meeting)\b/i.test(text)) return 'EPISODE';
  return 'USER_FACT';
};

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

const normalizeDurability = (raw) => {
  const value = String(raw || '').trim().toLowerCase();
  if (value === 'durable') return 'durable';
  if (value === 'ephemeral') return 'ephemeral';
  return 'auto';
};

const parseAttributes = (raw) => {
  const attrs = {};
  const source = String(raw || '');
  let match = MEMORY_ACTION_ATTR_RE.exec(source);
  while (match) {
    const key = String(match[1] || '').trim().toLowerCase();
    const value = String(match[3] ?? match[4] ?? match[5] ?? '').trim();
    if (key) attrs[key] = value;
    match = MEMORY_ACTION_ATTR_RE.exec(source);
  }
  MEMORY_ACTION_ATTR_RE.lastIndex = 0;
  return attrs;
};

const normalizeAction = (value) => {
  const key = String(value || '').trim().toLowerCase();
  if (!VALID_ACTIONS.has(key)) return '';
  return key;
};

const normalizeScope = (value, fallback = 'shared') => String(value || fallback).trim() || fallback;

const scopeAllowsMemoryMd = (scope = '') => {
  const key = String(scope || '').trim().toLowerCase();
  if (!key || key === 'shared') return false;
  if (key.startsWith('profile:')) return true;
  return key.includes('main') || key.includes('dm') || key.includes('private');
};

const parseMemoryActions = (inputText = '') => {
  const text = String(inputText || '');
  const actions = [];
  let match = MEMORY_ACTION_RE.exec(text);
  while (match) {
    const tagName = String(match[1] || '').trim().toLowerCase();
    const attrs = parseAttributes(match[2] || '');
    const action = normalizeAction(attrs.action || (tagName === 'memory_action' ? 'remember' : ''));
    if (!action) {
      match = MEMORY_ACTION_RE.exec(text);
      continue;
    }
    const content = String(match[3] || '').replace(/\s+/g, ' ').trim();
    if (/<\/?memory_(?:action|note)\b/i.test(content)) {
      match = MEMORY_ACTION_RE.exec(text);
      continue;
    }
    actions.push({
      action,
      type: normalizeType(attrs.type || inferTypeFromContent(content)),
      content,
      confidence: parseConfidence(attrs.confidence),
      durability: normalizeDurability(attrs.durability || attrs.store || ''),
      scope: attrs.scope || null,
      target: String(attrs.target || attrs.target_text || attrs.memory || '').trim(),
      target_memory_id: String(attrs.target_memory_id || attrs.memory_id || attrs.target_id || '').trim(),
      raw_tag: tagName,
    });
    match = MEMORY_ACTION_RE.exec(text);
  }
  MEMORY_ACTION_RE.lastIndex = 0;
  return actions;
};

const queueReasonCode = (reason) => {
  if (reason === ACTION_REVIEW_REASON) return 'memory_action_review';
  return 'memory_action_review';
};

const shellEscapeSingle = (value = '') => String(value || '').replace(/'/g, `'\\''`);

const buildSuggestedCommands = ({ action = {}, scope = '', candidates = [] } = {}) => {
  const content = String(action.content || '').trim();
  const base = ['node scripts/gigabrainctl.js control apply'];
  base.push(`--action ${String(action.action || '').trim()}`);
  if (scope) base.push(`--scope '${shellEscapeSingle(scope)}'`);
  if (action.type) base.push(`--type ${String(action.type || '').trim()}`);
  if (action.confidence != null && String(action.confidence).trim()) {
    base.push(`--confidence ${String(action.confidence).trim()}`);
  }
  if (content) base.push(`--content '${shellEscapeSingle(content)}'`);
  const commands = [];
  for (const row of candidates.slice(0, 3)) {
    const memoryId = String(row.memory_id || row.id || '').trim();
    if (!memoryId) continue;
    commands.push(`${base.join(' ')} --target-memory-id ${memoryId}`);
  }
  if (commands.length === 0 && action.target) {
    commands.push(`${base.join(' ')} --target '${shellEscapeSingle(String(action.target || ''))}'`);
  }
  return commands;
};

const mergeTags = (base = [], extra = []) => {
  const out = [];
  const seen = new Set();
  for (const item of [...(Array.isArray(base) ? base : []), ...(Array.isArray(extra) ? extra : [])]) {
    const normalized = String(item || '').trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
};

const isDurableNote = ({ type, content, confidence, scope }, policy = {}) => {
  const normalizedType = normalizeType(type);
  if (['PREFERENCE', 'DECISION', 'AGENT_IDENTITY'].includes(normalizedType)) return true;
  if (normalizedType === 'CONTEXT' || normalizedType === 'EPISODE') return false;
  const classified = classifyValue({
    type: normalizedType,
    content,
    confidence,
    scope,
    status: 'active',
    updated_at: new Date().toISOString(),
  }, policy);
  const hasPlausibilityFlag = Boolean(
    classified?.plausibility?.flags?.token_anomaly
    || classified?.plausibility?.flags?.broken_phrase_pattern
    || classified?.plausibility?.flags?.entityless_numeric_fact
  );
  return classified?.action === 'keep' && hasPlausibilityFlag === false;
};

const decideNativeDurability = ({ type, content, confidence, scope, policy }) => {
  if (normalizeType(type) === 'CONTEXT' || normalizeType(type) === 'EPISODE' || REMEMBER_NATIVE_ONLY_RE.test(String(content || ''))) {
    return false;
  }
  return isDurableNote({ type, content, confidence, scope }, policy) && scopeAllowsMemoryMd(scope);
};

const scoreTargetCandidate = (row, { targetText = '', targetType = '', scope = '', sessionKey = '' } = {}) => {
  const scopeMatch = String(row.scope || '') === String(scope || '');
  const typeMatch = !targetType || String(row.type || '') === String(targetType || '');
  const content = String(row.content || row.normalized || '');
  const similarity = jaccardSimilarity(String(targetText || ''), content);
  const exact = normalizeContent(targetText) === normalizeContent(content);
  const sessionBoost = sessionKey && String(row.source_session || '') === String(sessionKey) ? 0.12 : 0;
  const updatedMs = Date.parse(String(row.updated_at || row.created_at || ''));
  const recencyBoost = Number.isFinite(updatedMs)
    ? Math.max(0, 0.08 - (Math.max(0, Date.now() - updatedMs) / (1000 * 60 * 60 * 24 * 30)) * 0.08)
    : 0;
  const score = similarity
    + (exact ? 0.25 : 0)
    + (scopeMatch ? 0.12 : 0)
    + (typeMatch ? 0.07 : 0)
    + sessionBoost
    + recencyBoost;
  return {
    row,
    similarity,
    score,
    exact,
  };
};

const resolveActionTarget = ({ existingRows = [], action = {}, scope = '', sessionKey = '' } = {}) => {
  const targetMemoryId = String(action.target_memory_id || '').trim();
  if (targetMemoryId) {
    const direct = existingRows.find((row) => String(row.memory_id || row.id || '') === targetMemoryId);
    if (direct) {
      return {
        matched: true,
        ambiguous: false,
        row: direct,
        score: 1,
        candidates: [direct],
        reason: 'target_memory_id',
      };
    }
  }

  const targetText = String(action.target || '').trim();
  if (!targetText) {
    return {
      matched: false,
      ambiguous: false,
      row: null,
      score: 0,
      candidates: [],
      reason: 'missing_target',
    };
  }

  const candidates = existingRows
    .filter((row) => String(row.status || 'active') === 'active')
    .map((row) => scoreTargetCandidate(row, {
      targetText,
      targetType: action.type,
      scope,
      sessionKey,
    }))
    .filter((item) => item.score >= 0.45)
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    return {
      matched: false,
      ambiguous: false,
      row: null,
      score: 0,
      candidates: [],
      reason: 'no_match',
    };
  }

  const best = candidates[0];
  const second = candidates[1];
  const ambiguous = Boolean(
    second
    && (
      (best.exact && second.exact && normalizeContent(best.row.content || '') === normalizeContent(second.row.content || ''))
      || (
        best.score < 0.92
        && Math.abs(best.score - second.score) < AMBIGUOUS_DELTA
      )
    )
  );

  if (best.score < MIN_TARGET_SCORE || ambiguous) {
    return {
      matched: false,
      ambiguous,
      row: null,
      score: best.score,
      candidates: candidates.slice(0, 5).map((item) => item.row),
      reason: ambiguous ? 'ambiguous' : 'low_confidence_match',
    };
  }

  return {
    matched: true,
    ambiguous: false,
    row: best.row,
    score: best.score,
    candidates: candidates.slice(0, 5).map((item) => item.row),
    reason: best.exact ? 'exact_target' : 'semantic_target',
  };
};

const queueActionReview = ({
  queuePath,
  action,
  scope,
  reason,
  candidates = [],
  runId = '',
  retentionConfig,
} = {}) => {
  if (!queuePath) return;
  const excerpt = String(action.content || action.target || '').trim()
    || candidates.map((row) => String(row.content || '').trim()).filter(Boolean)[0]
    || '';
  appendQueueRow(queuePath, {
    timestamp: new Date().toISOString(),
    status: 'pending',
    reason,
    reason_code: queueReasonCode(reason),
    action: 'memory_action_review',
    payload: {
      requested_action: action.action,
      scope,
      content: action.content,
      excerpt,
      target: action.target || null,
      target_memory_id: action.target_memory_id || null,
      candidates: candidates.slice(0, 5).map((row) => ({
        memory_id: String(row.memory_id || row.id || ''),
        type: String(row.type || ''),
        scope: String(row.scope || ''),
        content: String(row.content || ''),
      })),
      suggested_commands: buildSuggestedCommands({
        action,
        scope,
        candidates,
      }),
      run_id: runId,
    },
  }, {
    retentionConfig,
  });
};

const writeNativeForAction = ({
  config,
  memoryId = '',
  type = 'CONTEXT',
  content = '',
  durable = false,
  timestamp = new Date().toISOString(),
  scope = '',
} = {}) => {
  const result = writeNativeMemoryEntry({
    config,
    memoryId,
    type,
    content,
    durable,
    timestamp,
    scope,
  });
  return {
    result,
    counters: {
      native_written: result?.written ? 1 : 0,
      native_daily_writes: result?.written && result.source_kind !== 'memory_md' ? 1 : 0,
      native_memory_writes: result?.written && result.source_kind === 'memory_md' ? 1 : 0,
    },
  };
};

const applyReplacement = ({
  db,
  config,
  action,
  targetRow,
  scope,
  runId,
  reviewVersion,
  logger,
}) => {
  const nowIso = new Date().toISOString();
  const policy = resolvePolicy(config);
  const content = String(action.content || '').trim();
  if (!content) {
    return {
      queued_review: 1,
      reason: 'missing_replacement_content',
    };
  }
  if (normalizeContent(content) === normalizeContent(targetRow.content || '')) {
    appendEvent(db, {
      timestamp: nowIso,
      component: 'capture',
      action: 'memory_action_noop',
      reason_codes: ['action_noop'],
      memory_id: String(targetRow.memory_id),
      cleanup_version: String(config?.runtime?.cleanupVersion || 'v3.0.0'),
      run_id: runId || '',
      review_version: reviewVersion || '',
      payload: {
        requested_action: action.action,
        target_memory_id: String(targetRow.memory_id),
      },
    });
    return {
      applied: 1,
      noop: 1,
    };
  }

  const type = normalizeType(action.type || targetRow.type || inferTypeFromContent(content));
  const confidence = Number.isFinite(Number(action.confidence)) ? clamp01(action.confidence) : Number(targetRow.confidence || DEFAULT_CONFIDENCE);
  const durable = decideNativeDurability({
    type,
    content,
    confidence,
    scope,
    policy,
  });
  const newMemoryId = randomUUID();
  const nativeWrite = config?.capture?.rememberIntent?.writeNative === false
    ? { result: null, counters: { native_written: 0, native_daily_writes: 0, native_memory_writes: 0 } }
    : writeNativeForAction({
      config,
      memoryId: newMemoryId,
      type,
      content,
      durable,
      timestamp: nowIso,
      scope,
    });

  const inheritedTags = mergeTags(targetRow.tags, ['updated']);
  upsertCurrentMemory(db, {
    memory_id: newMemoryId,
    type,
    content,
    normalized: normalizeContent(content),
    source: 'memory_action',
    source_agent: targetRow.source_agent || null,
    source_session: targetRow.source_session || null,
    source_layer: nativeWrite.result?.source_path ? 'native' : 'registry',
    source_path: nativeWrite.result?.source_path || null,
    source_line: nativeWrite.result?.source_line ?? null,
    confidence,
    scope,
    status: 'active',
    created_at: nowIso,
    updated_at: nowIso,
    tags: inheritedTags,
    superseded_by: null,
  });
  updateCurrentStatus(db, targetRow.memory_id, 'superseded', {
    timestamp: nowIso,
    superseded_by: newMemoryId,
    last_reviewed_at: nowIso,
  });

  appendEvent(db, {
    timestamp: nowIso,
    component: 'capture',
    action: action.action === 'replace' ? 'memory_action_replace' : 'memory_action_update',
    reason_codes: ['memory_action'],
    memory_id: newMemoryId,
    cleanup_version: String(config?.runtime?.cleanupVersion || 'v3.0.0'),
    run_id: runId || '',
    review_version: reviewVersion || '',
    matched_memory_id: String(targetRow.memory_id),
    payload: {
      requested_action: action.action,
      target_memory_id: String(targetRow.memory_id),
      source_layer: nativeWrite.result?.source_path ? 'native' : 'registry',
    },
  });
  logger?.info?.(`[gigabrain] memory action ${action.action} target=${targetRow.memory_id} new=${newMemoryId}`);
  return {
    applied: 1,
    inserted: 1,
    superseded: 1,
    inserted_ids: [newMemoryId],
    ...nativeWrite.counters,
  };
};

const applyForget = ({
  db,
  config,
  action,
  targetRow,
  runId,
  reviewVersion,
}) => {
  const nowIso = new Date().toISOString();
  updateCurrentStatus(db, targetRow.memory_id, 'rejected', {
    timestamp: nowIso,
    last_reviewed_at: nowIso,
  });
  appendEvent(db, {
    timestamp: nowIso,
    component: 'capture',
    action: 'memory_action_forget',
    reason_codes: ['memory_action'],
    memory_id: String(targetRow.memory_id),
    cleanup_version: String(config?.runtime?.cleanupVersion || 'v3.0.0'),
    run_id: runId || '',
    review_version: reviewVersion || '',
    payload: {
      requested_action: action.action,
    },
  });
  return {
    applied: 1,
    rejected: 1,
  };
};

const applyProtect = ({
  db,
  config,
  targetRow,
  runId,
  reviewVersion,
}) => {
  const nowIso = new Date().toISOString();
  const current = getCurrentMemory(db, targetRow.memory_id);
  if (!current) {
    return {
      queued_review: 1,
      reason: 'protect_target_missing',
    };
  }
  const tags = mergeTags(current.tags, ['protected']);
  upsertCurrentMemory(db, {
    ...current,
    tags,
    updated_at: nowIso,
  });
  appendEvent(db, {
    timestamp: nowIso,
    component: 'capture',
    action: 'memory_action_protect',
    reason_codes: ['memory_action', 'protected'],
    memory_id: String(targetRow.memory_id),
    cleanup_version: String(config?.runtime?.cleanupVersion || 'v3.0.0'),
    run_id: runId || '',
    review_version: reviewVersion || '',
    payload: {
      protected: true,
    },
  });
  return {
    applied: 1,
    protected: 1,
  };
};

const applyMemoryActions = ({
  db,
  config,
  event = {},
  actions = [],
  logger,
  runId = '',
  reviewVersion = '',
} = {}) => {
  const scope = normalizeScope(event.scope || event.agentId || 'shared');
  const queuePath = String(config?.runtime?.paths?.reviewQueuePath || '').trim();
  const summary = {
    processed: 0,
    applied: 0,
    queued_review: 0,
    inserted: 0,
    superseded: 0,
    rejected: 0,
    protected: 0,
    noop: 0,
    do_not_store: 0,
    inserted_ids: [],
    native_written: 0,
    native_daily_writes: 0,
    native_memory_writes: 0,
    blocked: false,
  };
  const relevantActions = Array.isArray(actions)
    ? actions.filter((action) => action && action.action && action.action !== 'remember')
    : [];
  if (relevantActions.length === 0) return summary;

  let existingRows = listCurrentMemories(db, { statuses: ['active'], limit: 10000 });
  const sessionKey = String(event.sessionKey || '').trim();

  for (const action of relevantActions) {
    summary.processed += 1;
    if (action.action === 'do_not_store') {
      summary.applied += 1;
      summary.do_not_store += 1;
      summary.blocked = true;
      appendEvent(db, {
        timestamp: new Date().toISOString(),
        component: 'capture',
        action: 'memory_action_do_not_store',
        reason_codes: ['memory_action', 'do_not_store'],
        memory_id: `action:${randomUUID()}`,
        cleanup_version: String(config?.runtime?.cleanupVersion || 'v3.0.0'),
        run_id: runId || '',
        review_version: reviewVersion || '',
        payload: {
          scope,
        },
      });
      break;
    }

    const resolution = resolveActionTarget({
      existingRows,
      action,
      scope: normalizeScope(action.scope || scope),
      sessionKey,
    });
    if (!resolution.matched) {
      summary.queued_review += 1;
      queueActionReview({
        queuePath,
        action,
        scope,
        reason: ACTION_REVIEW_REASON,
        candidates: resolution.candidates,
        runId,
        retentionConfig: config?.runtime?.reviewQueueRetention,
      });
      appendEvent(db, {
        timestamp: new Date().toISOString(),
        component: 'capture',
        action: 'memory_action_review_queued',
        reason_codes: ['memory_action_review'],
        memory_id: `action:${randomUUID()}`,
        cleanup_version: String(config?.runtime?.cleanupVersion || 'v3.0.0'),
        run_id: runId || '',
        review_version: reviewVersion || '',
        payload: {
          requested_action: action.action,
          reason: resolution.reason,
          target: action.target || null,
          target_memory_id: action.target_memory_id || null,
        },
      });
      continue;
    }

    const targetRow = resolution.row;
    let result = {};
    if (action.action === 'update' || action.action === 'replace') {
      result = applyReplacement({
        db,
        config,
        action,
        targetRow,
        scope: normalizeScope(action.scope || targetRow.scope || scope),
        runId,
        reviewVersion,
        logger,
      });
    } else if (action.action === 'forget') {
      result = applyForget({
        db,
        config,
        action,
        targetRow,
        runId,
        reviewVersion,
      });
    } else if (action.action === 'protect') {
      result = applyProtect({
        db,
        config,
        targetRow,
        runId,
        reviewVersion,
      });
    }

    summary.applied += Number(result.applied || 0);
    summary.queued_review += Number(result.queued_review || 0);
    summary.inserted += Number(result.inserted || 0);
    summary.superseded += Number(result.superseded || 0);
    summary.rejected += Number(result.rejected || 0);
    summary.protected += Number(result.protected || 0);
    summary.noop += Number(result.noop || 0);
    summary.native_written += Number(result.native_written || 0);
    summary.native_daily_writes += Number(result.native_daily_writes || 0);
    summary.native_memory_writes += Number(result.native_memory_writes || 0);
    if (Array.isArray(result.inserted_ids)) {
      summary.inserted_ids.push(...result.inserted_ids);
      existingRows = listCurrentMemories(db, { statuses: ['active'], limit: 10000 });
    }
  }

  return summary;
};

export {
  parseMemoryActions,
  applyMemoryActions,
};
