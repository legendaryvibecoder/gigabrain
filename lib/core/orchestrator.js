import { detectTemporalWindow, estimateTokens, recallForQuery, sanitizeRecallQuery } from './recall-service.js';
import {
  ensureWorldModelReady,
  findEntityMatches,
  getEntityDetail,
  listContradictions,
  listOpenLoops,
} from './world-model.js';

const SOURCE_REQUEST_RE = /\b(?:source|quelle|where is this written|written|wo steht das|which file|welche datei|show me the source|zeig mir die quelle)\b/i;
const EXACT_WORDING_RE = /\b(?:exact|verbatim|wording|wortlaut|quoted|quote|literal)\b/i;
const DATE_REQUEST_RE = /\b(?:exact date|exactly when|wann genau|welches datum|date exactly)\b/i;
const ENTITY_QUERY_RE = /\b(?:who is|who was|tell me about|what do you know about|wer ist|wer war|was weißt du über|was weisst du ueber|about|über|ueber)\b/i;
const RELATIONSHIP_QUERY_RE = /\b(?:relationship|partner|wife|husband|girlfriend|boyfriend|freund(?:in)?|partnerin|beziehung)\b/i;
const CONTRADICTION_QUERY_RE = /\b(?:conflict|contradiction|unsure|not sure|widerspruch|unsicher|stimmt das noch)\b/i;
const TEMPORAL_QUERY_RE = /\b(?:when|timeline|happened|passiert|january|jan|february|feb|march|mar|april|apr|may|mai|june|jun|july|jul|august|aug|september|sep|october|oct|november|nov|december|dec|20\d{2}|today|heute)\b/i;
const DEFAULT_LOW_CONFIDENCE_NO_BRIEF_THRESHOLD = 0.62;
const TEMPORAL_ENTITY_RE = /\b(?:january|jan|february|feb|march|mar|april|apr|may|mai|june|jun|july|jul|august|aug|september|sep|october|oct|november|nov|december|dec|today|heute)\b/i;

const esc = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;');

const buildSupportingMemoryLines = (rows = [], limit = 4) => (
  rows.slice(0, limit).map((row) => {
    const type = String(row.type || 'CONTEXT');
    const content = String(row.content || '').replace(/\s+/g, ' ').trim();
    return `- [${esc(type)}] ${esc(content)}`;
  })
);

const summarizeResultBreakdown = (rows = [], limit = 5) => (
  rows.slice(0, limit).map((row) => ({
    memory_id: String(row?.memory_id || row?.id || ''),
    type: String(row?.type || ''),
    content: String(row?.content || '').replace(/\s+/g, ' ').trim().slice(0, 180),
    score: Number(row?._score || row?.score || 0),
    base_score: Number(row?._base_score || row?._score || row?.score || 0),
    entity_lock_boost: Number(row?._entity_lock_boost || 0),
    temporal_window_boost: Number(row?._temporal_window_boost || 0),
    strategy_penalty: Number(row?._strategy_penalty || 0),
    selected_entity_match: Number(row?._selected_entity_match || 0) === 1,
    selected_entity_reason: String(row?._selected_entity_reason || '').trim() || 'none',
    temporal_window_match: Number(row?._temporal_window_match || 0) === 1,
    ranking_mode: String(row?._ranking_mode || '').trim() || 'broad',
    source: String(row?._source || '').trim() || 'active',
  }))
);

const resolveRecallProfile = ({ strategy = '', entityKind = '' } = {}) => {
  const kind = String(entityKind || '').trim().toLowerCase();
  if (strategy === 'relationship_brief') return 'relationship_profile';
  if (strategy === 'timeline_brief') return kind === 'project' || kind === 'organization' ? 'project_profile' : 'timeline_profile';
  if (strategy === 'entity_brief') {
    if (kind === 'person') return 'identity_profile';
    if (kind === 'project' || kind === 'organization') return 'project_profile';
    return 'identity_profile';
  }
  if (strategy === 'verification_lookup') return 'verification_profile';
  return 'current_state_profile';
};

