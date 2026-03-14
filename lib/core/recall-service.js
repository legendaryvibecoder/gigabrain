import { searchCurrentMemories } from './projection-store.js';
import { queryNativeChunks } from './native-sync.js';
import {
  classifyValue,
  isDurable,
  jaccardSimilarity,
  normalizeContent,
  resolvePolicy,
  resolveSemanticThresholds,
} from './policy.js';
import { containsEntity, ensurePersonStore, resolveEntityKeysForQuery, scorePersonContent } from './person-service.js';
import { isDurableMemoryTier, normalizeMemoryTier, resolveMemoryTier } from './world-model.js';

const NOISE_RE = /\b(?:run:|cron|pipeline|script|todo:|phase\s+\d+|temporary|auto-rejected)\b/i;
const DECISION_HINT_RE = /\b(?:decision|decided|we should|we will|always|rule)\b/i;
const TEMPORAL_HINT_RE = /\b(?:january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|october|oct|november|nov|december|dec|januar|februar|maerz|märz|april|mai|juni|juli|august|september|oktober|november|dezember|this year|last year|next year|diese[msr]? jahr|letzte[sr]? jahr|n[aä]chste[sr]? jahr|20\d{2})\b/i;
const ENTITY_QUERY_HINT_RE = /\b(?:wer ist|wer war|who is|who was|about|über|ueber|tell me about|was weißt du über|was weisst du über)\b/i;
const ENTITY_INSTRUCTION_RE = /\b(?:add to|add new|include|set|remember|update|todo|section|prompt|instruction|feature flag|write to)\b/i;
const ENTITY_FACT_STYLE_RE = /\b(?:\bis\b|\bist\b|\bwas\b|\blives\b|\blebt\b|\bworks\b|\barbeitet\b)\b/i;
const ENTITY_LOW_SIGNAL_RE = /\b(?:no duplicate|duplicate entries|duplikat|kein(?:e|en)? info|unknown|not available|nicht verfügbar|memory search)\b/i;
const ENTITY_SUMMARY_WEAK_RE = /\b(?:mail friend|memory-?notes?|birthday reminder|numeric chat id|chat id|@[\w_]+|username|default engine|voice preset|voice reference|profile image|saved to avatars|api calls needed|tool ignores|verify code|send login code)\b/i;
const ENTITY_STRONG_FACT_RE = /\b(?:partner|partnerin|relationship|beziehung|lives? in|lebt in|works? as|arbeitet als|active in|community|investor|investment|valuation|interview|prefers?|bevorzugt|birthday|geburtstag|current weight|target)\b/i;
const IDENTITY_QUERY_RE = /\b(?:about yourself|yourself|who are you|agent identity|my personality|personality|identity|selbst|ueber dich|über dich)\b/i;
const PREFERENCE_QUERY_RE = /\b(?:preference|prefer(?:s)?|favorite|favourite|like(?:s)?|love(?:s)?|hate(?:s)?|dislike(?:s)?|magst du|mag ich|bevorzug(?:e|en|t|st)|lieblings|jahreszeit|season)\b/i;
const SEASON_QUERY_RE = /\b(?:season|jahreszeit|winter|spring|summer|autumn|fall|fruehling|frühling|sommer|herbst)\b/i;
const RELATIVE_TIME_RE = /\b(?:today|heute|yesterday|gestern|tomorrow|currently|right now|at the moment|derzeit|aktuell|just now|heute früh|heute frueh|this morning|this evening|tonight)\b/i;
const INTERNAL_CONTEXT_BLOCK_RE = /<gigabrain-context>[\s\S]*?<\/gigabrain-context>/gi;
const EXEC_LINE_RE = /^System:\s*\[[^\]]+\]\s*Exec completed\b.*$/i;
const METADATA_HEADER_RE = /^(?:Conversation info|Sender)\s*\(untrusted metadata\)\s*:\s*$/i;
const METADATA_KEY_LINE_RE = /^\s*"(?:message_id|sender_id|sender|timestamp|label|id|name|username)"\s*:\s*/i;
const METADATA_FENCED_BLOCK_RE = /```(?:json)?\s*[\r\n]+[\s\S]*?"(?:message_id|sender_id|sender|timestamp|label|id|name|username)"[\s\S]*?```/gi;
const METADATA_BARE_BLOCK_RE = /\{[\s\S]*?"(?:message_id|sender_id|sender|timestamp|label|id|name|username)"[\s\S]*?\}/gi;
const TRANSCRIPT_PREFIX_RE = /^(?:assistant|user):\s*/i;
const DANGLING_JSON_LINE_RE = /^[\]}]+\s*$/;
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

