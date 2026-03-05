import { searchCurrentMemories } from './projection-store.js';
import { queryNativeChunks } from './native-sync.js';
import { isDurable, normalizeContent, resolvePolicy } from './policy.js';
import { containsEntity, resolveEntityKeysForQuery, scorePersonContent } from './person-service.js';

const NOISE_RE = /\b(?:run:|cron|pipeline|script|todo:|phase\s+\d+|temporary|auto-rejected)\b/i;
const DECISION_HINT_RE = /\b(?:decision|decided|we should|we will|always|rule)\b/i;
const TEMPORAL_HINT_RE = /\b(?:january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|october|oct|november|nov|december|dec|januar|februar|maerz|märz|april|mai|juni|juli|august|september|oktober|november|dezember|this year|last year|next year|diese[msr]? jahr|letzte[sr]? jahr|n[aä]chste[sr]? jahr|20\d{2})\b/i;
const ENTITY_QUERY_HINT_RE = /\b(?:wer ist|wer war|who is|who was|about|über|ueber|tell me about|was weißt du über|was weisst du über)\b/i;
const ENTITY_INSTRUCTION_RE = /\b(?:add to|add new|include|set|remember|update|todo|section|prompt|instruction|feature flag|write to)\b/i;
const ENTITY_FACT_STYLE_RE = /\b(?:\bis\b|\bist\b|\bwas\b|\blives\b|\blebt\b|\bworks\b|\barbeitet\b)\b/i;
const ENTITY_LOW_SIGNAL_RE = /\b(?:no duplicate|duplicate entries|duplikat|kein(?:e|en)? info|unknown|not available|nicht verfügbar|memory search)\b/i;
const QUERY_STOPWORDS = new Set([
  'wer',
  'ist',
  'war',
  'was',
  'wie',
  'wo',
  'wann',
  'warum',
  'wieso',
  'ueber',
  'über',
  'und',
  'oder',
  'der',
  'die',
  'das',
  'ein',
  'eine',
  'einer',
  'einem',
  'einen',
  'den',
  'dem',
  'des',
  'mit',
  'von',
  'zu',
  'im',
  'in',
  'am',
  'an',
  'auf',
  'about',
  'tell',
  'me',
  'who',
  'is',
  'was',
  'the',
  'a',
  'an',
  'and',
  'or',
  'to',
  'for',
  'please',
  'bitte',
]);

const MONTHS = Object.freeze({
  january: 1, jan: 1, januar: 1,
  february: 2, feb: 2, februar: 2,
  march: 3, mar: 3, maerz: 3, 'märz': 3,
  april: 4, apr: 4,
  may: 5, mai: 5,
  june: 6, jun: 6, juni: 6,
  july: 7, jul: 7, juli: 7,
  august: 8, aug: 8,
  september: 9, sep: 9,
  october: 10, oct: 10, oktober: 10, okt: 10,
  november: 11, nov: 11,
  december: 12, dec: 12, dezember: 12, dez: 12,
});