const resolveReportedRankingMode = ({
  recall = {},
  strategy = '',
  topEntity = null,
  temporalWindow = null,
} = {}) => {
  const raw = String(recall?.rankingMode || '').trim();
  if (raw && raw !== 'broad') return raw;
  if (topEntity?.entity_id && ['entity_brief', 'relationship_brief', 'timeline_brief', 'contradiction_check'].includes(strategy)) {
    return `${strategy}:entity_locked`;
  }
  if (strategy === 'timeline_brief' && temporalWindow) return 'timeline_brief:temporal_window';
  if (strategy === 'verification_lookup') return 'verification_lookup';
  if (strategy === 'quick_context' && raw) return raw;
  return raw || 'broad';
};

const selectPrimaryEntityMatch = (matches = [], strategy = 'quick_context') => {
  const scored = (Array.isArray(matches) ? matches : []).map((match) => {
    let score = Number(match?.score || 0);
    const kind = String(match?.kind || '').trim().toLowerCase();
    const alias = String(match?.alias || match?.display_name || '').trim().toLowerCase();
    if (strategy === 'timeline_brief') {
      if (kind === 'topic') score -= 0.3;
      if (TEMPORAL_ENTITY_RE.test(alias)) score -= 0.45;
      if (['organization', 'project', 'person', 'place'].includes(kind)) score += 0.18;
    } else if (strategy === 'entity_brief' || strategy === 'relationship_brief') {
      if (kind === 'topic') score -= 0.2;
      if (['person', 'organization', 'project', 'place'].includes(kind)) score += 0.12;
    }
    return {
      ...match,
      _orchestrator_score: score,
    };
  });
  return scored
    .sort((a, b) => Number(b._orchestrator_score || 0) - Number(a._orchestrator_score || 0) || String(a.display_name || '').localeCompare(String(b.display_name || '')))[0]
    || null;
};

const classifyQueryIntent = (query = '') => {
  const text = String(query || '').trim();
  if (!text) return { strategy: 'quick_context', requiresDeepLookup: false, reason: 'empty' };
  if (SOURCE_REQUEST_RE.test(text) || EXACT_WORDING_RE.test(text) || DATE_REQUEST_RE.test(text)) {
    return { strategy: 'verification_lookup', requiresDeepLookup: true, reason: 'source_or_exactness' };
  }
  if (CONTRADICTION_QUERY_RE.test(text)) {
    return { strategy: 'contradiction_check', requiresDeepLookup: false, reason: 'contradiction' };
  }
  if (ENTITY_QUERY_RE.test(text) && RELATIONSHIP_QUERY_RE.test(text)) {
    return { strategy: 'relationship_brief', requiresDeepLookup: false, reason: 'relationship_entity' };
  }
  if (ENTITY_QUERY_RE.test(text)) {
    return { strategy: 'entity_brief', requiresDeepLookup: false, reason: 'entity' };
  }
  if (TEMPORAL_QUERY_RE.test(text)) {
    return { strategy: 'timeline_brief', requiresDeepLookup: false, reason: 'temporal' };
  }
  return { strategy: 'quick_context', requiresDeepLookup: false, reason: 'default' };
};

const topRecallConfidence = (recall = {}) => Number(
  recall?.results?.[0]?._score
  || recall?.results?.[0]?.score
  || 0,
);

const resolveDeepLookupReason = ({
  query = '',
  recall = {},
  topEntity = null,
  config = {},
} = {}) => {
  const text = String(query || '').trim();
  if (SOURCE_REQUEST_RE.test(text)) return 'source_request';
  if (DATE_REQUEST_RE.test(text)) return 'exact_date';
  if (EXACT_WORDING_RE.test(text)) return 'exact_wording';

  const hasUsableEntityBrief = Boolean(
    topEntity?.syntheses?.some((row) => {
      const kind = String(row?.kind || '').trim().toLowerCase();
      const content = String(row?.content || '').trim();
      return content && ['entity_brief', 'relationship_brief', 'project_brief'].includes(kind);
    }),
  );
  const lowConfidenceThreshold = Math.max(
    0.4,
    Math.min(0.95, Number(config?.orchestrator?.lowConfidenceNoBriefThreshold ?? DEFAULT_LOW_CONFIDENCE_NO_BRIEF_THRESHOLD) || DEFAULT_LOW_CONFIDENCE_NO_BRIEF_THRESHOLD),
  );
  const recallConfidence = topRecallConfidence(recall);
  const hasUsableRecall = Number(recall?.results?.length || 0) > 0 && recallConfidence >= lowConfidenceThreshold;
  if (!hasUsableEntityBrief && !hasUsableRecall) {
    return 'low_confidence_no_brief';
  }
  return 'none';
};

