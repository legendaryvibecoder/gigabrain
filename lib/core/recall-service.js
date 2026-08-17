import fs from 'node:fs';

import { getCurrentMemory, hasTable, searchCurrentMemories } from './projection-store.js';
import { classifyHostTier, hostTrustScore } from './host-trust.js';
import { queryNativeChunks } from './native-sync.js';
import {
  classifyValue,
  isDurable,
  jaccardSimilarity,
  normalizeContent,
  resolvePolicy,
  resolveSemanticThresholds,
} from './policy.js';
import {
  buildEntityMentionScopeFilter,
  containsEntity,
  ensurePersonStore,
  resolveEntityKeysForQuery,
  scorePersonContent,
} from './person-service.js';
import { isDurableMemoryTier, normalizeMemoryTier, resolveMemoryTier } from './world-model.js';
import { bm25Score, tokenize as bm25Tokenize } from './bm25.js';
import {
  hybridFuseRecall,
  crossEncoderRerank,
} from './embedding-service.js';

const NOISE_RE = /\b(?:run:|cron|pipeline|script|todo:|phase\s+\d+|temporary|auto-rejected)\b/i;
const DECISION_HINT_RE = /\b(?:decision|decided|we should|we will|always|rule)\b/i;
const TEMPORAL_HINT_RE = /\b(?:january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|october|oct|november|nov|december|dec|januar|februar|maerz|märz|april|mai|juni|juli|august|september|oktober|november|dezember|this year|last year|next year|diese[msr]? jahr|letzte[sr]? jahr|n[aä]chste[sr]? jahr|20\d{2})\b/i;
const ENTITY_QUERY_HINT_RE = /\b(?:wer ist|wer war|who is|who was|about|über|ueber|tell me about|was weißt du über|was weisst du über)\b/i;
const ENTITY_INSTRUCTION_RE = /\b(?:add to|add new|include|set|remember|update|todo|section|prompt|instruction|feature flag|write to)\b/i;
const ENTITY_FACT_STYLE_RE = /\b(?:\bis\b|\bist\b|\bwas\b|\blives\b|\blebt\b|\bworks\b|\barbeitet\b)\b/i;
const ENTITY_LOW_SIGNAL_RE = /\b(?:no duplicate|duplicate entries|duplikat|kein(?:e|en)? info|unknown|not available|nicht verfügbar|memory search)\b/i;
const ENTITY_SUMMARY_WEAK_RE = /\b(?:mail friend|memory-?notes?|birthday reminder|numeric chat id|chat id|@[\w_]+|username|default engine|voice preset|voice reference|profile image|saved to avatars|api calls needed|tool ignores|verify code|send login code)\b/i;
const ENTITY_STRONG_FACT_RE = /\b(?:partner|partnerin|relationship|beziehung|lives? in|lebt in|works? as|arbeitet als|active in|community|investor|investment|valuation|interview|prefers?|bevorzugt|birthday|geburtstag|current weight|target)\b/i;
// U14-opt fix #3: German identity intent. The English-only pattern let the
// tier filter kill AGENT_IDENTITY rows on 'wer bist du' and 'was weißt du
// über X' (German "who are you" / "what do you know about X") — the dense leg
// found them, the tier cut dropped them. Kept NARROW on purpose: no bare
// 'wer ist' (a person lookup, not agent identity) and no relationship
// phrasings — the tier policy must keep filtering identity rows out of
// clearly non-identity queries.
const IDENTITY_QUERY_RE = /\b(?:about yourself|yourself|who are you|agent identity|my personality|personality|identity|selbst|ueber dich|über dich|wer bist du|was wei(?:ß|ss)t du (?:ü|ue)ber)\b/i;
// U14-opt fix #2 (part 1): 'preference(?:s)?' — the PLURAL ('what are
// jordan's preferences') previously matched NOTHING in this alternation
// ('preference' needs a word boundary, 'prefer(?:s)?' is not 'preferences'),
// so exactly the most natural preference phrasing lost its hint tokens and
// the only in-scope PREFERENCE row never reached the lexical ballot.
const PREFERENCE_QUERY_RE = /\b(?:preference(?:s)?|prefer(?:s)?|favorite|favourite|like(?:s)?|love(?:s)?|hate(?:s)?|dislike(?:s)?|magst du|mag ich|bevorzug(?:e|en|t|st)|lieblings|jahreszeit|season)\b/i;
const SEASON_QUERY_RE = /\b(?:season|jahreszeit|winter|spring|summer|autumn|fall|fruehling|frühling|sommer|herbst)\b/i;
const RELATIVE_TIME_RE = /\b(?:today|heute|yesterday|gestern|tomorrow|currently|right now|at the moment|derzeit|aktuell|just now|heute früh|heute frueh|this morning|this evening|tonight)\b/i;
const DURATION_QUERY_RE = /\b(?:how long|wie lange)\b/i;
const COMPLETION_QUERY_RE = /\b(?:what|which)\s+(?:did|have)\s+i\s+(?:complete|completed|finish|finished|earn|earned|obtain|obtained|pass|passed)\b|\bwhat have i completed\b|\bwhat did i complete\b/i;
const CERTIFICATION_QUERY_RE = /\b(?:what|which)\s+(?:certification|certificate|credential|licen[cs]e)\b|\bwhat\s+(?:certifications|certificates|credentials|licen[cs]es)\b/i;
const DURATION_ANSWER_RE = /\b(?:for|over|about|around|almost|nearly|roughly|more than|less than|under|just over)\s+(?:(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|few|several|couple|a)\s+)?(?:year|month|week|day)s?\b|\bsince\s+(?:20\d{2}|january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|october|oct|november|nov|december|dec)\b/i;
const STARTED_ANSWER_RE = /\b(?:started|begin|began)\b.*\b(?:collecting|working|using|studying|training|building|running|living)\b/i;
const COMPLETION_ANSWER_RE = /\b(?:completed|finished|earned|obtained|passed|received)\b/i;
const CERTIFICATION_ANSWER_RE = /\b(?:certification|certificate|certified|credential|licen[cs]e|exam|course|training|program)\b/i;
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
    rawQuery: text,
    tokens,
    focusTokens: focusTokens.length > 0 ? focusTokens : tokens.slice(0, 10),
    lexicalTokens,
    hasEntityKeys,
    entityIntent,
    identityIntent,
    preferenceIntent,
    answerIntent: {
      duration: DURATION_QUERY_RE.test(text),
      completion: COMPLETION_QUERY_RE.test(text),
      certification: CERTIFICATION_QUERY_RE.test(text),
    },
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