const estimateTokens = (text) => Math.max(1, Math.ceil(String(text || '').length / 4));
const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));
const normalizeScope = (scope) => String(scope || 'shared').trim() || 'shared';
const tokenize = (value) => normalizeContent(value).split(/\s+/).filter(Boolean);
const normalizeRecallContent = (value) => normalizeContent(
  String(value || '')
    .replace(/^\([^)]*\)\s*/u, '')
    .replace(/[`*_>#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim(),
);

const toFocusTokens = (tokens = []) => {
  const filtered = tokens.filter((token) => token.length >= 3 && !QUERY_STOPWORDS.has(token));
  if (filtered.length > 0) return filtered.slice(0, 10);
  return tokens.filter((token) => token.length >= 3).slice(0, 10);
};

const buildQuerySignals = (query, entityKeys = []) => {
  const tokens = tokenize(query);
  const focusTokens = toFocusTokens(tokens);
  const hasEntityKeys = Array.isArray(entityKeys) && entityKeys.length > 0;
  const entityIntent = hasEntityKeys
    && (ENTITY_QUERY_HINT_RE.test(String(query || '')) || tokens.length <= 4);
  return {
    tokens,
    focusTokens: focusTokens.length > 0 ? focusTokens : tokens.slice(0, 10),
    hasEntityKeys,
    entityIntent,
  };
};

const scopeWeight = (scope) => {
  const value = normalizeScope(scope);
  if (value.startsWith('profile:')) return 0.15;
  if (value === 'shared') return 0.08;
  return 0.1;
};

const overlapScore = (queryOrTokens, content) => {
  const qTokens = Array.isArray(queryOrTokens)
    ? queryOrTokens.map((item) => normalizeContent(item)).filter(Boolean)
    : tokenize(queryOrTokens);
  const q = new Set(qTokens);
  const c = new Set(normalizeContent(content).split(/\s+/).filter(Boolean));
  if (q.size === 0 || c.size === 0) return 0;
  let hit = 0;
  for (const token of q) {
    if (c.has(token)) hit += 1;
  }
  return hit / q.size;
};

const recencyDecayScore = (value) => {
  const ts = Date.parse(String(value || ''));
  if (!Number.isFinite(ts)) return 0.25;
  const days = Math.max(0, (Date.now() - ts) / (24 * 60 * 60 * 1000));
  if (days <= 1) return 0.25;
  if (days <= 7) return 0.2;
  if (days <= 30) return 0.15;
  if (days <= 90) return 0.08;
  if (days <= 365) return 0.04;
  return 0.01;
};

const inferNativeType = (row) => {
  const section = String(row?.section || '').toUpperCase();
  if (section.includes('PREFERENCE')) return 'PREFERENCE';
  if (section.includes('DECISION')) return 'DECISION';
  if (section.includes('ENTITY')) return 'ENTITY';
  if (section.includes('EPISODE')) return 'EPISODE';
  if (section.includes('AGENT_IDENTITY')) return 'AGENT_IDENTITY';
  if (section.includes('USER_FACT') || section.includes('FACT')) return 'USER_FACT';
  if (DECISION_HINT_RE.test(String(row?.content || ''))) return 'DECISION';
  return 'CONTEXT';
};

const inferNativeScope = (row, requestedScope) => {
  if (String(row?.source_kind || '') === 'curated') return 'shared';
  if (String(row?.source_kind || '') === 'memory_md') return 'profile:main';
  return normalizeScope(requestedScope || 'shared');
};

const classifyRecallClass = (row) => {
  const type = String(row?.type || '').toUpperCase();
  const label = String(row?.value_label || '').toLowerCase();
  if (type === 'AGENT_IDENTITY' || type === 'PREFERENCE' || label === 'core') return 'core';
  if (type === 'DECISION') return 'decisions';
  return 'situational';
};

const detectTemporalWindow = (query, maxLookbackDays = 3650) => {
  const raw = String(query || '').trim();
  if (!raw || !TEMPORAL_HINT_RE.test(raw)) return null;
  const lower = raw.toLowerCase();
  const now = new Date();

  const yearMonth = lower.match(/\b(20\d{2})[-/](0[1-9]|1[0-2])\b/);
  if (yearMonth) {
    const year = Number(yearMonth[1]);
    const month = Number(yearMonth[2]);
    const start = new Date(Date.UTC(year, month - 1, 1));
    const end = new Date(Date.UTC(year, month, 0));
    return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10), reason: 'year_month' };
  }

  const monthName = lower.match(/\b(january|jan|januar|february|feb|februar|march|mar|maerz|märz|april|apr|may|mai|june|jun|juni|july|jul|juli|august|aug|september|sep|october|oct|oktober|okt|november|nov|december|dec|dezember|dez)\b/);
  if (monthName?.[1]) {
    const month = Number(MONTHS[monthName[1]] || 0);
    const explicitYear = lower.match(/\b(20\d{2})\b/);
    const year = explicitYear ? Number(explicitYear[1]) : now.getUTCFullYear();
    if (month >= 1 && month <= 12) {
      const start = new Date(Date.UTC(year, month - 1, 1));
      const end = new Date(Date.UTC(year, month, 0));
      return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10), reason: 'month_name' };
    }
  }

  const yearOnly = lower.match(/\b(20\d{2})\b/);
  if (yearOnly?.[1]) {
    const year = Number(yearOnly[1]);
    return {
      startDate: `${year}-01-01`,
      endDate: `${year}-12-31`,
      reason: 'year_only',
    };
  }

  const lookback = Math.max(30, Math.min(36500, Number(maxLookbackDays || 3650) || 3650));
  const start = new Date(Date.now() - lookback * 24 * 60 * 60 * 1000);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: new Date().toISOString().slice(0, 10),
    reason: 'temporal_hint',
  };
};

const hasEntityMatch = (content, entityKeys = [], config = {}) => {
  if (!Array.isArray(entityKeys) || entityKeys.length === 0) return false;
  for (const key of entityKeys) {
    if (containsEntity(content, key, config?.person?.requireWordBoundaryMatch !== false)) return true;
  }
  return false;
};

const entityPriorityBoost = ({ entityMatched, querySignals }) => {
  if (!querySignals?.hasEntityKeys) return 0;
  if (querySignals.entityIntent) return entityMatched ? 0.55 : -0.45;
  return entityMatched ? 0.15 : 0;
};

const entityAnswerQualityBoost = (content, querySignals, entityMatched) => {
  if (!querySignals?.entityIntent || !entityMatched) return 0;
  const raw = String(content || '').trim();
  const normalized = normalizeRecallContent(raw);
  if (!normalized) return -0.2;

  let boost = 0;
  if (ENTITY_INSTRUCTION_RE.test(raw)) boost -= 0.45;
  if (/[`{}[\]|]/.test(raw)) boost -= 0.12;
  if (normalized.length > 320) boost -= 0.14;
  if (normalized.length >= 24 && normalized.length <= 220) boost += 0.08;
  if (ENTITY_FACT_STYLE_RE.test(raw)) boost += 0.08;
  return boost;
};