const buildWorldModelBlock = ({
  query,
  strategy,
  profile,
  detail,
  recall,
  deepLookupAllowed,
  deepLookupReason = '',
  contradictions = [],
  openLoops = [],
}) => {
  const lines = [];
  lines.push('<gigabrain-context>');
  lines.push(`query: ${esc(query)}`);
  lines.push(`strategy: ${strategy}`);
  lines.push(`profile: ${profile}`);
  lines.push(`deep_lookup_allowed: ${deepLookupAllowed ? 'true' : 'false'}`);
  if (deepLookupReason) lines.push(`deep_lookup_reason: ${esc(deepLookupReason)}`);
  lines.push('instruction: Prefer answering from this Gigabrain context first.');
  lines.push('instruction: Only use deeper memory verification if deep_lookup_allowed=true.');
  lines.push('instruction: Do not mention internal file paths, memory ids, source tags, or recall mechanics unless the user explicitly asks for provenance.');
  if (detail?.display_name) {
    lines.push(`entity: ${esc(detail.display_name)} (${esc(detail.kind)})`);
  }
  if (detail?.syntheses?.[0]?.content) {
    lines.push('world_model_brief:');
    for (const line of String(detail.syntheses[0].content || '').split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      lines.push(`- ${esc(trimmed.replace(/^-+\s*/, ''))}`);
    }
  }
  if (contradictions.length > 0) {
    lines.push('contradictions:');
    for (const item of contradictions.slice(0, 3)) lines.push(`- ${esc(item.title)}`);
  }
  if (openLoops.length > 0) {
    lines.push('open_loops:');
    for (const item of openLoops.slice(0, 3)) lines.push(`- ${esc(item.title)}`);
  }
  if (Array.isArray(recall?.results) && recall.results.length > 0) {
    lines.push('supporting_memories:');
    lines.push(...buildSupportingMemoryLines(recall.results));
  }
  lines.push('</gigabrain-context>');
  return `${lines.join('\n')}\n`;
};

const buildTimelineBlock = ({
  query,
  strategy,
  profile,
  detail,
  recall,
  deepLookupAllowed,
  temporalWindow,
}) => {
  const lines = [];
  lines.push('<gigabrain-context>');
  lines.push(`query: ${esc(query)}`);
  lines.push(`strategy: ${strategy}`);
  lines.push(`profile: ${profile}`);
  lines.push(`deep_lookup_allowed: ${deepLookupAllowed ? 'true' : 'false'}`);
  lines.push('instruction: Prefer answering from this Gigabrain context first.');
  lines.push('instruction: Only use deeper memory verification if deep_lookup_allowed=true.');
  lines.push('instruction: Answer with explicit time framing. If a memory is historical, keep that framing instead of treating it as current.');
  if (detail?.display_name) {
    lines.push(`entity: ${esc(detail.display_name)} (${esc(detail.kind)})`);
  }
  if (temporalWindow?.startDate || temporalWindow?.endDate) {
    lines.push(`temporal_window: ${esc(temporalWindow?.startDate || '?')} -> ${esc(temporalWindow?.endDate || '?')}`);
  }
  if (detail?.episodes?.length) {
    lines.push('timeline_items:');
    for (const episode of detail.episodes.slice(0, 6)) {
      const when = String(episode.start_date || episode.end_date || 'undated');
      lines.push(`- ${esc(when)}: ${esc(episode.summary || episode.title || '')}`);
    }
  }
  if (Array.isArray(recall?.results) && recall.results.length > 0) {
    lines.push('supporting_memories:');
    lines.push(...buildSupportingMemoryLines(recall.results));
  }
  lines.push('</gigabrain-context>');
  return `${lines.join('\n')}\n`;
};