const exactQueryTokenBoost = (querySignals = {}, content = '') => {
  const tokens = Array.isArray(querySignals?.focusTokens) ? querySignals.focusTokens : [];
  if (tokens.length === 0) return 0;
  const contentTokens = new Set(tokenizeNormalizedValue(content));
  let boost = 0;
  for (const token of tokens) {
    if (!contentTokens.has(token)) continue;
    if (/\d/.test(token) && token.length >= 4) boost += 2.4;
    else if (token.length >= 8) boost += 0.3;
  }
  return Math.min(2.8, boost);
};

const hasIdentifierLookupIntent = (querySignals = {}) => {
  const tokens = Array.isArray(querySignals?.focusTokens) ? querySignals.focusTokens : [];
  return tokens.some((token) => /\d/.test(token) && String(token || '').length >= 4);
};

/**
 * BM25-based relevance score for a single row, using approximate corpus stats.
 * Returns a value normalized to roughly 0–1 range to stay compatible with
 * the existing score arithmetic (which was calibrated around overlapScore).
 *
 * @param {string[]} queryTokens  - pre-tokenized query (may come from focusTokens)
 * @param {string}   content      - raw memory content
 * @param {Object}   [corpusStats] - { avgDl, docCount, df }
 * @returns {number}
 */
const bm25ScoreForRow = (queryTokens, content, corpusStats) => {
  const qTokens = bm25Tokenize(
    Array.isArray(queryTokens) ? queryTokens.join(' ') : String(queryTokens || ''),
  );
  const docTokens = bm25Tokenize(String(content || ''));
  if (qTokens.length === 0 || docTokens.length === 0) return 0;

  const avgDl = corpusStats?.avgDl ?? 50;
  const docCount = corpusStats?.docCount ?? 200;
  const df = corpusStats?.df ?? {};

  const raw = bm25Score({ queryTokens: qTokens, docTokens, avgDl, docCount, df });

  // Normalize: typical BM25 peaks around 8-12 for strong matches in small corpora.
  // Sigmoid squash maps that to ~0.7-0.85, keeping the 0-1 range overlapScore used.
  return raw / (raw + 4);
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
  // The native query layer resolves a linked active registry row (or an
  // explicit chunk scope) before source-kind defaults. Preserve that effective
  // scope here. Source-kind defaults apply only to genuinely unscoped rows.
  const explicitScope = String(row?.scope || requestedScope || '').trim();
  if (explicitScope) return normalizeScope(explicitScope);
  if (String(row?.source_kind || '') === 'curated') return 'shared';
  if (String(row?.source_kind || '') === 'memory_md') return 'profile:main';
  // E2: belt-and-suspenders. E1 already stamps vault rows scope='profile:user'
  // at write time (and queryNativeChunks surfaces that via chunk.scope), so this
  // branch is normally redundant — but it pins the scope at the ranking layer
  // too, so a vault row can never silently inherit the requested query scope.
  if (String(row?.source_kind || '') === 'vault') return 'profile:user';
  return 'shared';
};