const prioritizeEntityRows = (rows = [], querySignals = {}) => {
  if (!Array.isArray(rows) || rows.length <= 1 || !querySignals?.entityIntent) return rows;
  return [...rows].sort((a, b) => {
    const entityDiff = Number(b?._entity_match || 0) - Number(a?._entity_match || 0);
    if (entityDiff !== 0) return entityDiff;
    const qualityDiff = Number(b?._entity_quality_boost || 0) - Number(a?._entity_quality_boost || 0);
    if (qualityDiff !== 0) return qualityDiff;
    return Number(b?._score || 0) - Number(a?._score || 0);
  });
};

const dedupeRowsByContent = (rows = []) => {
  if (!Array.isArray(rows) || rows.length <= 1) return rows;
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const normalized = normalizeRecallContent(row?.content || '');
    const key = normalized || String(row?.memory_id || row?._provenance || '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
  }
  return out;
};

const buildEntityAnswerHints = (rows = [], querySignals = {}) => {
  if (!querySignals?.entityIntent || !Array.isArray(rows) || rows.length === 0) return [];
  const seen = new Set();
  const out = [];
  const ranked = [...rows].sort((a, b) => {
    const qualityDiff = Number(b?._entity_quality_boost || 0) - Number(a?._entity_quality_boost || 0);
    if (qualityDiff !== 0) return qualityDiff;
    return Number(b?._score || 0) - Number(a?._score || 0);
  });

  for (const row of ranked) {
    if (Number(row?._entity_match || 0) <= 0) continue;
    const raw = String(row?.content || '').trim();
    const normalized = normalizeRecallContent(raw);
    if (!normalized) continue;
    if (ENTITY_INSTRUCTION_RE.test(raw) || ENTITY_LOW_SIGNAL_RE.test(raw)) continue;
    if (!ENTITY_FACT_STYLE_RE.test(raw) && normalized.length > 220) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(raw.replace(/\s+/g, ' ').trim());
    if (out.length >= 3) break;
  }
  return out;
};