const orchestrateRecall = ({
  db,
  config,
  query,
  scope = '',
} = {}) => {
  const sanitizedQuery = sanitizeRecallQuery(query);
  const effectiveQuery = sanitizedQuery || String(query || '').trim();
  ensureWorldModelReady({ db, config, rebuildIfEmpty: true });
  const intent = classifyQueryIntent(effectiveQuery);
  const temporalWindow = detectTemporalWindow(effectiveQuery, Number(config?.native?.onDemandTemporalDays ?? 3650));
  const entityMatches = findEntityMatches(db, effectiveQuery, {
    limit: 5,
    temporalPenaltyKinds: config?.orchestrator?.temporalEntityPenaltyKinds || ['topic'],
  });
  const primaryEntityMatch = selectPrimaryEntityMatch(entityMatches, intent.strategy);
  const entityLockMinScore = Math.max(
    0.3,
    Math.min(0.95, Number(config?.orchestrator?.entityLockMinScore ?? 0.58) || 0.58),
  );
  const lockedEntityMatch = primaryEntityMatch && Number(primaryEntityMatch._orchestrator_score || primaryEntityMatch.score || 0) >= entityLockMinScore
    ? primaryEntityMatch
    : null;
  const topEntity = lockedEntityMatch ? getEntityDetail(db, lockedEntityMatch.entity_id) : null;
  const preliminaryRecall = recallForQuery({
    db,
    config,
    query: effectiveQuery,
    scope,
    strategyContext: {
      strategy: intent.strategy,
      selectedEntity: topEntity,
      temporalWindow,
      deepLookupAllowed: false,
    },
  });
  let strategy = intent.strategy;
  if (!topEntity) {
    if (strategy === 'timeline_brief' && temporalWindow) {
      strategy = 'timeline_brief';
    } else if (['entity_brief', 'relationship_brief', 'contradiction_check'].includes(strategy) && preliminaryRecall.results.length > 0) {
      strategy = intent.strategy;
    } else if (['entity_brief', 'relationship_brief', 'timeline_brief', 'contradiction_check'].includes(strategy)) {
      strategy = 'quick_context';
    }
  }
  const contradictions = topEntity ? listContradictions(db, { entityId: topEntity.entity_id, limit: 10 }) : [];
  const openLoops = topEntity ? listOpenLoops(db, { entityId: topEntity.entity_id, limit: 10 }) : [];
  const profile = resolveRecallProfile({ strategy, entityKind: topEntity?.kind || lockedEntityMatch?.kind || '' });
  const configuredDeepLookupReasons = Array.isArray(config?.orchestrator?.deepLookupRequires)
    ? config.orchestrator.deepLookupRequires
    : [];
  const deepLookupReason = resolveDeepLookupReason({
    query: effectiveQuery,
    recall: preliminaryRecall,
    topEntity,
    config,
  });
  const deepLookupReasons = deepLookupReason && deepLookupReason !== 'none'
    ? [deepLookupReason]
    : [];
  const deepLookupAllowed = config?.orchestrator?.allowDeepLookup !== false
    && deepLookupReasons.some((reason) => configuredDeepLookupReasons.includes(reason));
  const shouldRefreshRecall = deepLookupAllowed || strategy !== intent.strategy;
  const recall = shouldRefreshRecall
    ? recallForQuery({
      db,
      config,
      query: effectiveQuery,
      scope,
      strategyContext: {
        strategy,
        selectedEntity: topEntity,
        temporalWindow,
        deepLookupAllowed,
      },
    })
    : preliminaryRecall;

  let injection = recall.injection;
  let usedWorldModel = false;
  if (strategy === 'entity_brief' || strategy === 'relationship_brief' || strategy === 'contradiction_check') {
    if (topEntity) {
      injection = buildWorldModelBlock({
        query: effectiveQuery,
        strategy,
        profile,
        detail: topEntity,
        recall,
        deepLookupAllowed,
        deepLookupReason: deepLookupReason === 'none' ? '' : deepLookupReason,
        contradictions,
        openLoops,
      });
      usedWorldModel = true;
    }
  } else if (strategy === 'timeline_brief' && topEntity) {
    injection = buildTimelineBlock({
      query: effectiveQuery,
      strategy,
      profile,
      detail: topEntity,
      recall,
      deepLookupAllowed,
      temporalWindow,
    });
    usedWorldModel = true;
  } else if (strategy === 'verification_lookup') {
    const lines = [];
    lines.push('<gigabrain-context>');
    lines.push(`query: ${esc(effectiveQuery)}`);
    lines.push('strategy: verification_lookup');
    lines.push(`profile: ${profile}`);
    lines.push(`deep_lookup_allowed: ${deepLookupAllowed ? 'true' : 'false'}`);
    if (deepLookupReason && deepLookupReason !== 'none') {
      lines.push(`deep_lookup_reason: ${esc(deepLookupReason)}`);
    }
    lines.push('instruction: Prefer answering from Gigabrain memory first, but the user is explicitly asking for exactness or provenance.');
    lines.push('instruction: A deeper verification tool may only be used because deep_lookup_allowed=true for this request.');
    if (Array.isArray(recall?.results) && recall.results.length > 0) {
      lines.push('supporting_memories:');
      lines.push(...buildSupportingMemoryLines(recall.results, 6));
    }
    lines.push('</gigabrain-context>');
    injection = `${lines.join('\n')}\n`;
  }

  const confidence = topEntity
    ? Number(topEntity.confidence || 0.7)
    : Number(recall?.results?.[0]?._score || recall?.results?.[0]?.score || 0);
  const staleFlags = {
    contradictions: contradictions.length,
    open_loops: openLoops.length,
    temporal_window: temporalWindow ? 1 : 0,
  };
  const rankingMode = resolveReportedRankingMode({
    recall,
    strategy,
    topEntity,
    temporalWindow,
  });

  return {
    query: effectiveQuery,
    originalQuery: String(query || ''),
    scope,
    strategy,
    profile,
    reason: intent.reason,
    deepLookupAllowed,
    deepLookupRecommended: deepLookupAllowed,
    deepLookupReason,
    deepLookupReasons,
    rankingMode,
    usedWorldModel,
    temporalWindow,
    entityMatches,
    selectedEntityId: topEntity?.entity_id || '',
    selectedEntityKind: topEntity?.kind || '',
    selectedEntityDisplayName: topEntity?.display_name || '',
    selectedEntityConfidence: topEntity ? Number(topEntity.confidence || 0) : 0,
    entityIds: topEntity ? [topEntity.entity_id] : [],
    contradictions,
    openLoops,
    results: recall.results || [],
    fallbackUsed: recall.fallbackUsed,
    budget: recall.budget,
    confidence,
    staleFlags,
    injection,
    explain: {
      strategy,
      profile,
      reason: intent.reason,
      ranking_mode: rankingMode,
      deep_lookup_allowed: deepLookupAllowed,
      deep_lookup_reason: deepLookupReason,
      deep_lookup_reasons: deepLookupReasons,
      used_world_model: usedWorldModel,
      selected_entity_id: topEntity?.entity_id || '',
      selected_entity_kind: topEntity?.kind || '',
      selected_entity_display_name: topEntity?.display_name || '',
      selected_entity_confidence: topEntity ? Number(topEntity.confidence || 0) : 0,
      entity_matches: entityMatches,
      contradictions: contradictions.map((item) => item.title),
      open_loops: openLoops.map((item) => item.title),
      recall_result_count: Array.isArray(recall.results) ? recall.results.length : 0,
      estimated_injection_tokens: estimateTokens(injection),
      result_breakdown: summarizeResultBreakdown(recall.results || []),
    },
  };
};

export {
  classifyQueryIntent,
  orchestrateRecall,
};