// E2: vault rows carry an ABSOLUTE source_path on disk (E1 stores the resolved
// realPath). For the injection label we must emit the vault-RELATIVE path ONLY —
// never a /Users/... absolute — so provenance is legible without leaking the
// host filesystem layout. Strip the longest configured vault root that is a
// prefix of the path; fall back to the basename so we still never emit an
// absolute path even if no root matches (defensive).
const vaultRelativeSourcePath = (sourcePath, config = {}) => {
  const raw = String(sourcePath || '').trim();
  if (!raw) return '';
  const roots = Array.isArray(config?.native?.vaults)
    ? config.native.vaults
        .map((vault) => String(vault?.path || '').trim())
        .filter(Boolean)
        // Longest root first so nested vaults strip the most specific prefix.
        .sort((a, b) => b.length - a.length)
    : [];
  for (const root of roots) {
    const normRoot = root.endsWith('/') ? root : `${root}/`;
    if (raw === root) return '';
    if (raw.startsWith(normRoot)) {
      return raw.slice(normRoot.length).replace(/^\/+/, '');
    }
  }
  // No configured root matched (e.g. ranking a row whose vault was reconfigured):
  // emit the basename only — still never an absolute path.
  const idx = raw.lastIndexOf('/');
  return idx >= 0 ? raw.slice(idx + 1) : raw;
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

// Question-shape matching separates factual answers from superficially similar
// preferences. A small development regression set improved across every
// recorded metric; keep the scorer bounded so generic recall remains unchanged.
const answerIntentBoost = (content, querySignals, semanticMatch = 0) => {
  if (!querySignals?.answerIntent || semanticMatch < 0.2) return 0;
  const raw = String(content || '').trim();
  const normalized = normalizeRecallContent(raw);
  if (!normalized) return 0;

  let boost = 0;
  if (querySignals.answerIntent.duration && (DURATION_ANSWER_RE.test(raw) || STARTED_ANSWER_RE.test(raw))) {
    boost += 0.24;
  }
  if (querySignals.answerIntent.completion && COMPLETION_ANSWER_RE.test(raw)) {
    boost += 0.2;
  }
  if (querySignals.answerIntent.certification && CERTIFICATION_ANSWER_RE.test(raw)) {
    boost += 0.22;
    if (COMPLETION_ANSWER_RE.test(raw)) boost += 0.06;
  }
  return Math.min(boost, 0.3);
};

const factualAnswerTypeBoost = (row, querySignals, semanticMatch = 0) => {
  if (!querySignals?.answerIntent || semanticMatch < 0.2) return 0;
  const type = String(row?.type || '').toUpperCase();
  if (!['USER_FACT', 'EPISODE', 'DECISION'].includes(type)) return 0;
  const raw = String(row?.content || row?.normalized || '').trim();
  const normalized = normalizeRecallContent(raw);
  if (!normalized) return 0;

  let boost = type === 'USER_FACT' ? 0.08 : 0;
  if (querySignals.answerIntent.duration && (DURATION_ANSWER_RE.test(raw) || STARTED_ANSWER_RE.test(raw))) {
    boost += type === 'USER_FACT' ? 0.1 : 0.06;
  }
  if (querySignals.answerIntent.completion && COMPLETION_ANSWER_RE.test(raw)) {
    boost += type === 'USER_FACT' ? 0.08 : 0.05;
  }
  if (querySignals.answerIntent.certification && CERTIFICATION_ANSWER_RE.test(raw)) {
    boost += type === 'USER_FACT' ? 0.08 : 0.05;
  }
  return Math.min(boost, 0.18);
};

const factualPreferencePenalty = (row, querySignals) => {
  const type = String(row?.type || '').toUpperCase();
  if (type !== 'PREFERENCE' || !querySignals?.answerIntent) return 0;
  if (querySignals.answerIntent.duration) return 0.34;
  if (querySignals.answerIntent.completion || querySignals.answerIntent.certification) return 0.26;
  return 0;
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

const dedupeRowsBySimilarity = (rows = [], config = {}, conflictIds = new Set()) => {
  if (!Array.isArray(rows) || rows.length <= 1) return rows;
  const kept = [];
  for (const row of rows) {
    const content = String(row?.content || '').trim();
    if (!content) continue;
    // U15 (scenario 4): rival positions in an unresolved conflict usually
    // differ by ONE token ("…at Acme" vs "…at Globex") and would collapse as
    // near-duplicates — that IS the silent pick this unit forbids. Rows that
    // belong to an open conflict are exempt from similarity dedupe (exact
    // content duplicates were already collapsed upstream by
    // dedupeRowsByContent); both rivals surface, flagged.
    const inConflict = conflictIds.has(String(row?.memory_id || '').trim());
    const thresholds = resolveSemanticThresholds(row?.type || 'CONTEXT', config);
    const similarityThreshold = Math.max(0.86, Math.min(0.97, Number(thresholds.auto || 0.92) - 0.04));
    const isNearDuplicate = !inConflict && kept.some((existing) => {
      if (conflictIds.has(String(existing?.memory_id || '').trim())) return false;
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

const buildSelectedEntityMentionMemoryIds = (db, rows = [], selectedEntitySignals = {}, scope = 'shared') => {
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
  const scopeFilter = buildEntityMentionScopeFilter(scope, 'scope');
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
          AND ${scopeFilter.sql}
      `).all(...memoryChunk, ...keyChunk, ...scopeFilter.params);
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
  entityIds = [],
  multiEntities = [],
  scope = 'shared',
} = {}) => {
  if (!Array.isArray(rows) || rows.length === 0 || config?.orchestrator?.strategyRerankEnabled === false) {
    return {
      rows,
      rankingMode: 'broad',
    };
  }

  const selectedEntitySignals = buildSelectedEntitySignals(selectedEntity);
  const multiEntitySignals = Array.isArray(multiEntities)
    ? multiEntities
      .map((entity) => buildSelectedEntitySignals(entity))
      .filter((signals) => signals.entityId && signals.aliases.length > 0)
    : [];
  const rankingMode = strategyRankingMode({ strategy, selectedEntitySignals, config });
  const mentionMemoryIds = (db && selectedEntitySignals.entityId)
    ? buildSelectedEntityMentionMemoryIds(db, rows, selectedEntitySignals, scope)
    : new Set();
  const multiEntityMentionMemoryIds = (db && multiEntitySignals.length > 0)
    ? new Map(multiEntitySignals.map((signals) => ([
      signals.entityId,
      buildSelectedEntityMentionMemoryIds(db, rows, signals, scope),
    ])))
    : new Map();
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
    } else if (
      strategy === 'multi_entity_brief'
      && ((Array.isArray(entityIds) && entityIds.length >= 2) || multiEntitySignals.length >= 2)
    ) {
      const multiMatches = multiEntitySignals.map((signals) => matchesSelectedEntity(
        row,
        signals,
        config,
        multiEntityMentionMemoryIds.get(signals.entityId) || new Set(),
      ));
      const matchedCount = multiMatches.filter((match) => match.matched).length;
      if (matchedCount >= 2) entityLockBoost += 0.62;
      else if (matchedCount === 1) entityLockBoost += 0.2;
      if (entityMatch.matched) entityLockBoost += 0.45;
      else if (matchedCount === 0) strategyPenalty -= 0.52;
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
  // U14-followup-2 (a): the entity-lock FOCUS FILTER used to do a hard
  // pool-replacement — when a selected entity matched, every in-pool row that
  // did NOT textually match the entity was DROPPED, even strong gold rows. That
  // throws recall away whenever the answer lives in a row that doesn't repeat the
  // entity's own name (e.g. "who is X's partner" -> the partner row). The relaxed
  // behavior is a SOFT demotion (fill-the-tail): matched rows lead, non-matching
  // rows are kept in their existing rank order behind them rather than removed.
  // NOTE: this is a NEW use of config.orchestrator.entityLockEnabled at the
  // focus-filter site. Line 788's check gates STRATEGY SELECTION; here it gates
  // whether the focus filter demotes (relaxed, default) or hard-drops (legacy).
  const softEntityFocus = config?.orchestrator?.entityLockEnabled !== false;
  let focusedRows = reranked;
  if (selectedEntitySignals.entityId && entityLockedStrategies.has(String(strategy || '').trim())) {
    const entityMatchedRows = reranked.filter((row) => Number(row?._selected_entity_match || 0) === 1);
    if (entityMatchedRows.length > 0) {
      if (softEntityFocus) {
        const nonMatchedRows = reranked.filter((row) => Number(row?._selected_entity_match || 0) !== 1);
        focusedRows = [...entityMatchedRows, ...nonMatchedRows];
      } else {
        focusedRows = entityMatchedRows;
      }
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

// Recall-boundary liveness guard (KTD6, R1/R9): superseded and rejected rows
// must never re-enter injected context from any leg, and a row whose valid-time
// window has closed (valid_until < now) is no longer a current fact — it is
// hard-filtered, not ranked lower. Archival of expired rows is nightly
// maintenance scope; only the recall filter lives here.
const isLiveRecallRow = (row) => {
  const status = String(row?.status || '').toLowerCase();
  if (status === 'superseded' || status === 'rejected') return false;
  const validUntilMs = Date.parse(String(row?.valid_until || ''));
  if (Number.isFinite(validUntilMs) && validUntilMs < Date.now()) return false;
  return true;
};

const rankActiveRow = (row, querySignals, policy, config = {}, entityKeys = []) => {
  if (!isLiveRecallRow(row)) return null;
  const memoryTier = resolveActiveRowMemoryTier(row, entityKeys);
  const content = row.content || row.normalized || '';
  // Primary lexical relevance is the corpus-weighted FTS5 bm25() score
  // (projection-store attaches it as _fts_bm25, normalized to [0,1]). Fall back to
  // the hand-rolled bm25 only when FTS5 is unavailable, so recall degrades
  // gracefully instead of breaking.
  const semanticMatch = Number.isFinite(Number(row._fts_bm25)) && Number(row._fts_bm25) > 0
    ? Number(row._fts_bm25)
    : bm25ScoreForRow(querySignals?.focusTokens || [], row.content || row.normalized || '');
  const exactTokenBoost = exactQueryTokenBoost(querySignals, content);
  const valueScore = Number.isFinite(Number(row.value_score)) ? Number(row.value_score) : 0;
  // Recency must come from event time, not updated_at: maintenance passes
  // (audit/sync) rewrite updated_at in bulk, which collapses recency into a
  // single value across the store.
  const recency = recencyDecayScore(row.content_time || row.valid_from || row.created_at || row.updated_at);
  const durableBoost = isDurable(row.content || '', {
    enabled: policy.durableEnabled,
    patterns: policy.durablePatterns,
  }) ? 0.18 : 0;
  const noisePenalty = NOISE_RE.test(String(row.content || '')) ? 0.12 : 0;
  const archivePenalty = String(row.status || '') === 'archived' ? 0.2 : 0;
  const entityMatched = hasEntityMatch(content, entityKeys, config);
  const entityBoost = entityPriorityBoost({ entityMatched, querySignals });
  const person = scorePersonContent({
    content,
    entityKeys,
    config,
  });
  const personBoost = Number(person?.score || 0);
  const entityQualityBoost = entityAnswerQualityBoost(content, querySignals, entityMatched);
  const typeBoost = typeIntentBoost(row.type, querySignals);
  const answerBoost = answerIntentBoost(content, querySignals, semanticMatch);
  const factualTypeBoost = factualAnswerTypeBoost(row, querySignals, semanticMatch);
  const preferencePenalty = factualPreferencePenalty(row, querySignals);
  const relativeTimePenalty = staleRelativePenalty(row);
  const score = semanticMatch + exactTokenBoost + valueScore + recency + scopeWeight(row.scope) + durableBoost + personBoost + entityBoost + entityQualityBoost + typeBoost + answerBoost + factualTypeBoost - noisePenalty - archivePenalty - preferencePenalty - relativeTimePenalty;
  return {
    ...row,
    _semantic_match: semanticMatch,
    _exact_token_boost: exactTokenBoost,
    _value_score: valueScore,
    _recency_decay: recency,
    _scope_weight: scopeWeight(row.scope),
    _durable_boost: durableBoost,
    _entity_match: entityMatched ? 1 : 0,
    _entity_boost: entityBoost,
    _entity_quality_boost: entityQualityBoost,
    _answer_intent_boost: answerBoost,
    _factual_answer_type_boost: factualTypeBoost,
    _factual_preference_penalty: preferencePenalty,
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
  // E2: vault rows are the READ-ONLY reference corpus. They rank through the
  // exact same native path as any other chunk, but NEVER above a native memory:
  // their base value sits below the lowest native source value (daily_note 0.58),
  // and their match contribution is scaled by the NEUTRAL recall.vaultWeight knob
  // (default 1.0; clamped to <= 1.0 in config so vault can be demoted but never
  // promoted past parity). v1 is lexical-only — dense vault ranking is a measured
  // follow-up; vault chunks here just need to be retrievable + clearly labeled.
  const isVault = sourceKind === 'vault';
  const nativeType = inferNativeType(row);
  // queryNativeChunks resolves the effective scope through an active linked
  // registry row. Preserve that resolved scope in the returned provenance;
  // otherwise an authorized project memory written through the native mirror
  // is mislabeled as `shared` even though visibility was correctly decided by
  // the linked project scope.
  const nativeScope = inferNativeScope(row, row?.scope || '');
  const memoryTier = resolveNativeRowMemoryTier(row, nativeType, entityKeys);
  const rawSemanticMatch = Number.isFinite(Number(row._fts_bm25)) && Number(row._fts_bm25) > 0
    ? Number(row._fts_bm25)
    : Number.isFinite(Number(row.score_lexical))
      ? Number(row.score_lexical)
      : bm25ScoreForRow(querySignals?.focusTokens || [], row.content || row.normalized || '');
  const vaultWeight = isVault
    ? Math.min(1.0, Math.max(0, Number(config?.recall?.vaultWeight ?? 1.0)) || 1.0)
    : 1.0;
  const semanticMatch = isVault ? rawSemanticMatch * vaultWeight : rawSemanticMatch;
  const exactTokenBoost = exactQueryTokenBoost(querySignals, row.content || row.normalized || '');
  const baseValue = sourceKind === 'memory_md'
    ? 0.9
    : sourceKind === 'curated'
      ? 0.75
      : isVault
        ? 0.5
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
  const answerBoost = answerIntentBoost(row.content || row.normalized || '', querySignals, semanticMatch);
  const factualTypeBoost = factualAnswerTypeBoost({ ...row, type: nativeType }, querySignals, semanticMatch);
  const preferencePenalty = factualPreferencePenalty({ ...row, type: nativeType }, querySignals);
  const relativeTimePenalty = staleRelativePenalty(row);
  const score = semanticMatch + exactTokenBoost + baseValue + recency + scopeWeight(nativeScope) + durableBoost + personBoost + entityBoost + entityQualityBoost + typeBoost + answerBoost + factualTypeBoost - noisePenalty - preferencePenalty - relativeTimePenalty;
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
    _exact_token_boost: exactTokenBoost,
    _value_score: baseValue,
    _recency_decay: recency,
    _scope_weight: scopeWeight(nativeScope),
    _durable_boost: durableBoost,
    _entity_match: entityMatched ? 1 : 0,
    _entity_boost: entityBoost,
    _entity_quality_boost: entityQualityBoost,
    _answer_intent_boost: answerBoost,
    _factual_answer_type_boost: factualTypeBoost,
    _factual_preference_penalty: preferencePenalty,
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
    // E2: vault marker + the vault-RELATIVE path used for the [src:vault <path>]
    // injection label. The absolute source_path NEVER reaches the injection.
    _is_vault: isVault,
    _vault_rel_path: isVault ? vaultRelativeSourcePath(row.source_path, config) : '',
    _vault_weight: isVault ? vaultWeight : undefined,
  };
};

// Phase 3B: Strategy-specific adaptive budget profiles
const ADAPTIVE_BUDGET_PROFILES = Object.freeze({
  quick_context:     { maxTokens: 800,  core: 0.5,  situational: 0.3, decisions: 0.2 },
  entity_brief:      { maxTokens: 1200, core: 0.3,  situational: 0.5, decisions: 0.2 },
  timeline_brief:    { maxTokens: 1400, core: 0.2,  situational: 0.6, decisions: 0.2 },
  multi_entity_brief:{ maxTokens: 1800, core: 0.3,  situational: 0.5, decisions: 0.2 },
  verification_lookup:{ maxTokens: 1600, core: 0.2,  situational: 0.3, decisions: 0.5 },
  relationship_brief:{ maxTokens: 1200, core: 0.3,  situational: 0.5, decisions: 0.2 },
  contradiction_check:{ maxTokens: 1400, core: 0.2,  situational: 0.3, decisions: 0.5 },
});

const resolveAdaptiveBudget = (strategy, config = {}) => {
  if (config?.recall?.adaptiveBudgeting?.enabled === false) return null;
  const overrides = config?.recall?.adaptiveBudgeting?.profiles || {};
  const profileKey = String(strategy || 'quick_context').trim();
  const base = ADAPTIVE_BUDGET_PROFILES[profileKey] || ADAPTIVE_BUDGET_PROFILES.quick_context;
  const override = overrides[profileKey] || {};
  return {
    maxTokens: Number(override.maxTokens || base.maxTokens),
    core: Number(override.core ?? base.core),
    situational: Number(override.situational ?? base.situational),
    decisions: Number(override.decisions ?? base.decisions),
  };
};

const allocateByBudget = (rankedRows, config = {}, strategyContext = {}) => {
  const adaptiveBudget = resolveAdaptiveBudget(strategyContext?.strategy, config);
  const maxTokens = adaptiveBudget
    ? Math.max(100, adaptiveBudget.maxTokens)
    : Math.max(100, Number(config?.recall?.maxTokens ?? 1200) || 1200);
  const budgets = adaptiveBudget
    ? { core: adaptiveBudget.core, situational: adaptiveBudget.situational, decisions: adaptiveBudget.decisions }
    : (config?.recall?.classBudgets || { core: 0.45, situational: 0.3, decisions: 0.25 });
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

// ---------------------------------------------------------------------------
// U15: provenance-stamped recall. Every selected row carries
// {source_agent, trust_tier, trust_score, verdict_ref?, valid_window,
//  unresolved_conflict} so agents consume the arbitrated, de-conflicted view
// BY DEFAULT and can drill into "why" via gigabrain_arbitrate /
// gigabrain_adjudications over the SAME ledger data. Privacy line (matches the
// existing injection contract): file paths / source_path NEVER appear in the
// injection; agent identity, trust tier, and validity window are now visible
// BY DESIGN — that is the product.
// ---------------------------------------------------------------------------

// Unresolved-conflict surface (plan scenario 4): rows that belong to an OPEN
// contradiction_review loop (the arbiter's uncertain conflict groups) or to a
// pending capture_contradiction_* review-queue entry are flagged, never
// silently picked. Cheapest correct join: one indexed query over
// memory_open_loops (idx_memory_open_loops_kind) + one bounded read of the
// review-queue JSONL (retention caps it at ~2000 rows) per recall — no
// per-row scans.
const buildUnresolvedConflictIds = (db, config = {}) => {
  const out = new Set();
  if (db && hasTable(db, 'memory_open_loops')) {
    const rows = db.prepare(`
      SELECT source_memory_ids
      FROM memory_open_loops
      WHERE kind = 'contradiction_review' AND status = 'open'
      LIMIT 1000
    `).all();
    for (const row of rows) {
      try {
        for (const id of JSON.parse(String(row.source_memory_ids || '[]'))) {
          const value = String(id || '').trim();
          if (value) out.add(value);
        }
      } catch { /* malformed loop row: skip, never break recall */ }
    }
  }
  const queuePath = String(config?.runtime?.paths?.reviewQueuePath || '').trim();
  if (queuePath) {
    let raw = '';
    try {
      raw = fsReadQueueFile(queuePath);
    } catch { raw = ''; }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.includes('capture_contradiction')) continue;
      try {
        const row = JSON.parse(trimmed);
        if (String(row?.status || '').toLowerCase() !== 'pending') continue;
        const reason = String(row?.reason || row?.reason_code || '').toLowerCase();
        if (!reason.startsWith('capture_contradiction')) continue;
        for (const id of [row?.matched_memory_id, row?.payload?.target_id]) {
          const value = String(id || '').trim();
          if (value) out.add(value);
        }
      } catch { /* malformed queue line: skip */ }
    }
  }
  return out;
};

const fsReadQueueFile = (queuePath) => {
  if (!fs.existsSync(queuePath)) return '';
  return fs.readFileSync(queuePath, 'utf8');
};

const monthOf = (value) => {
  const ms = Date.parse(String(value || ''));
  if (!Number.isFinite(ms)) return '';
  return new Date(ms).toISOString().slice(0, 7);
};

// Attach provenance to the SELECTED rows only (<= topK after budgeting), so the
// verdict-ref lookup stays O(topK) prepared-statement hits, never a table scan.
// verdict_ref = the latest arbiter:verdict ledger event in which this row is
// the recorded winner — the SAME event gigabrain_arbitrate reports, so the
// drill-down is over identical data (R12 parity).
const attachRecallProvenance = ({ db, config = {}, rows = [], conflictIds = new Set() }) => {
  if (!Array.isArray(rows) || rows.length === 0) return rows;
  const verdictStmt = (db && hasTable(db, 'memory_events'))
    ? db.prepare(`
      SELECT event_id FROM memory_events
      WHERE action = 'arbiter:verdict' AND memory_id = ?
      ORDER BY timestamp DESC, rowid DESC
      LIMIT 1
    `)
    : null;
  return rows.map((row) => {
    const memoryId = String(row?.memory_id || '').trim();
    const isNative = memoryId.startsWith('native:');
    // The ranked-row SELECTs deliberately omit source columns (lean scoring
    // path); hydrate them here for the <= topK selected rows only.
    // Selected ranking rows intentionally carry only a subset of provenance
    // columns. Hydrate every selected registry row: checking source_agent OR
    // source_host was incorrect because a lean row can carry source_host while
    // still omitting source_agent. This remains O(topK), never a table scan.
    const localRow = (!isNative && db)
      ? (getCurrentMemory(db, memoryId) || {})
      : {};
    const sourceAgent = String(row?.source_agent || localRow.source_agent || '').trim() || null;
    // Native chunks are the agent's own memory surface; registry rows carry a
    // source_host ('gigabrain' default). Tier comes from the host-trust model
    // — the same signal the arbiter resolves on, never a separate scale.
    const trustHost = String(row?.source_host || localRow.source_host || '').trim() || (isNative ? 'native' : 'gigabrain');
    const verdictRef = (!isNative && verdictStmt)
      ? String(verdictStmt.get(memoryId)?.event_id || '') || null
      : null;
    const linkedId = String(row?.linked_memory_id || '').trim();
    return {
      ...row,
      source_agent: sourceAgent,
      trust_tier: classifyHostTier(trustHost),
      trust_score: hostTrustScore(trustHost, config),
      verdict_ref: verdictRef,
      valid_window: {
        from: String(row?.valid_from || row?.created_at || localRow.valid_from || '').trim() || null,
        until: String(row?.valid_until || localRow.valid_until || '').trim() || null,
      },
      unresolved_conflict: conflictIds.has(memoryId) || (linkedId !== '' && conflictIds.has(linkedId)),
    };
  });
};

// Compact per-row provenance suffix for the injection. Token budget matters:
// one short bracket per row — `[src:<agent> t:<trust> since:<YYYY-MM>]`, plus
// ` v:<verdict-ref-prefix>` only when the row is a recorded arbitration winner
// (the full verdict_ref rides the structured results; the suffix is a
// correlation handle). Conflict flag is a separate fixed marker so agents can
// match it literally. Paths/ids stay out — privacy boundary unchanged.
const formatProvenanceSuffix = (row = {}) => {
  // E2: vault rows get an origin label that distinguishes reference context from
  // belief — `[src:vault <vault-relative-path>]`. The path is ALWAYS the
  // vault-relative one (computed in rankNativeRow); an absolute /Users/... path
  // must NEVER appear here. No trust/since/verdict fields: vault is reference,
  // not an arbitrated memory, so attaching a trust score would misrepresent it.
  if (row._is_vault === true || String(row.source_kind || '') === 'vault') {
    const rel = String(row._vault_rel_path || '').trim();
    return rel ? ` [src:vault ${rel}]` : ' [src:vault]';
  }
  const src = String(row.source_agent || '').trim()
    || String(row.source_host || '').trim()
    || (String(row.memory_id || '').startsWith('native:') ? 'native' : 'unknown');
  const parts = [`src:${src}`];
  const trustScore = Number(row.trust_score);
  if (Number.isFinite(trustScore)) parts.push(`t:${trustScore.toFixed(2)}`);
  const since = monthOf(row?.valid_window?.from);
  if (since) parts.push(`since:${since}`);
  const verdictRef = String(row.verdict_ref || '').trim();
  if (verdictRef) parts.push(`v:${verdictRef.slice(0, 8)}`);
  let suffix = ` [${parts.join(' ')}]`;
  if (row.unresolved_conflict === true) suffix += ' [unresolved-conflict]';
  return suffix;
};

const renderInjection = ({
  rows,
  query,
  fallbackUsed,
  querySignals,
}) => {
  const esc = (s) => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const safeRows = Array.isArray(rows) ? rows : [];
  const bootstrapMode = safeRows.length === 0;
  const entityHints = buildEntityAnswerHints(safeRows, querySignals);
  const lines = [];
  lines.push('<gigabrain-context>');
  lines.push(`query: ${esc(query)}`);
  lines.push(`fallback: ${fallbackUsed ? 'archived' : 'active_or_native'}`);
  lines.push(`bootstrap_mode: ${bootstrapMode ? 'true' : 'false'}`);
  // U15: provenance is visible BY DESIGN — each memory line ends with a compact
  // [src:<agent> t:<trust> since:<YYYY-MM>] stamp (plus v:<ref> for arbitration
  // winners). The old hide-everything instruction is gone; only the privacy
  // boundary remains: file paths / memory ids are never rendered, so the
  // instruction no longer needs to suppress them — it forbids inventing them.
  lines.push('instruction: Use these memories. Each memory line ends with compact provenance [src:<agent> t:<trust 0-1> since:<YYYY-MM>] — the source agent, its trust score, and when the fact became valid; v:<ref> marks a recorded arbitration winner. You may cite agent, trust, or validity when relevant. Never mention file paths or internal recall mechanics.');
  lines.push('capture_instruction: Only emit memory_note tags when the user explicitly asks to remember or save information.');
  lines.push('capture_instruction: Never place secrets, credentials, tokens, or API keys in memory notes.');
  if (querySignals?.entityIntent) {
    lines.push('entity_mode: true');
    lines.push('entity_instruction: For "who is / wer ist" questions, prioritize entity_answer_hints first, then supporting memories. If hints exist, do not answer "unknown". If facts conflict, mention uncertainty. If a memory says "today/heute/currently", treat that as relative to the recorded date, not automatically as now.');
    if (entityHints.length > 0) {
      lines.push('entity_answer_hints:');
      for (const hint of entityHints) lines.push(`- ${esc(hint)}`);
    }
  }
  // Phase 3C: Confidence signals in injection. When hybrid fusion ran, the
  // per-row signal is the leg-normalized strength percentile (_hybrid_strength)
  // — the fused _score is a small-magnitude ORDERING channel (Borda total),
  // never a confidence. Lexical-only rows keep _score/confidence as before.
  const rowConfidence = (r) => {
    const hybridStrength = Number(r?._hybrid_strength);
    if (Number.isFinite(hybridStrength)) return hybridStrength;
    return Number(r?._score || r?.confidence || 0);
  };
  const evidenceCount = safeRows.length;
  const avgConfidence = evidenceCount > 0
    ? safeRows.reduce((sum, r) => sum + rowConfidence(r), 0) / evidenceCount
    : 0;
  const coverage = avgConfidence >= 0.7 ? 'high' : avgConfidence >= 0.45 ? 'medium' : 'low';
  lines.push(`recall_confidence: ${avgConfidence.toFixed(2)}`);
  lines.push(`evidence: ${evidenceCount} memories`);
  lines.push(`coverage: ${coverage}`);
  // U15: rows inside a review-queued / uncertain conflict are FLAGGED, never
  // silently picked — the agent sees both rivals plus the marker.
  if (safeRows.some((row) => row.unresolved_conflict === true)) {
    lines.push('conflict_instruction: Memories marked [unresolved-conflict] disagree with another memory and no verdict has been recorded yet. Do not silently pick one; surface the conflict if it matters to the answer.');
  }
  lines.push('memories:');
  if (bootstrapMode) {
    lines.push('- [CONTEXT] No recalled memories matched this query yet. Answer normally and avoid inventing prior context.');
  }
  for (const row of safeRows) {
    const rendered = formatMemoryForInjection(row);
    if (!rendered) continue;
    // U14: when hybrid fusion ran, the strength label reads the leg-normalized
    // percentile (_hybrid_strength in (0,1], top fused row = 1.0) — never the
    // fused ordering magnitude, which is tiny and would mislabel rows "weak".
    const score = rowConfidence(row);
    const strength = score >= 0.7 ? 'strong' : score >= 0.45 ? 'medium' : 'weak';
    lines.push(`- [${strength}] [${esc(row.type || 'CONTEXT')}] ${esc(rendered)}${esc(formatProvenanceSuffix(row))}`);
  }
  lines.push('</gigabrain-context>');
  return `${lines.join('\n')}\n`;
};

const recallForQuery = ({
  db,
  config,
  query,
  scope = '',
  scopeVisibility = {},
  strategyContext = {},
}) => {
  const sanitizedQuery = sanitizeRecallQuery(query);
  const effectiveQuery = sanitizedQuery || String(query || '').trim();
  const policy = resolvePolicy(config);
  const topK = Math.max(1, Number(config?.recall?.topK ?? 8) || 8);
  const requestedScope = scope ? normalizeScope(scope) : '';
  const normalizedScope = requestedScope || 'shared';
  const includeProfile = scopeVisibility.includeProfile !== false;
  const includeShared = scopeVisibility.includeShared !== false;
  const baseAllowedMemoryTiers = resolveRecallMemoryTiers(strategyContext);
  const temporalWindow = strategyContext?.temporalWindow
    || detectTemporalWindow(effectiveQuery, Number(config?.native?.onDemandTemporalDays ?? 3650));
  const entityKeys = resolveEntityKeysForQuery(db, effectiveQuery, {
    fallbackTokens: true,
    scope: requestedScope || normalizedScope,
    includeShared,
  });
  const querySignals = buildQuerySignals(effectiveQuery, entityKeys);
  const hasFactualAnswerIntent = Object.values(querySignals.answerIntent || {}).some(Boolean);
  // The verified Memory Studio scorer predates the durable-tier recall floor.
  // Let tightly bounded factual question shapes inspect working references;
  // otherwise the correct fact can be filtered out before the scorer runs.
  const allowedMemoryTiers = (querySignals.identityIntent || hasIdentifierLookupIntent(querySignals) || hasFactualAnswerIntent)
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
    includeProfile,
    includeShared,
  });
  const activeRanked = activeRows
    .map((row) => rankActiveRow(row, querySignals, policy, config, entityKeys))
    .filter(Boolean)
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
      includeShared,
      startDate: temporalWindow?.startDate || '',
      endDate: temporalWindow?.endDate || '',
      limit: Math.max(topK * 8, 40),
      entityKeys,
    });
    nativeRanked = nativeRows.map((row) => rankNativeRow(row, querySignals, config, entityKeys));
    // E2: vault rows are an EXPLICIT read-only reference corpus and are exempt
    // from the durable-tier gate (which exists to keep noisy non-durable native
    // daily-notes out of default recall). Vault content is inherently
    // working_reference-tier yet was deliberately ingested to be retrievable, so
    // gating it on durability would make it permanently invisible. This exemption
    // touches vault rows ONLY — the recall-floor fixture has zero vault rows, so
    // the no-vault floor path is unaffected.
    nativeRanked = nativeRanked.filter((row) => row._is_vault === true || allowNonDurableRecall || isDurableMemoryTier(row._memory_tier));
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
      includeProfile,
      includeShared,
    });
    const archivedRanked = archivedRows
      .map((row) => rankActiveRow(row, querySignals, policy, config, entityKeys))
      .filter(Boolean)
      .filter((row) => allowNonDurableRecall || isDurableMemoryTier(row._memory_tier))
      .sort((a, b) => Number(b._score || 0) - Number(a._score || 0));
    candidateRows = archivedRanked;
    fallbackUsed = archivedRanked.length > 0;
  }

  if (config?.recall?.semanticRerankEnabled === true) {
    // Hybrid retrieval (U14-opt): fuse the lexical (FTS5 bm25) ranking with a
    // dense bge-m3 cosine ranking via weighted Borda-count rank aggregation.
    // Runs even when the lexical candidate set is EMPTY — zero-token-overlap
    // (e.g. cross-lingual) queries are recovered by the dense-only ballot.
    // Scope is threaded as a function parameter; degrades to lexical order when
    // the query embedding is unavailable (Ollama down / offline / cold cache).
    const fused = hybridFuseRecall(candidateRows, effectiveQuery, config, db, {
      scope: requestedScope,
      includeProfile,
      includeShared,
      querySignals,
    });
    candidateRows = fused
      .map((row) => {
        if (row._source !== 'dense') return row;
        // Dense-only hits arrive hydrated and Borda-scored: run them through
        // the SAME calibrated scorer as lexical rows for liveness/tier/entity
        // METADATA (the calibrated value is kept as _calibrated_score for
        // introspection), but their ORDERING stays on the fused Borda channel
        // — the calibrated lexical magnitudes must not bury dense consensus.
        const ranked = rankActiveRow(row, querySignals, policy, config, entityKeys);
        if (!ranked) return null;
        return {
          ...ranked,
          _source: 'dense',
          _calibrated_score: Number(ranked._score || 0),
          _score: Number(row._score || 0),
        };
      })
      .filter(Boolean)
      // Liveness (U3) + tier policy apply to dense-only hits exactly as they
      // did to the lexical leg pre-fusion (the dense leg may not bypass them).
      // ONE bounded exemption (U14-opt fix #3): when the query itself asks
      // about an entity or an identity, an AGENT_IDENTITY row the dense
      // election ranked #1 overall (_dense_rank 0) is the answer, not noise —
      // IDENTITY_QUERY_RE cannot enumerate every phrasing ('tell me about the
      // atlas agent'). The exemption is deliberately NOT a tier-policy bypass:
      // dense ranks >= 1, non-identity row types, and queries with neither
      // entity nor identity intent all still go through the tier cut. A
      // regression assertion confirms that a non-identity query keeps
      // filtering a dense-rank-0 identity row.
      .filter((row) => isLiveRecallRow(row))
      // E2: same vault exemption as the lexical native leg above — vault is an
      // explicit reference corpus, exempt from the durable-tier gate. Vault-only;
      // the no-vault recall-floor path is unaffected.
      .filter((row) => row._is_vault === true
        || allowNonDurableRecall
        || isDurableMemoryTier(row._memory_tier)
        || (row._source === 'dense'
          && Number(row._dense_rank) === 0
          && String(row.type || '').trim().toUpperCase() === 'AGENT_IDENTITY'
          && (querySignals.entityIntent === true || querySignals.identityIntent === true)));
    candidateRows.sort((a, b) => Number(b._score || 0) - Number(a._score || 0));
  }

  // U14(e): optional cross-encoder rerank seam (default OFF) — identity until
  // a measured experiment wires a model in.
  if (config?.recall?.crossEncoderRerankEnabled === true && candidateRows.length > 0) {
    candidateRows = crossEncoderRerank(candidateRows, effectiveQuery, config);
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
    entityIds: strategyContext?.entityIds || [],
    multiEntities: strategyContext?.multiEntities || [],
    scope: requestedScope || normalizedScope,
  });
  // U15: the unresolved-conflict id set is built ONCE per recall (open
  // contradiction_review loops + pending capture_contradiction_* queue rows)
  // and reused by both the similarity-dedupe exemption and the provenance
  // stamp — no per-row scans.
  const conflictIds = buildUnresolvedConflictIds(db, config);
  candidateRows = dedupeRowsBySimilarity(reranked.rows, config, conflictIds);

  const sliced = candidateRows.slice(0, Math.max(topK * 3, 18));
  const budgeted = allocateByBudget(sliced, config, strategyContext);
  // U15: provenance attaches AFTER budgeting/selection (selection arithmetic is
  // untouched outside the conflict exemption above — the recall floor gate must
  // not move from a metadata change) and only to the <= topK selected rows.
  const selected = attachRecallProvenance({
    db,
    config,
    rows: budgeted.selected.slice(0, topK),
    conflictIds,
  });
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
  // U16 (U15 follow-up): exported so orchestrator brief blocks render the
  // SAME compact provenance suffix as renderInjection — one formatter, no
  // drift between the two injection surfaces.
  formatProvenanceSuffix,
  // U17-followup (IPA): exported so the contradiction eval can render BOTH arms
  // of the IPA task through the SAME injection formatter — the verdict-
  // conditioned <gigabrain-context> brief — with only row membership differing
  // (reconcile = verdict-filtered recall, naive = raw unarbitrated store). The
  // eval previously fed the IPA task flat raw rows, so a latest-wins answerer
  // applied the latest fact on BOTH arms → no delta. One formatter, no drift.
  renderInjection,
  recallForQuery,
  sanitizeRecallQuery,
  // U14-followup-2 (a): exported so the entity-lock focus filter (soft demotion
  // vs legacy hard pool-replacement) can be unit-tested in isolation.
  strategyRerankRecall,
};