const rankActiveRow = (row, querySignals, policy, config = {}, entityKeys = []) => {
  const semanticMatch = overlapScore(querySignals?.focusTokens || [], row.content || row.normalized || '');
  const valueScore = Number.isFinite(Number(row.value_score)) ? Number(row.value_score) : 0;
  const recency = recencyDecayScore(row.updated_at || row.created_at);
  const durableBoost = isDurable(row.content || '', {
    enabled: policy.durableEnabled,
    patterns: policy.durablePatterns,
  }) ? 0.18 : 0;
  const noisePenalty = NOISE_RE.test(String(row.content || '')) ? 0.12 : 0;
  const archivePenalty = String(row.status || '') === 'archived' ? 0.2 : 0;
  const entityMatched = hasEntityMatch(row.content || row.normalized || '', entityKeys, config);
  const entityBoost = entityPriorityBoost({ entityMatched, querySignals });
  const person = scorePersonContent({
    content: row.content || row.normalized || '',
    entityKeys,
    config,
  });
  const personBoost = Number(person?.score || 0);
  const entityQualityBoost = entityAnswerQualityBoost(row.content || row.normalized || '', querySignals, entityMatched);
  const score = semanticMatch + valueScore + recency + scopeWeight(row.scope) + durableBoost + personBoost + entityBoost + entityQualityBoost - noisePenalty - archivePenalty;
  return {
    ...row,
    _semantic_match: semanticMatch,
    _value_score: valueScore,
    _recency_decay: recency,
    _scope_weight: scopeWeight(row.scope),
    _durable_boost: durableBoost,
    _entity_match: entityMatched ? 1 : 0,
    _entity_boost: entityBoost,
    _entity_quality_boost: entityQualityBoost,
    _person_boost: personBoost,
    _person_role: person?.role || null,
    _noise_penalty: noisePenalty,
    _archive_penalty: archivePenalty,
    _score: score,
    _class: classifyRecallClass(row),
    _source: 'active',
    _provenance: row.memory_id || '',
  };
};

const rankNativeRow = (row, querySignals, config = {}, entityKeys = []) => {
  const sourceKind = String(row.source_kind || 'daily_note');
  const nativeType = inferNativeType(row);
  const nativeScope = inferNativeScope(row, '');
  const semanticMatch = Number.isFinite(Number(row.score_lexical))
    ? Number(row.score_lexical)
    : overlapScore(querySignals?.focusTokens || [], row.content || row.normalized || '');
  const baseValue = sourceKind === 'memory_md'
    ? 0.9
    : sourceKind === 'curated'
      ? 0.75
      : 0.58;
  const recency = recencyDecayScore(String(row.source_date || row.last_seen_at || ''));
  const durableBoost = sourceKind === 'memory_md' ? 0.2 : 0;
  const noisePenalty = NOISE_RE.test(String(row.content || '')) ? 0.1 : 0;
  const entityMatched = Number(row.score_entity || 0) > 0 || hasEntityMatch(row.content || row.normalized || '', entityKeys, config);
  const entityBoost = entityPriorityBoost({ entityMatched, querySignals });
  const person = scorePersonContent({
    content: row.content || row.normalized || '',
    entityKeys,
    config,
  });
  const personBoost = Number(person?.score || 0);
  const entityQualityBoost = entityAnswerQualityBoost(row.content || row.normalized || '', querySignals, entityMatched);
  const score = semanticMatch + baseValue + recency + scopeWeight(nativeScope) + durableBoost + personBoost + entityBoost + entityQualityBoost - noisePenalty;
  const line = Number(row.line_start || 0) || 0;
  const provenance = line > 0
    ? `${row.source_path}:${line}`
    : String(row.source_path || '');
  return {
    memory_id: `native:${row.chunk_id}`,
    type: nativeType,
    content: row.content,
    normalized: row.normalized,
    confidence: 0.7,
    scope: nativeScope,
    status: 'active',
    value_score: baseValue,
    value_label: sourceKind === 'memory_md' ? 'core' : 'situational',
    created_at: row.first_seen_at || null,
    updated_at: row.last_seen_at || null,
    source_path: row.source_path,
    source_kind: sourceKind,
    source_date: row.source_date,
    linked_memory_id: row.linked_memory_id || null,
    _semantic_match: semanticMatch,
    _value_score: baseValue,
    _recency_decay: recency,
    _scope_weight: scopeWeight(nativeScope),
    _durable_boost: durableBoost,
    _entity_match: entityMatched ? 1 : 0,
    _entity_boost: entityBoost,
    _entity_quality_boost: entityQualityBoost,
    _person_boost: personBoost,
    _person_role: person?.role || null,
    _noise_penalty: noisePenalty,
    _archive_penalty: 0,
    _score: score,
    _class: classifyRecallClass({ type: nativeType, value_label: sourceKind === 'memory_md' ? 'core' : 'situational' }),
    _source: 'native',
    _provenance: provenance,
  };
};