const sanitizeRecallQuery = (query = '') => {
  const raw = String(query || '')
    .replace(INTERNAL_CONTEXT_BLOCK_RE, ' ')
    .replace(METADATA_FENCED_BLOCK_RE, ' ')
    .replace(METADATA_BARE_BLOCK_RE, ' ')
    .trim();
  if (!raw) return '';
  const lines = raw.split(/\r?\n/);
  const kept = [];
  let skipNextMetadataFence = false;
  let inSkippedFence = false;

  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (!trimmed) {
      if (!inSkippedFence && kept.length > 0 && kept[kept.length - 1] !== '') kept.push('');
      continue;
    }
    if (METADATA_HEADER_RE.test(trimmed) || EXEC_LINE_RE.test(trimmed)) {
      skipNextMetadataFence = true;
      continue;
    }
    if (/^```/.test(trimmed)) {
      if (skipNextMetadataFence || inSkippedFence) {
        inSkippedFence = !inSkippedFence;
        if (!inSkippedFence) skipNextMetadataFence = false;
        continue;
      }
      if (/^```(?:json)?$/i.test(trimmed)) continue;
    }
    if (inSkippedFence) continue;
    if (TRANSCRIPT_PREFIX_RE.test(trimmed)) continue;
    if (METADATA_KEY_LINE_RE.test(trimmed)) continue;
    if (DANGLING_JSON_LINE_RE.test(trimmed)) continue;
    if (/^[\[{][\s\]}",:0-9A-Za-z_-]*$/.test(trimmed) && skipNextMetadataFence) continue;
    skipNextMetadataFence = false;
    kept.push(trimmed);
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
};

const buildQuerySignals = (query, entityKeys = []) => {
  const text = String(query || '');
  const tokens = tokenize(text);
  const focusTokens = toFocusTokens(tokens);
  const hasEntityKeys = Array.isArray(entityKeys) && entityKeys.length > 0;
  const entityIntent = hasEntityKeys
    && (ENTITY_QUERY_HINT_RE.test(text) || tokens.length <= 4);
  const identityIntent = IDENTITY_QUERY_RE.test(text);
  const preferenceIntent = PREFERENCE_QUERY_RE.test(text);
  const hintTokens = [];
  if (identityIntent) hintTokens.push('identity', 'agent', 'profile');
  if (preferenceIntent) hintTokens.push('preference', 'prefer', 'prefers', 'favorite', 'favourite');
  if (preferenceIntent && SEASON_QUERY_RE.test(text)) hintTokens.push('season');
  const lexicalTokens = Array.from(new Set([
    ...(focusTokens.length > 0 ? focusTokens : tokens.slice(0, 10)),
    ...hintTokens,
  ])).slice(0, 12);
  return {
    tokens,
    focusTokens: focusTokens.length > 0 ? focusTokens : tokens.slice(0, 10),
    lexicalTokens,
    hasEntityKeys,
    entityIntent,
    identityIntent,
    preferenceIntent,
    entityKeys: Array.isArray(entityKeys) ? entityKeys : [],
  };
};

const scopeWeight = (scope) => {
  const value = normalizeScope(scope);
  if (value.startsWith('profile:')) return 0.15;
  if (value === 'shared') return 0.08;
  return 0.1;
};

const typeIntentBoost = (rowType = '', querySignals = {}) => {
  const type = String(rowType || '').trim().toUpperCase();
  let boost = 0;
  if (querySignals?.identityIntent) {
    if (type === 'AGENT_IDENTITY') boost += 0.9;
    else if (type === 'PREFERENCE') boost -= 0.08;
  }
  if (querySignals?.preferenceIntent) {
    if (type === 'PREFERENCE') boost += 0.82;
    else if (type === 'AGENT_IDENTITY') boost -= 0.06;
  }
  return boost;
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

const resolveRecordedDate = (row = {}) => {
  const candidates = [row.source_date, row.updated_at, row.created_at, row.last_seen_at, row.first_seen_at];
  for (const candidate of candidates) {
    const raw = String(candidate || '').trim();
    if (!raw) continue;
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) continue;
    return new Date(ms).toISOString().slice(0, 10);
  }
  return '';
};

const isStaleRelativeMemory = (row = {}) => {
  const content = String(row.content || '').trim();
  if (!content || !RELATIVE_TIME_RE.test(content)) return false;
  const recordedDate = resolveRecordedDate(row);
  if (!recordedDate) return false;
  return recordedDate !== new Date().toISOString().slice(0, 10);
};

const staleRelativePenalty = (row = {}) => (isStaleRelativeMemory(row) ? 0.32 : 0);

const formatMemoryForInjection = (row = {}) => {
  const content = String(row.content || '').replace(/\s+/g, ' ').trim();
  if (!content) return '';
  const recordedDate = resolveRecordedDate(row);
  if (!recordedDate || !isStaleRelativeMemory(row)) return content;
  return `Recorded on ${recordedDate}; any relative dates in this memory refer to that date. ${content}`;
};

const tokenizeNormalizedValue = (value = '') => normalizeContent(value).split(/\s+/).filter(Boolean);

const hasTokenSequence = (tokens = [], sequence = []) => {
  if (!Array.isArray(tokens) || !Array.isArray(sequence) || sequence.length === 0 || tokens.length < sequence.length) return false;
  outer: for (let index = 0; index <= (tokens.length - sequence.length); index += 1) {
    for (let offset = 0; offset < sequence.length; offset += 1) {
      if (tokens[index + offset] !== sequence[offset]) continue outer;
    }
    return true;
  }
  return false;
};

const sharedLeadingTokens = (a = '', b = '', count = 2) => {
  const aTokens = tokenizeNormalizedValue(a).slice(0, count);
  const bTokens = tokenizeNormalizedValue(b).slice(0, count);
  if (aTokens.length < count || bTokens.length < count) return false;
  for (let index = 0; index < count; index += 1) {
    if (aTokens[index] !== bTokens[index]) return false;
  }
  return true;
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

const DEFAULT_RECALL_MEMORY_TIERS = Object.freeze(['durable_personal', 'durable_project']);
const DEEP_LOOKUP_MEMORY_TIERS = Object.freeze([
  'durable_personal',
  'durable_project',
  'working_reference',
  'ops_runbook',
]);

const resolveRecallMemoryTiers = (strategyContext = {}) => {
  const strategy = String(strategyContext?.strategy || '').trim().toLowerCase();
  if (strategy === 'verification_lookup' || strategyContext?.deepLookupAllowed === true) {
    return [...DEEP_LOOKUP_MEMORY_TIERS];
  }
  return [...DEFAULT_RECALL_MEMORY_TIERS];
};

const resolveActiveRowMemoryTier = (row = {}, entityKeys = []) => {
  const tier = normalizeMemoryTier(row?.memory_tier || '', '');
  if (tier) return tier;
  return resolveMemoryTier({ row, entityKeys });
};

const resolveNativeRowMemoryTier = (row = {}, nativeType = 'CONTEXT', entityKeys = []) => resolveMemoryTier({
  row: {
    memory_id: `native:${String(row?.chunk_id || '')}`,
    type: nativeType,
    content: row?.content || '',
    confidence: 0.7,
    source_path: row?.source_path || '',
    source_layer: 'native',
    status: 'active',
  },
  entityKeys,
});

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

  const contentTokens = tokenizeNormalizedValue(raw);
  const startsWithEntityKey = Array.isArray(querySignals?.entityKeys)
    && querySignals.entityKeys.some((key) => {
      const aliasTokens = tokenizeNormalizedValue(key);
      if (aliasTokens.length === 0 || aliasTokens.length > contentTokens.length) return false;
      for (let index = 0; index < aliasTokens.length; index += 1) {
        if (contentTokens[index] !== aliasTokens[index]) return false;
      }
      return true;
    });

  let boost = 0;
  if (ENTITY_INSTRUCTION_RE.test(raw)) boost -= 0.45;
  if (ENTITY_SUMMARY_WEAK_RE.test(raw)) boost -= 0.7;
  if (/[`{}[\]|]/.test(raw)) boost -= 0.12;
  if (normalized.length > 320) boost -= 0.14;
  if (normalized.length >= 24 && normalized.length <= 220) boost += 0.08;
  if (ENTITY_FACT_STYLE_RE.test(raw)) boost += 0.08;
  if (ENTITY_STRONG_FACT_RE.test(raw)) boost += 0.18;
  if (startsWithEntityKey) boost += 0.38;
  else boost -= 0.06;
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

const filterRecallRowsByQuality = (rows = [], policy = {}) => {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  return rows.filter((row) => {
    const verdict = classifyValue({
      type: row?.type || 'CONTEXT',
      content: row?.content || '',
      confidence: row?.confidence ?? 0.7,
      scope: row?.scope || 'shared',
      updated_at: row?.updated_at || null,
      created_at: row?.created_at || null,
    }, policy);
    return String(verdict?.action || 'keep') !== 'reject';
  });
};

const dedupeRowsBySimilarity = (rows = [], config = {}) => {
  if (!Array.isArray(rows) || rows.length <= 1) return rows;
  const kept = [];
  for (const row of rows) {
    const content = String(row?.content || '').trim();
    if (!content) continue;
    const thresholds = resolveSemanticThresholds(row?.type || 'CONTEXT', config);
    const similarityThreshold = Math.max(0.86, Math.min(0.97, Number(thresholds.auto || 0.92) - 0.04));
    const isNearDuplicate = kept.some((existing) => {
      if (String(existing?.type || '') !== String(row?.type || '')) return false;
      if (String(existing?.scope || '') !== String(row?.scope || '')) return false;
      if (Number(existing?._selected_entity_match || 0) !== Number(row?._selected_entity_match || 0)) return false;
      const similarity = jaccardSimilarity(existing?.content || '', content);
      if (similarity >= similarityThreshold) return true;
      return similarity >= 0.76 && sharedLeadingTokens(existing?.content || '', content, 2);
    });
    if (!isNearDuplicate) kept.push(row);
  }
  return kept;
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
    if (ENTITY_INSTRUCTION_RE.test(raw) || ENTITY_LOW_SIGNAL_RE.test(raw) || ENTITY_SUMMARY_WEAK_RE.test(raw)) continue;
    if (!ENTITY_FACT_STYLE_RE.test(raw) && normalized.length > 220) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(raw.replace(/\s+/g, ' ').trim());
    if (out.length >= 3) break;
  }
  return out;
};

const buildSelectedEntitySignals = (selectedEntity = {}) => {
  const kind = String(selectedEntity?.kind || '').trim().toLowerCase();
  const minimumAliasLength = kind === 'person' ? 3 : kind === 'topic' ? 5 : 4;
  const aliases = Array.from(new Set([
    String(selectedEntity?.display_name || '').trim(),
    String(selectedEntity?.normalized_name || '').trim(),
    ...(Array.isArray(selectedEntity?.aliases) ? selectedEntity.aliases : []),
  ]))
    .map((value) => normalizeContent(value))
    .filter((value) => value && value.length >= minimumAliasLength);
  return {
    entityId: String(selectedEntity?.entity_id || '').trim(),
    kind,
    displayName: String(selectedEntity?.display_name || '').trim(),
    normalizedName: normalizeContent(selectedEntity?.normalized_name || selectedEntity?.display_name || ''),
    aliases,
  };
};

const buildSelectedEntityMentionMemoryIds = (db, rows = [], selectedEntitySignals = {}) => {
  ensurePersonStore(db);
  const normalizedKeys = Array.from(new Set([
    String(selectedEntitySignals?.normalizedName || '').trim(),
    ...((Array.isArray(selectedEntitySignals?.aliases) ? selectedEntitySignals.aliases : []).map((alias) => normalizeContent(alias))),
  ])).filter(Boolean);
  if (normalizedKeys.length === 0) return new Set();

  const memoryIds = Array.from(new Set(rows.flatMap((row) => {
    const ids = [];
    const memoryId = String(row?.memory_id || '').trim();
    const linkedMemoryId = String(row?.linked_memory_id || '').trim();
    if (memoryId && !memoryId.startsWith('native:')) ids.push(memoryId);
    if (linkedMemoryId) ids.push(linkedMemoryId);
    return ids;
  }))).filter(Boolean);
  if (memoryIds.length === 0) return new Set();

  const mentions = [];
  const memoryChunkSize = 200;
  const keyChunkSize = 40;
  for (let memoryIndex = 0; memoryIndex < memoryIds.length; memoryIndex += memoryChunkSize) {
    const memoryChunk = memoryIds.slice(memoryIndex, memoryIndex + memoryChunkSize);
    for (let keyIndex = 0; keyIndex < normalizedKeys.length; keyIndex += keyChunkSize) {
      const keyChunk = normalizedKeys.slice(keyIndex, keyIndex + keyChunkSize);
      const memoryPlaceholders = memoryChunk.map(() => '?').join(', ');
      const keyPlaceholders = keyChunk.map(() => '?').join(', ');
      const chunkRows = db.prepare(`
        SELECT memory_id, entity_key
        FROM memory_entity_mentions
        WHERE memory_id IN (${memoryPlaceholders})
          AND lower(trim(entity_key)) IN (${keyPlaceholders})
      `).all(...memoryChunk, ...keyChunk);
      mentions.push(...chunkRows);
    }
  }

  return new Set(mentions.map((row) => String(row?.memory_id || '').trim()).filter(Boolean));
};

const extractContentDateValue = (content = '') => {
  const raw = String(content || '').trim();
  if (!raw) return '';

  const isoDate = raw.match(/\b(20\d{2})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])\b/);
  if (isoDate) {
    return `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}`;
  }

  const monthDayYear = raw.match(/\b(january|jan|januar|february|feb|februar|march|mar|maerz|märz|april|apr|may|mai|june|jun|juni|july|jul|juli|august|aug|september|sep|october|oct|oktober|okt|november|nov|december|dec|dezember|dez)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,)?\s+(20\d{2})\b/i);
  if (monthDayYear?.[1] && monthDayYear?.[2] && monthDayYear?.[3]) {
    const month = Number(MONTHS[String(monthDayYear[1]).toLowerCase()] || 0);
    const day = String(Number(monthDayYear[2])).padStart(2, '0');
    if (month >= 1 && month <= 12) {
      return `${monthDayYear[3]}-${String(month).padStart(2, '0')}-${day}`;
    }
  }

  const dayMonthYear = raw.match(/\b(\d{1,2})\.?\s+(january|jan|januar|february|feb|februar|march|mar|maerz|märz|april|apr|may|mai|june|jun|juni|july|jul|juli|august|aug|september|sep|october|oct|oktober|okt|november|nov|december|dec|dezember|dez)\s+(20\d{2})\b/i);
  if (dayMonthYear?.[1] && dayMonthYear?.[2] && dayMonthYear?.[3]) {
    const month = Number(MONTHS[String(dayMonthYear[2]).toLowerCase()] || 0);
    const day = String(Number(dayMonthYear[1])).padStart(2, '0');
    if (month >= 1 && month <= 12) {
      return `${dayMonthYear[3]}-${String(month).padStart(2, '0')}-${day}`;
    }
  }

  const monthYear = raw.match(/\b(january|jan|januar|february|feb|februar|march|mar|maerz|märz|april|apr|may|mai|june|jun|juni|july|jul|juli|august|aug|september|sep|october|oct|oktober|okt|november|nov|december|dec|dezember|dez)\s+(20\d{2})\b/i);
  if (monthYear?.[1] && monthYear?.[2]) {
    const month = Number(MONTHS[String(monthYear[1]).toLowerCase()] || 0);
    if (month >= 1 && month <= 12) {
      return `${monthYear[2]}-${String(month).padStart(2, '0')}-01`;
    }
  }

  return '';
};

const resolveRowDateInfo = (row = {}) => {
  const extractedContentDate = extractContentDateValue(row.content || row.normalized || '');
  const candidates = [
    ['source_date', row.source_date],
    ['content_time', row.content_time],
    ['valid_from', row.valid_from],
    ['content', extractedContentDate],
    ['updated_at', row.updated_at],
    ['created_at', row.created_at],
    ['last_seen_at', row.last_seen_at],
    ['first_seen_at', row.first_seen_at],
  ];
  for (const [source, candidate] of candidates) {
    const raw = String(candidate || '').trim();
    if (!raw) continue;
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) continue;
    return {
      value: new Date(ms).toISOString().slice(0, 10),
      source,
    };
  }
  return {
    value: '',
    source: '',
  };
};

const isDateWithinWindow = (dateValue = '', temporalWindow = null) => {
  if (!dateValue || !temporalWindow?.startDate || !temporalWindow?.endDate) return false;
  return dateValue >= temporalWindow.startDate && dateValue <= temporalWindow.endDate;
};

const matchesSelectedEntity = (row = {}, selectedEntitySignals = {}, config = {}, mentionMemoryIds = new Set()) => {
  if (!selectedEntitySignals?.entityId || !Array.isArray(selectedEntitySignals.aliases) || selectedEntitySignals.aliases.length === 0) {
    return {
      matched: false,
      reason: 'no_selected_entity',
    };
  }
  const memoryId = String(row.memory_id || '').trim();
  const linkedMemoryId = String(row.linked_memory_id || '').trim();
  if ((memoryId && mentionMemoryIds.has(memoryId)) || (linkedMemoryId && mentionMemoryIds.has(linkedMemoryId))) {
    return {
      matched: true,
      reason: 'entity_mention',
    };
  }
  const haystacks = [
    String(row.content || ''),
    String(row.normalized || ''),
  ].filter(Boolean);
  const normalizedHaystackTokens = tokenizeNormalizedValue([
    String(row.content || ''),
    String(row.normalized || ''),
  ].join(' '));
  for (const alias of selectedEntitySignals.aliases) {
    if (!alias) continue;
    const aliasTokens = tokenizeNormalizedValue(alias);
    if (aliasTokens.length === 0) continue;
    for (const haystack of haystacks) {
      if (containsEntity(haystack, alias, config?.person?.requireWordBoundaryMatch !== false)) {
        return {
          matched: true,
          reason: alias === normalizeContent(selectedEntitySignals.displayName || '') ? 'display_name' : 'alias',
        };
      }
    }
    if (hasTokenSequence(normalizedHaystackTokens, aliasTokens)) {
      return {
        matched: true,
        reason: aliasTokens.length > 1 ? 'alias_phrase' : 'alias_token',
      };
    }
  }
  return {
    matched: false,
    reason: 'no_alias_match',
  };
};

const strategyRankingMode = ({ strategy = '', selectedEntitySignals = {}, config = {} } = {}) => {
  if (config?.orchestrator?.strategyRerankEnabled === false) return 'broad';
  if (config?.orchestrator?.entityLockEnabled === false) return strategy || 'broad';
  if (!selectedEntitySignals?.entityId) return strategy || 'broad';
  if (['entity_brief', 'relationship_brief', 'timeline_brief'].includes(String(strategy || '').trim())) {
    return `${strategy}:entity_locked`;
  }
  return strategy || 'broad';
};

const strategyRerankRecall = ({
  db,
  rows = [],
  strategy = 'quick_context',
  selectedEntity = null,
  temporalWindow = null,
  deepLookupAllowed = false,
  querySignals = {},
  config = {},
} = {}) => {
  if (!Array.isArray(rows) || rows.length === 0 || config?.orchestrator?.strategyRerankEnabled === false) {
    return {
      rows,
      rankingMode: 'broad',
    };
  }

  const selectedEntitySignals = buildSelectedEntitySignals(selectedEntity);
  const rankingMode = strategyRankingMode({ strategy, selectedEntitySignals, config });
  const mentionMemoryIds = (db && selectedEntitySignals.entityId)
    ? buildSelectedEntityMentionMemoryIds(db, rows, selectedEntitySignals)
    : new Set();
  const reranked = rows.map((row) => {
    const baseScore = Number(row?._score || 0);
    const entityMatch = matchesSelectedEntity(row, selectedEntitySignals, config, mentionMemoryIds);
    const rowDate = resolveRowDateInfo(row);
    const temporalMatch = isDateWithinWindow(rowDate.value, temporalWindow);
    const hasTemporalHint = Boolean(temporalWindow);
    const hasSelectedEntity = Boolean(selectedEntitySignals.entityId);
    const isCore = String(row?._class || '') === 'core';
    const isRelationshipish = /\b(?:partner(?:in)?|wife|husband|girlfriend|boyfriend|freund(?:in)?|relationship|beziehung)\b/i
      .test(String(row?.content || ''));
    let entityLockBoost = 0;
    let temporalWindowBoost = 0;
    let strategyPenalty = 0;

    if (strategy === 'entity_brief') {
      if (hasSelectedEntity && entityMatch.matched) entityLockBoost += 0.62;
      else if (hasSelectedEntity && isCore && baseScore >= 1.55) strategyPenalty -= 0.14;
      else if (hasSelectedEntity) strategyPenalty -= 0.68;
    } else if (strategy === 'relationship_brief') {
      if (hasSelectedEntity && entityMatch.matched) entityLockBoost += 0.58;
      else if (hasSelectedEntity) strategyPenalty -= 0.62;
      if (isRelationshipish) entityLockBoost += 0.22;
      else strategyPenalty -= 0.12;
    } else if (strategy === 'timeline_brief') {
      if (entityMatch.matched) entityLockBoost += 0.48;
      else strategyPenalty -= 0.56;
      if (temporalMatch) temporalWindowBoost += 0.38;
      else if (hasTemporalHint) strategyPenalty -= 0.26;
      if (entityMatch.matched && temporalMatch) temporalWindowBoost += 0.18;
      if (!entityMatch.matched && !temporalMatch) strategyPenalty -= 0.42;
    } else if (strategy === 'verification_lookup') {
      if (entityMatch.matched) entityLockBoost += 0.12;
      if (temporalMatch) temporalWindowBoost += 0.08;
      if (!deepLookupAllowed && !entityMatch.matched && hasTemporalHint && !temporalMatch) {
        strategyPenalty -= 0.08;
      }
    }

    const adjustedScore = baseScore + entityLockBoost + temporalWindowBoost + strategyPenalty;
    return {
      ...row,
      _base_score: baseScore,
      _selected_entity_match: entityMatch.matched ? 1 : 0,
      _selected_entity_reason: entityMatch.reason,
      _selected_entity_id: selectedEntitySignals.entityId || '',
      _entity_lock_boost: entityLockBoost,
      _temporal_window_match: temporalMatch ? 1 : 0,
      _temporal_date_source: rowDate.source,
      _temporal_window_boost: temporalWindowBoost,
      _strategy_penalty: strategyPenalty,
      _ranking_mode: rankingMode,
      _score: adjustedScore,
    };
  });

  reranked.sort((a, b) =>
    Number(b?._score || 0) - Number(a?._score || 0)
    || Number(b?._selected_entity_match || 0) - Number(a?._selected_entity_match || 0)
    || Number(b?._temporal_window_match || 0) - Number(a?._temporal_window_match || 0)
    || String(a?.content || '').localeCompare(String(b?.content || '')));

  const entityLockedStrategies = new Set(['entity_brief', 'relationship_brief', 'timeline_brief']);
  let focusedRows = reranked;
  if (selectedEntitySignals.entityId && entityLockedStrategies.has(String(strategy || '').trim())) {
    const entityMatchedRows = reranked.filter((row) => Number(row?._selected_entity_match || 0) === 1);
    if (entityMatchedRows.length > 0) {
      focusedRows = entityMatchedRows;
    }
  } else if (selectedEntitySignals.entityId && strategy === 'verification_lookup') {
    const entityMatchedRows = reranked.filter((row) => Number(row?._selected_entity_match || 0) === 1);
    if (entityMatchedRows.length > 0) {
      focusedRows = entityMatchedRows;
    }
  } else if (!selectedEntitySignals.entityId && strategy === 'timeline_brief' && temporalWindow?.startDate && temporalWindow?.endDate) {
    const temporalRows = reranked.filter((row) => Number(row?._temporal_window_match || 0) === 1);
    const explicitTemporalRows = temporalRows.filter((row) => ['source_date', 'content_time', 'valid_from', 'content'].includes(String(row?._temporal_date_source || '')));
    if (explicitTemporalRows.length > 0) focusedRows = explicitTemporalRows;
    else if (temporalRows.length > 0) focusedRows = temporalRows;
  } else if (!selectedEntitySignals.entityId && temporalWindow?.startDate && temporalWindow?.endDate) {
    const temporalRows = reranked.filter((row) => Number(row?._temporal_window_match || 0) === 1);
    const explicitTemporalRows = temporalRows.filter((row) => ['source_date', 'content_time', 'valid_from', 'content'].includes(String(row?._temporal_date_source || '')));
    if (explicitTemporalRows.length > 0) focusedRows = explicitTemporalRows;
    else if (temporalRows.length > 0) focusedRows = temporalRows;
  }

  return {
    rows: focusedRows,
    rankingMode,
  };
};

const rankActiveRow = (row, querySignals, policy, config = {}, entityKeys = []) => {
  const memoryTier = resolveActiveRowMemoryTier(row, entityKeys);
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
  const typeBoost = typeIntentBoost(row.type, querySignals);
  const relativeTimePenalty = staleRelativePenalty(row);
  const score = semanticMatch + valueScore + recency + scopeWeight(row.scope) + durableBoost + personBoost + entityBoost + entityQualityBoost + typeBoost - noisePenalty - archivePenalty - relativeTimePenalty;
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
    _relative_time_penalty: relativeTimePenalty,
    _memory_tier: memoryTier,
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
  const memoryTier = resolveNativeRowMemoryTier(row, nativeType, entityKeys);
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
  const typeBoost = typeIntentBoost(nativeType, querySignals);
  const relativeTimePenalty = staleRelativePenalty(row);
  const score = semanticMatch + baseValue + recency + scopeWeight(nativeScope) + durableBoost + personBoost + entityBoost + entityQualityBoost + typeBoost - noisePenalty - relativeTimePenalty;
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
    memory_tier: memoryTier,
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
    _relative_time_penalty: relativeTimePenalty,
    _memory_tier: memoryTier,
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
  lines.push('instruction: Use these memories silently. Do not mention source paths, file names, memory ids, internal tags, or recall mechanics unless the user explicitly asks for provenance.');
  if (querySignals?.entityIntent) {
    lines.push('entity_mode: true');
    lines.push('entity_instruction: For "who is / wer ist" questions, prioritize entity_answer_hints first, then supporting memories. If hints exist, do not answer "unknown". If facts conflict, mention uncertainty. If a memory says "today/heute/currently", treat that as relative to the recorded date, not automatically as now.');
    if (entityHints.length > 0) {
      lines.push('entity_answer_hints:');
      for (const hint of entityHints) lines.push(`- ${esc(hint)}`);
    }
  }
  lines.push('memories:');
  for (const row of rows) {
    const rendered = formatMemoryForInjection(row);
    if (!rendered) continue;
    lines.push(`- [${esc(row.type || 'CONTEXT')}] ${esc(rendered)}`);
  }
  lines.push('</gigabrain-context>');
  return `${lines.join('\n')}\n`;
};

const recallForQuery = ({
  db,
  config,
  query,
  scope = '',
  strategyContext = {},
}) => {
  const sanitizedQuery = sanitizeRecallQuery(query);
  const effectiveQuery = sanitizedQuery || String(query || '').trim();
  const policy = resolvePolicy(config);
  const topK = Math.max(1, Number(config?.recall?.topK ?? 8) || 8);
  const requestedScope = scope ? normalizeScope(scope) : '';
  const normalizedScope = requestedScope || 'shared';
  const baseAllowedMemoryTiers = resolveRecallMemoryTiers(strategyContext);
  const temporalWindow = strategyContext?.temporalWindow
    || detectTemporalWindow(effectiveQuery, Number(config?.native?.onDemandTemporalDays ?? 3650));
  const entityKeys = resolveEntityKeysForQuery(db, effectiveQuery, { fallbackTokens: true });
  const querySignals = buildQuerySignals(effectiveQuery, entityKeys);
  const allowedMemoryTiers = querySignals.identityIntent
    ? Array.from(new Set([...baseAllowedMemoryTiers, 'working_reference']))
    : baseAllowedMemoryTiers;
  const allowNonDurableRecall = allowedMemoryTiers.some((tier) => !isDurableMemoryTier(tier));
  const lexicalQuery = querySignals.lexicalTokens?.length > 0
    ? querySignals.lexicalTokens.join(' ')
    : querySignals.focusTokens.length > 0
      ? querySignals.focusTokens.join(' ')
      : effectiveQuery;

  const activeRows = searchCurrentMemories(db, {
    query: lexicalQuery,
    topK: Math.max(topK * 6, 20),
    scope: requestedScope,
    statuses: ['active'],
  });
  const activeRanked = activeRows
    .map((row) => rankActiveRow(row, querySignals, policy, config, entityKeys))
    .filter((row) => allowNonDurableRecall || isDurableMemoryTier(row._memory_tier));
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
    nativeRanked = nativeRanked.filter((row) => allowNonDurableRecall || isDurableMemoryTier(row._memory_tier));
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
      .filter((row) => allowNonDurableRecall || isDurableMemoryTier(row._memory_tier))
      .sort((a, b) => Number(b._score || 0) - Number(a._score || 0));
    candidateRows = archivedRanked;
    fallbackUsed = archivedRanked.length > 0;
  }

  candidateRows = filterRecallRowsByQuality(candidateRows, policy);
  candidateRows = prioritizeEntityRows(candidateRows, querySignals);
  candidateRows = dedupeRowsByContent(candidateRows);
  const reranked = strategyRerankRecall({
    db,
    rows: candidateRows,
    strategy: strategyContext?.strategy || 'quick_context',
    selectedEntity: strategyContext?.selectedEntity || null,
    temporalWindow,
    deepLookupAllowed: strategyContext?.deepLookupAllowed === true,
    querySignals,
    config,
  });
  candidateRows = dedupeRowsBySimilarity(reranked.rows, config);

  const sliced = candidateRows.slice(0, Math.max(topK * 3, 18));
  const budgeted = allocateByBudget(sliced, config);
  const selected = budgeted.selected.slice(0, topK);
  const injection = renderInjection({ rows: selected, query: effectiveQuery, fallbackUsed, querySignals });

  return {
    query: effectiveQuery,
    originalQuery: String(query || ''),
    fallbackUsed,
    temporalWindow,
    entityKeys,
    querySignals,
    results: selected,
    injection,
    rankingMode: reranked.rankingMode,
    memoryTiers: allowedMemoryTiers,
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
  sanitizeRecallQuery,
};