const allocateByBudget = (rankedRows, config = {}) => {
  const maxTokens = Math.max(100, Number(config?.recall?.maxTokens ?? 1200) || 1200);
  const budgets = config?.recall?.classBudgets || { core: 0.45, situational: 0.3, decisions: 0.25 };
  const maxByClass = {
    core: Math.max(1, Math.floor(maxTokens * Number(budgets.core || 0.45))),
    situational: Math.max(1, Math.floor(maxTokens * Number(budgets.situational || 0.3))),
    decisions: Math.max(1, Math.floor(maxTokens * Number(budgets.decisions || 0.25))),
  };
  const selected = [];
  const tokensByClass = { core: 0, situational: 0, decisions: 0 };
  let totalTokens = 0;
  for (const row of rankedRows) {
    const cls = row._class || 'situational';
    const rowTokens = estimateTokens(row.content || '');
    if ((tokensByClass[cls] + rowTokens) > maxByClass[cls]) continue;
    if ((totalTokens + rowTokens) > maxTokens) continue;
    selected.push(row);
    tokensByClass[cls] += rowTokens;
    totalTokens += rowTokens;
  }
  return { selected, tokensByClass, totalTokens, maxTokens };
};

const renderInjection = ({
  rows,
  query,
  fallbackUsed,
  querySignals,
}) => {
  const esc = (s) => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  if (!rows || rows.length === 0) return '';
  const entityHints = buildEntityAnswerHints(rows, querySignals);
  const lines = [];
  lines.push('<gigabrain-context>');
  lines.push(`query: ${esc(query)}`);
  lines.push(`fallback: ${fallbackUsed ? 'archived' : 'active_or_native'}`);
  if (querySignals?.entityIntent) {
    lines.push('entity_mode: true');
    lines.push('instruction: For "who is / wer ist" questions, prioritize entity_answer_hints first, then supporting memories. If hints exist, do not answer "unknown". If facts conflict, mention uncertainty.');
    if (entityHints.length > 0) {
      lines.push('entity_answer_hints:');
      for (const hint of entityHints) lines.push(`- ${hint}`);
    }
  }
  lines.push('memories:');
  for (const row of rows) {
    const id = row.memory_id || row.id || 'unknown';
    const provenance = row._provenance ? ` | src=${row._provenance}` : '';
    lines.push(`- [${id}] (${row.type}/${row.scope}${provenance}) ${String(row.content || '').trim()}`);
  }
  lines.push('</gigabrain-context>');
  return `${lines.join('\n')}\n`;
};

const recallForQuery = ({
  db,
  config,
  query,
  scope = '',
}) => {
  const policy = resolvePolicy(config);
  const topK = Math.max(1, Number(config?.recall?.topK ?? 8) || 8);
  const requestedScope = scope ? normalizeScope(scope) : '';
  const normalizedScope = requestedScope || 'shared';
  const temporalWindow = detectTemporalWindow(query, Number(config?.native?.onDemandTemporalDays ?? 3650));
  const entityKeys = resolveEntityKeysForQuery(db, query, { fallbackTokens: true });
  const querySignals = buildQuerySignals(query, entityKeys);
  const lexicalQuery = querySignals.focusTokens.length > 0
    ? querySignals.focusTokens.join(' ')
    : String(query || '');

  const activeRows = searchCurrentMemories(db, {
    query: lexicalQuery,
    topK: Math.max(topK * 6, 20),
    scope: requestedScope,
    statuses: ['active'],
  });
  const activeRanked = activeRows.map((row) => rankActiveRow(row, querySignals, policy, config, entityKeys));
  activeRanked.sort((a, b) => Number(b._score || 0) - Number(a._score || 0));

  const shouldQueryNative = Boolean(temporalWindow || querySignals.hasEntityKeys || activeRanked.length < topK);
  let nativeRanked = [];
  if (shouldQueryNative && config?.native?.enabled !== false) {
    const nativeRows = queryNativeChunks({
      db,
      config,
      query: lexicalQuery,
      scope: normalizedScope,
      startDate: temporalWindow?.startDate || '',
      endDate: temporalWindow?.endDate || '',
      limit: Math.max(topK * 8, 40),
      entityKeys,
    });
    nativeRanked = nativeRows.map((row) => rankNativeRow(row, querySignals, config, entityKeys));
    nativeRanked.sort((a, b) => Number(b._score || 0) - Number(a._score || 0));
  }

  const mergedByKey = new Map();
  for (const row of [...activeRanked, ...nativeRanked]) {
    const key = String(row.memory_id || `${row._source}:${row._provenance || row.content || ''}`);
    const prev = mergedByKey.get(key);
    if (!prev || Number(row._score || 0) > Number(prev._score || 0)) mergedByKey.set(key, row);
  }
  let candidateRows = Array.from(mergedByKey.values())
    .sort((a, b) => Number(b._score || 0) - Number(a._score || 0));

  let fallbackUsed = false;
  if (candidateRows.length === 0 && config?.recall?.archiveFallbackEnabled !== false) {
    const archivedRows = searchCurrentMemories(db, {
      query: lexicalQuery,
      topK: Math.max(topK * 4, 12),
      scope: requestedScope,
      statuses: ['archived'],
    });
    const archivedRanked = archivedRows
      .map((row) => rankActiveRow(row, querySignals, policy, config, entityKeys))
      .sort((a, b) => Number(b._score || 0) - Number(a._score || 0));
    candidateRows = archivedRanked;
    fallbackUsed = archivedRanked.length > 0;
  }

  candidateRows = prioritizeEntityRows(candidateRows, querySignals);
  candidateRows = dedupeRowsByContent(candidateRows);

  const sliced = candidateRows.slice(0, Math.max(topK * 3, 18));
  const budgeted = allocateByBudget(sliced, config);
  const selected = budgeted.selected.slice(0, topK);
  const injection = renderInjection({ rows: selected, query, fallbackUsed, querySignals });

  return {
    query,
    fallbackUsed,
    temporalWindow,
    entityKeys,
    results: selected,
    injection,
    budget: {
      totalTokens: budgeted.totalTokens,
      maxTokens: budgeted.maxTokens,
      byClass: budgeted.tokensByClass,
    },
  };
};

export {
  estimateTokens,
  detectTemporalWindow,
  recallForQuery,
};
