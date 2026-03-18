import path from 'node:path';

import { hashNormalized, normalizeContent } from './policy.js';
import { ensureNativeStore } from './native-sync.js';
import { ensurePersonStore } from './person-service.js';
import { ensureProjectionStore, listCurrentMemories } from './projection-store.js';

const RELATIONSHIP_RE = /\b(?:partner(?:in)?|wife|husband|girlfriend|boyfriend|friend|best friend|relationship|lebt zusammen|live together|dating)\b/i;
const ORG_RE = /\b(?:company|startup|firm|bank|neobank|organization|organisation|org|gmbh|inc|corp|business)\b/i;
const PROJECT_RE = /\b(?:project|repo|repository|product|feature|launch|rollout|roadmap|vault|plugin|setup|release)\b/i;
const PLACE_RE = /\b(?:city|country|town|village|office|home|vienna|wien|graz|berlin|london|paris)\b/i;
const TEMPORAL_RE = /\b(?:today|heute|yesterday|gestern|tomorrow|morgen|currently|aktuell|currently|january|jan|february|feb|march|mar|april|apr|may|mai|june|jun|july|jul|august|aug|september|sep|october|oct|november|nov|december|dec|20\d{2})\b/i;
const FUTURE_RE = /\b(?:will|going to|plan(?:ned)?|planned|upcoming|next|morgen|tomorrow|soll|wird|interview)\b/i;
const OPEN_LOOP_RE = /\b(?:follow[\s-]?up|todo|pending|needs?\b|need to|open question|clarify|check back|revisit|ask about|find out)\b|\?/i;
const PREFERENCE_RE = /\b(?:prefer(?:s)?|like(?:s)?|love(?:s)?|hate(?:s)?|dislike(?:s)?)\b/i;
const LOCATION_RE = /\b(?:lives? in|lebt in|based in|from|wohn(?:t|en) in)\b/i;
const ROLE_RE = /\b(?:works? as|arbeitet als|is a|ist ein|ist eine|role|job|title|founder|ceo|berater(?:in)?)\b/i;
const QUESTION_WORD_RE = /\b(?:what|who|when|where|why|how|was|wer|wann|wo|warum|wieso|wie)\b/i;
const ORG_CUE_TOKENS = new Set(['company', 'startup', 'bank', 'neobank', 'organization', 'organisation', 'org', 'gmbh', 'inc', 'corp', 'business', 'firm']);
const PROJECT_CUE_TOKENS = new Set(['project', 'repo', 'repository', 'product', 'feature', 'launch', 'rollout', 'roadmap', 'vault', 'plugin', 'setup', 'release']);
const PLACE_CUE_PATTERNS = [
  /\b(?:lives? in|lebt in|based in|wohn(?:t|en) in)\s+([A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ0-9'’._ -]{1,60})/i,
  /\b(?:from|aus)\s+([A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ0-9'’._ -]{1,60})/i,
];
const ENTITY_ALIAS_STOPWORDS = new Set([
  'add', 'are', 'partner', 'partnerin', 'beziehung', 'relationship', 'friend', 'boyfriend', 'girlfriend',
  'wife', 'husband', 'coach', 'berater', 'beraterin', 'community', 'profile', 'context', 'entity',
  'freundin', 'freund', 'sozialarbeiterin', 'sozialarbeiter',
  'project', 'company', 'memory', 'follow', 'bank', 'neobank', 'organization', 'organisation', 'startup',
  'business', 'firm', 'setup', 'release', 'plugin', 'vault', 'repo', 'repository', 'feature', 'launch',
  'rollout', 'roadmap', 'data', 'approval', 'anleitung', 'detaillierte', 'fort', 'access', 'agent',
  'browser', 'chrome', 'club', 'code', 'cookies', 'disk', 'email', 'first', 'full', 'gateway',
  'geburtstag', 'identity', 'kaffee', 'lebt', 'mac', 'menschen', 'original', 'prozess', 'refresh',
  'restart', 'send', 'soft', 'studio', 'thoughtful', 'token', 'topic', 'uhr', 'user', 'verify',
  'warm', 'wichtige', 'wrong', 'vienna', 'wien', 'brigittaplatz',
  'archive', 'contact', 'content', 'date', 'guest', 'link', 'name', 'notes', 'person', 'status',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december', 'jan', 'feb', 'mar', 'apr',
  'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec', 'today', 'heute',
]);
const RELATIONSHIP_LABEL_RE = /\b(partner(?:in)?|wife|husband|girlfriend|boyfriend|freund(?:in)?)\b/i;
const PREFERENCE_POSITIVE_RE = /\b(?:prefer(?:s)?|like(?:s)?|love(?:s)?)\b/i;
const PREFERENCE_NEGATIVE_RE = /\b(?:hate(?:s)?|dislike(?:s)?)\b/i;
const CONTRADICTION_MIN_CONFIDENCE = 0.7;
const CURATED_PROJECT_SURFACE_STOPWORDS = new Set([
  'beef', 'direct', 'gmail', 'german', 'investor', 'recall', 'retention',
  'round', 'self', 'sicherheitsanalyse', 'tartare', 'zero',
]);
const CURATED_ORGANIZATION_SURFACE_STOPWORDS = new Set([
  'gmail', 'german', 'investor',
]);
const SURFACE_BELIEF_NOISE_RE = /\b(?:access_token|cookies?|remote-debugging-port|headless|base64|agentmail|skill\.md|\.json|chat_id|numeric chat id|send login code|verify code|chrome cdp|api calls needed|tool ignores voiceid|port=9222|unread emails?|heartbeat|book a call)\b/i;
const SURFACE_BELIEF_META_RE = /^(?:agent can remember\b|assistant suggests\b|research focus areas include\b|learned\b|add (?:to|new section)\b|set birthday reminder\b|l @self\b)/i;
const SURFACE_SUMMARY_WEAK_RE = /\b(?:mail friend|memory-?notes?|birthday reminder|set birthday reminder|numeric chat id|chat id|@[\w_]+|username|default engine|voice preset|voice reference|profile image|saved to avatars|api calls needed|tool ignores|verify code|send login code|telegram:\s*\d+)\b/i;
const SESSION_BRIEF_NOISE_RE = /\b(?:tts|voice preset|voice reference|default engine|profile image|saved to avatars|chat id|username|api calls needed|tool ignores|heartbeat|unread emails?|book a call|send login code|verify code|cookies?|remote debugging|chrome cdp|visual identity|dark academia owl|owl identity|fantasy nerd|voice identity|memory-?notes?)\b/i;
const SURFACE_PERSON_PREFERRED_RE = /\b(?:partner|partnerin|relationship|beziehung|polyam|birthday|geburtstag|prefers|bevorzugt|works? (?:in|as)|arbeitet als|focus(?:es)? on|community|lebt polyamor|active in)\b/i;
const SURFACE_PROJECT_PREFERRED_RE = /\b(?:investor|investment|neobank|feature|integration|analysis|analyz|privacy|tts|voice|recall|food images|respond|stores and logs|default engine)\b/i;
const PERSON_SURFACE_CUE_TOKENS = new Set(['partner', 'partnerin', 'relationship', 'beziehung', 'works', 'arbeitet', 'coach', 'community', 'poly', 'lives', 'lebt', 'birthday', 'geburtstag', 'prefers', 'focuses', 'active', 'dates']);
const PROJECT_SURFACE_CUE_TOKENS = new Set(['project', 'startup', 'company', 'organization', 'organisation', 'investor', 'investment', 'valuation', 'interview', 'feature', 'integration', 'status', 'recall', 'active', 'banking', 'neobank', 'launch', 'rollout']);
const CURATED_PROJECT_CUE_RE = /\b(?:project|feature|plugin|tool|model|bot|workflow|integration|rollout|mcp|api|provider|agent)\b/i;
const CURATED_ORG_CUE_RE = /\b(?:company|startup|bank|neobank|organization|organisation|provider|service|app|mcp|ai)\b/i;
const MEMORY_TIER_VALUES = Object.freeze(['durable_personal', 'durable_project', 'working_reference', 'ops_runbook']);
const DURABLE_MEMORY_TIERS = new Set(['durable_personal', 'durable_project']);
const CLAIM_SLOT_FALLBACK_RE = /[^a-z0-9_]+/g;
const OPS_RUNBOOK_RE = /\b(?:access_token|cookies?|remote-debugging-port|headless|base64|agentmail|chat_id|numeric chat id|send login code|verify code|chrome cdp|api calls needed|tool ignores voiceid|port=9222|heartbeat|gateway restart|launchagent|imsg rpc|full disk access|openclaw doctor|skill\.md|token refresh|refresh token|webhook|telegram delivery hangs|restart script|chrome remote debugging)\b/i;
const WORKING_REFERENCE_RE = /\b(?:research focus areas|research|dashboard|kpi|metrics?|candidate list|provider|model|endpoint|search source|documentation|docs|twitterapi|xai api|last30days|memory system|memory search|graph memory|vector|semantic search)\b/i;
const PERSONAL_MEMORY_RE = /\b(?:partner(?:in)?|wife|husband|girlfriend|boyfriend|birthday|geburtstag|prefers?|bevorzugt|likes?|loves?|dislikes?|hates?|favorite author|brandon sanderson|communication style|tone|works? as|arbeitet als|active in the poly community|lebt polyamor|who is|wer ist)\b/i;
const PROJECT_MEMORY_RE = /\b(?:tria|kimi|flint|telegram|moonshot|project|startup|company|organization|organisation|investment|investor|valuation|interview|rollout|plugin|integration|bot|feature|api|provider)\b/i;
const PROJECT_EPISODE_RE = /\b(?:architecture|roadmap|planning|launch|build|implementation|migration|integration|prototype|interview|rollout|pilot)\b/i;
const PROJECT_IDENTITY_RE = /\b(?:project|repo|repository|product|plugin|app)\s+(?:codename|code name)\b/i;
const PERSONAL_GOAL_RE = /\b(?:wants?\s+to|goal weight|healthier goal weight|trying to|plans?\s+to improve|improve fitness|lose weight|abnehmen|health goal|wellness goal)\b/i;
const PROJECT_REFERENCE_RE = /\b(?:provider|model|weights?|openrouter|api|endpoint|docs?|documentation|research|search source|semantic search|vector|oauth|chat id|username|telegram|bot|gateway|restart|chrome cdp|remote debugging|cookies?|agentmail|heartbeat|voice reference|voice preset|default engine|tts)\b/i;
const CONTACT_INFO_RE = /\b(?:telegram:\s*\d+|chat[_ ]?id|@[\w_]+|uses telegram|username)\b/i;
const HEALTH_MEMORY_RE = /\b(?:calorie club|weight loss journey|goal weight|target:\s*\d+kg|target weight|lose weight|abnehmen|healthier goal weight|improve fitness)\b/i;
const RELATIONAL_NIMBUS_RE = /\b(?:treats nimbus as someone|someone,\s*not something|care and appreciation)\b/i;
const KIMI_FOOD_IMAGE_RE = /\b(?:food images analyzed by both nimbus|cross-model comparison|beef tartare|model=kimi)\b/i;
const FLINT_RESPONSE_RE = /\b(?:flint(?:’s|'s)? name is mentioned|flint response behavior|@flintfoxbot)\b/i;
const CURRENT_STATE_ALLOWED_TOPICS = new Set(['relationship', 'location', 'role', 'preference', 'project', 'health']);
const STABLE_IDENTITY_SUBTOPICS = new Set(['preferred_name', 'communication_style', 'visual_identity']);
const DURABLE_PROJECT_SUBTOPICS = new Set(['investment_relation', 'interview_status', 'response_behavior', 'food_image_comparison']);

const normalizeScope = (value) => String(value || 'shared').trim() || 'shared';
const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));
const parseJsonSafe = (value, fallback) => {
  if (!value) return fallback;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
};
const toIso = (value, fallback = new Date().toISOString()) => {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return new Date(parsed).toISOString();
};
const toDateOnly = (value) => {
  const iso = toIso(value, '');
  return iso ? iso.slice(0, 10) : '';
};
const slugify = (value) => String(value || '')
  .toLowerCase()
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80) || 'unknown';
const displayNameFromKey = (value) => String(value || '')
  .split(/\s+/)
  .filter(Boolean)
  .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
  .join(' ');
const isGenericAlias = (value = '') => {
  const normalized = normalizeContent(value);
  if (!normalized) return true;
  if (ENTITY_ALIAS_STOPWORDS.has(normalized)) return true;
  if (/^\d+$/.test(normalized)) return true;
  return false;
};
const PERSONISH_ALIAS_RE = /^[a-zà-öø-ÿ][a-zà-öø-ÿ'’.-]{2,31}$/iu;
const PLACEISH_ALIAS_RE = /(?:platz|strasse|straße|gasse|weg|allee|street|road)$/i;

const isLikelyPersonAlias = (value = '') => {
  const normalized = normalizeContent(value);
  if (!normalized || isGenericAlias(normalized)) return false;
  if (!PERSONISH_ALIAS_RE.test(normalized)) return false;
  if (PLACEISH_ALIAS_RE.test(normalized)) return false;
  return true;
};

const tokenizeNormalizedValue = (value = '') => normalizeContent(value).split(/\s+/).filter(Boolean);

const hasAliasTokenMatch = (content = '', alias = '') => {
  const contentTokens = tokenizeNormalizedValue(content);
  const aliasTokens = tokenizeNormalizedValue(alias);
  if (contentTokens.length === 0 || aliasTokens.length === 0) return false;
  outer: for (let index = 0; index <= (contentTokens.length - aliasTokens.length); index += 1) {
    for (let offset = 0; offset < aliasTokens.length; offset += 1) {
      if (contentTokens[index + offset] !== aliasTokens[offset]) continue outer;
    }
    return true;
  }
  return false;
};

const hasAliasCueWithinWindow = (content = '', alias = '', cueTokens = new Set(), windowSize = 5) => {
  const contentTokens = tokenizeNormalizedValue(content);
  const aliasTokens = tokenizeNormalizedValue(alias);
  if (contentTokens.length === 0 || aliasTokens.length === 0) return false;
  outer: for (let index = 0; index <= (contentTokens.length - aliasTokens.length); index += 1) {
    for (let offset = 0; offset < aliasTokens.length; offset += 1) {
      if (contentTokens[index + offset] !== aliasTokens[offset]) continue outer;
    }
    const start = Math.max(0, index - windowSize);
    const end = Math.min(contentTokens.length - 1, index + aliasTokens.length - 1 + windowSize);
    for (let cursor = start; cursor <= end; cursor += 1) {
      if (cueTokens.has(contentTokens[cursor]) && !aliasTokens.includes(contentTokens[cursor])) return true;
    }
  }
  return false;
};

const hasPlacePatternForAlias = (content = '', alias = '') => {
  const normalizedAlias = normalizeContent(alias);
  if (!normalizedAlias) return false;
  return PLACE_CUE_PATTERNS.some((pattern) => {
    const match = String(content || '').match(pattern);
    return normalizeContent(match?.[1] || '') === normalizedAlias;
  });
};

const isEntityKindEnabled = (config = {}, kind = '') => {
  const enabledKinds = Array.isArray(config?.worldModel?.entityKinds) ? config.worldModel.entityKinds : [];
  if (enabledKinds.length === 0) return true;
  return enabledKinds.includes(String(kind || '').trim());
};

const resolveTopicEntityConfig = (config = {}) => ({
  mode: String(config?.worldModel?.topicEntities?.mode || 'strict_hidden').trim().toLowerCase() || 'strict_hidden',
  minEvidenceCount: Math.max(1, Number(config?.worldModel?.topicEntities?.minEvidenceCount || 2) || 2),
  requireCuratedOrMemoryMd: config?.worldModel?.topicEntities?.requireCuratedOrMemoryMd !== false,
  minAliasLength: Math.max(1, Number(config?.worldModel?.topicEntities?.minAliasLength || 4) || 4),
  exportToSurface: config?.worldModel?.topicEntities?.exportToSurface === true,
  allowForRecall: config?.worldModel?.topicEntities?.allowForRecall !== false,
  maxGenerated: Math.max(1, Number(config?.worldModel?.topicEntities?.maxGenerated || 80) || 80),
});

const resolveSurfaceEntityConfig = (config = {}) => ({
  minConfidence: clamp01(config?.worldModel?.surfaceEntityMinConfidence ?? 0.78),
  minEvidence: Math.max(1, Number(config?.worldModel?.surfaceEntityMinEvidence || 2) || 2),
  allowedKinds: Array.isArray(config?.worldModel?.surfaceEntityKinds) && config.worldModel.surfaceEntityKinds.length > 0
    ? config.worldModel.surfaceEntityKinds.map((value) => String(value || '').trim().toLowerCase()).filter(Boolean)
    : ['person', 'project', 'organization'],
});

const normalizeMemoryTier = (value = '', fallback = 'working_reference') => {
  const normalized = String(value || '').trim().toLowerCase();
  if (MEMORY_TIER_VALUES.includes(normalized)) return normalized;
  return fallback;
};

const isDurableMemoryTier = (value = '') => DURABLE_MEMORY_TIERS.has(normalizeMemoryTier(value, ''));

const resolveSourceStrength = (row = {}) => {
  const confidence = Number(row.confidence || 0);
  const sourceLayer = String(row.source_layer || 'registry').trim().toLowerCase();
  if (sourceLayer === 'registry') return confidence >= 0.85 ? 'strong' : confidence >= 0.7 ? 'medium' : 'weak';
  if (sourceLayer === 'promoted_native') return confidence >= 0.82 ? 'strong' : confidence >= 0.68 ? 'medium' : 'weak';
  return confidence >= 0.9 ? 'strong' : confidence >= 0.75 ? 'medium' : 'weak';
};

const summarizeClaimSlotSeed = (content = '', fallback = 'memory') => {
  const seed = normalizeContent(content)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6)
    .join('_')
    .replace(CLAIM_SLOT_FALLBACK_RE, '_')
    .replace(/^_+|_+$/g, '');
  return seed || fallback;
};

const buildFallbackClaimSlot = ({ tier = 'working_reference', content = '' } = {}) => (
  `${normalizeMemoryTier(tier)}.${summarizeClaimSlotSeed(content, 'memory')}`
);

const resolveMemoryTier = ({ row = {}, claimSignal = null, entityKeys = [] } = {}) => {
  const content = String(row.content || '').trim();
  const memoryType = String(row.type || '').trim().toUpperCase();
  const sourcePath = String(row.source_path || '').trim();
  const sourceLayer = String(row.source_layer || '').trim().toLowerCase();
  const entityHints = Array.isArray(entityKeys) ? entityKeys.map((item) => normalizeContent(item)).filter(Boolean) : [];
  const fromDurableNative = (sourceLayer === 'native' || sourceLayer === 'promoted_native') && isMemoryMdLikePath(sourcePath);
  const claimTopic = String(claimSignal?.topic || '').trim().toLowerCase();
  const claimSubtopic = String(claimSignal?.subtopic || '').trim().toLowerCase();
  const projectReferenceLike = PROJECT_REFERENCE_RE.test(content);

  if (!content) return 'working_reference';
  if (OPS_RUNBOOK_RE.test(content)) return 'ops_runbook';
  if (claimTopic === 'ops') return 'ops_runbook';
  if (claimTopic === 'contact') return 'working_reference';
  if (memoryType === 'AGENT_IDENTITY') {
    if (STABLE_IDENTITY_SUBTOPICS.has(claimSubtopic)) return 'durable_personal';
    return 'working_reference';
  }
  if (PROJECT_IDENTITY_RE.test(content)) return 'durable_project';
  if (claimTopic === 'relationship' || claimTopic === 'health') return 'durable_personal';
  if (memoryType === 'PREFERENCE') {
    if (projectReferenceLike) return 'working_reference';
    if (claimTopic === 'project' || (PROJECT_MEMORY_RE.test(content) && !projectReferenceLike)) return 'durable_project';
    return 'durable_personal';
  }
  if (memoryType === 'USER_FACT' && (PERSONAL_GOAL_RE.test(content) || HEALTH_MEMORY_RE.test(content))) return 'durable_personal';
  if (claimTopic === 'project') {
    if (DURABLE_PROJECT_SUBTOPICS.has(claimSubtopic)) return 'durable_project';
    if (!projectReferenceLike) return 'durable_project';
    return 'working_reference';
  }
  if (memoryType === 'CONTEXT' && PROJECT_EPISODE_RE.test(content) && !projectReferenceLike) return 'durable_project';
  if (memoryType === 'EPISODE' && (PROJECT_MEMORY_RE.test(content) || PROJECT_EPISODE_RE.test(content)) && !projectReferenceLike) return 'durable_project';
  if (PROJECT_MEMORY_RE.test(content) || entityHints.some((hint) => PROJECT_MEMORY_RE.test(hint))) {
    return projectReferenceLike ? 'working_reference' : 'durable_project';
  }
  if (fromDurableNative) {
    if (memoryType === 'CONTEXT' || memoryType === 'EPISODE') return 'working_reference';
    if (claimTopic === 'relationship' || claimTopic === 'health' || PERSONAL_MEMORY_RE.test(content)) return 'durable_personal';
    return 'working_reference';
  }
  if (WORKING_REFERENCE_RE.test(content)) return 'working_reference';
  if (memoryType === 'DECISION') return projectReferenceLike ? 'working_reference' : 'durable_project';
  if (memoryType === 'USER_FACT' && (RELATIONSHIP_RE.test(content) || LOCATION_RE.test(content) || ROLE_RE.test(content))) return 'durable_personal';
  return 'working_reference';
};

const buildMemoryClaim = ({ row = {}, claimSignal = null, entityKeys = [] } = {}) => {
  const memoryTier = resolveMemoryTier({ row, claimSignal, entityKeys });
  const claimSlot = String(claimSignal?.slot || '').trim() || buildFallbackClaimSlot({ tier: memoryTier, content: row.content });
  const sourceStrength = resolveSourceStrength(row);
  const surfaceCandidate = isDurableMemoryTier(memoryTier)
    && !OPS_RUNBOOK_RE.test(String(row.content || ''))
    && !SURFACE_BELIEF_META_RE.test(String(row.content || '').trim())
    && !(String(row.type || '').trim().toUpperCase() === 'AGENT_IDENTITY' && !STABLE_IDENTITY_SUBTOPICS.has(String(claimSignal?.subtopic || '').trim().toLowerCase()))
    && (Number(row.confidence || 0) >= 0.72 || isMemoryMdLikePath(String(row.source_path || '')));
  return {
    memory_id: String(row.memory_id || '').trim(),
    memory_tier: memoryTier,
    claim_slot: claimSlot,
    consolidation_op: String(claimSignal?.operation || (String(row.status || '').trim().toLowerCase() === 'superseded' ? 'forget' : 'remember')).trim().toLowerCase() || 'remember',
    source_strength: sourceStrength,
    surface_candidate: surfaceCandidate ? 1 : 0,
    updated_at: toIso(row.updated_at || row.created_at),
    payload: {
      entity_keys: entityKeys,
      claim_topic: claimSignal?.topic || '',
      claim_subtopic: claimSignal?.subtopic || '',
      claim_value: claimSignal?.normalizedValue || '',
    },
  };
};

const isMemoryMdLikePath = (value = '') => {
  const raw = String(value || '').trim();
  if (!raw) return false;
  const base = path.basename(raw).toLowerCase();
  if (base === 'memory.md') return true;
  return ['whois.md', 'latest.md', 'recent-changes.md', 'pinned-core-people.md'].includes(base);
};

const hasCuratedOrMemoryEvidence = (rows = []) => rows.some((row) => {
  const sourceLayer = String(row.source_layer || '').trim().toLowerCase();
  const sourcePath = String(row.source_path || '').trim();
  return (sourceLayer === 'native' || sourceLayer === 'promoted_native') && isMemoryMdLikePath(sourcePath);
});

const filterEntityAliases = (aliases = []) => {
  const out = [];
  const seen = new Set();
  for (const alias of aliases) {
    const normalized = normalizeContent(alias);
    if (!normalized || seen.has(normalized) || isGenericAlias(normalized)) continue;
    seen.add(normalized);
    out.push(String(alias || '').trim());
  }
  return out;
};

const extractTrailingValue = (content = '', regex) => {
  const match = String(content || '').match(regex);
  if (!match?.[1]) return '';
  return normalizeContent(String(match[1] || '').replace(/[?.!,;:]+$/g, '').trim());
};

const extractLocationValue = (content = '') => extractTrailingValue(
  content,
  /\b(?:lives? in|lebt in|based in|wohn(?:t|en) in)\s+([A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ0-9'’._ -]{1,60})/i,
);

const extractRoleValue = (content = '') => extractTrailingValue(
  content,
  /\b(?:works? as|arbeitet als|role|job|title|founder|ceo|ist ein|ist eine|is a)\s+([A-Za-zÀ-ÖØ-öø-ÿ][A-Za-zÀ-ÖØ-öø-ÿ0-9'’._ -]{1,60})/i,
);

const extractPreferenceSignal = (content = '') => {
  const text = String(content || '').trim();
  const object = extractTrailingValue(
    text,
    /\b(?:prefer(?:s)?|like(?:s)?|love(?:s)?|hate(?:s)?|dislike(?:s)?)\s+(.+)$/i,
  );
  if (!object) return null;
  const polarity = PREFERENCE_NEGATIVE_RE.test(text) ? 'negative' : PREFERENCE_POSITIVE_RE.test(text) ? 'positive' : '';
  if (!polarity) return null;
  return { object, polarity };
};

const isOperationalSurfaceBelief = (belief = {}) => SURFACE_BELIEF_NOISE_RE.test(String(belief.content || ''));
const isMetaSurfaceBelief = (belief = {}) => SURFACE_BELIEF_META_RE.test(String(belief.content || '').trim());
const isDurableSurfacePayload = (payload = {}) => (
  isDurableMemoryTier(payload?.memory_tier)
  && payload?.surface_candidate !== false
);
const isDisplaySurfaceEpisode = (episode = {}) => {
  const text = String(episode.summary || episode.title || '').trim();
  if (!Boolean(text)) return false;
  if (!isDurableMemoryTier(episode?.payload?.memory_tier || '')) return false;
  return !SURFACE_BELIEF_NOISE_RE.test(text) && !SURFACE_BELIEF_META_RE.test(text);
};

const isDisplaySurfaceBelief = (belief = {}, entity = {}) => {
  const content = String(belief.content || '').trim();
  if (!content) return false;
  if (!isDurableSurfacePayload(belief?.payload || {})) return false;
  if (isOperationalSurfaceBelief(belief) || isMetaSurfaceBelief(belief)) return false;
  if (String(entity.kind || '') === 'person' && /\b(?:home address|replied twice|vacation mode)\b/i.test(content)) return false;
  if (['project', 'organization'].includes(String(entity.kind || '')) && /\b(?:@username|message tool|clawdbot|telegram delivery hangs)\b/i.test(content)) return false;
  return true;
};

const buildSurfaceEntityAliases = (entity = {}) => Array.from(new Set([
  String(entity.display_name || '').trim(),
  String(entity.normalized_name || '').trim(),
  ...(Array.isArray(entity.aliases) ? entity.aliases : []),
].map((value) => normalizeContent(value)).filter(Boolean)));

const startsWithEntityAlias = (content = '', entity = {}) => {
  const contentTokens = tokenizeNormalizedValue(content);
  if (contentTokens.length === 0) return false;
  for (const alias of buildSurfaceEntityAliases(entity)) {
    const aliasTokens = tokenizeNormalizedValue(alias);
    if (aliasTokens.length === 0 || aliasTokens.length > contentTokens.length) continue;
    let match = true;
    for (let index = 0; index < aliasTokens.length; index += 1) {
      if (contentTokens[index] !== aliasTokens[index]) {
        match = false;
        break;
      }
    }
    if (match) return true;
  }
  return false;
};

const surfaceBeliefDirectnessScore = (belief = {}, entity = {}) => {
  const content = String(belief.content || '').trim();
  if (!content) return 0;
  const aliases = buildSurfaceEntityAliases(entity);
  if (aliases.length === 0) return 0;
  const cueTokens = String(entity.kind || '') === 'person' ? PERSON_SURFACE_CUE_TOKENS : PROJECT_SURFACE_CUE_TOKENS;
  let best = 0;
  for (const alias of aliases) {
    if (startsWithEntityAlias(content, { display_name: alias, normalized_name: alias, aliases: [] })) {
      best = Math.max(best, String(entity.kind || '') === 'person' ? 1.1 : 0.9);
      continue;
    }
    if (hasAliasCueWithinWindow(content, alias, cueTokens, 4)) {
      best = Math.max(best, 0.55);
      continue;
    }
    if (hasAliasTokenMatch(content, alias)) {
      best = Math.max(best, 0.18);
    }
  }
  return best;
};

const isWeakSurfaceSummaryBelief = (belief = {}, entity = {}) => {
  const content = String(belief.content || '').trim();
  if (!content) return true;
  if (SURFACE_SUMMARY_WEAK_RE.test(content)) return true;
  if (String(entity.kind || '') === 'person' && /\b(?:mail friend|birthday reminder)\b/i.test(content)) return true;
  if (['project', 'organization'].includes(String(entity.kind || '')) && /\b(?:chat id|username|@[\w_]+)\b/i.test(content)) return true;
  return false;
};

const isCurrentStateRelevantBelief = (belief = {}) => {
  const content = String(belief.content || '').trim();
  const claimTopic = String(belief?.payload?.claim_topic || '').trim().toLowerCase();
  const claimSubtopic = String(belief?.payload?.claim_subtopic || '').trim().toLowerCase();
  if (!content) return false;
  if (!isDurableSurfacePayload(belief?.payload || {})) return false;
  if (isOperationalSurfaceBelief(belief) || isMetaSurfaceBelief(belief)) return false;
  if (SESSION_BRIEF_NOISE_RE.test(content)) return false;
  if (claimTopic && !CURRENT_STATE_ALLOWED_TOPICS.has(claimTopic)) return false;
  if (claimTopic === 'project' && /(?:chat id|username|@[\w_]+)/i.test(content)) return false;
  if (claimTopic === 'identity' && claimSubtopic !== 'preferred_name') return false;
  return true;
};

const isSessionRelevantBelief = (belief = {}) => {
  const content = String(belief.content || '').trim();
  const claimTopic = String(belief?.payload?.claim_topic || '').trim().toLowerCase();
  const claimSubtopic = String(belief?.payload?.claim_subtopic || '').trim().toLowerCase();
  if (!isCurrentStateRelevantBelief(belief)) return false;
  if (isWeakSurfaceSummaryBelief(belief)) return false;
  if (claimTopic === 'identity' && !['communication_style', 'preferred_name'].includes(claimSubtopic)) return false;
  return true;
};

const surfaceBeliefDisplayScore = (belief = {}, entity = {}) => {
  if (!isDisplaySurfaceBelief(belief, entity)) return -Infinity;
  const content = String(belief.content || '').trim();
  let score = beliefPriorityScore(belief);
  const claimTopic = String(belief?.payload?.claim_topic || '').trim().toLowerCase();
  const claimSubtopic = String(belief?.payload?.claim_subtopic || '').trim().toLowerCase();
  const directness = surfaceBeliefDirectnessScore(belief, entity);
  if (String(belief.status || '') === 'current') score += 0.45;
  score += directness;
  if (isWeakSurfaceSummaryBelief(belief, entity)) score -= ['project', 'organization'].includes(String(entity.kind || '')) ? 1.65 : 1.2;
  if (String(entity.kind || '') === 'person') {
    if (String(belief.type || '') === 'relationship') score += 1.4;
    if (SURFACE_PERSON_PREFERRED_RE.test(content)) score += 0.8;
    if (PERSONAL_GOAL_RE.test(content)) score += 0.55;
    if (claimTopic === 'role') score += 0.35;
    if (claimTopic === 'location') score += 0.28;
    if (claimTopic === 'identity' && ['tts_voice', 'visual_identity'].includes(claimSubtopic)) score -= 0.7;
    if (String(belief.type || '') === 'relationship' && !startsWithEntityAlias(content, entity)) score -= 1.1;
    if (directness < 0.4) score -= 0.8;
  } else if (['project', 'organization'].includes(String(entity.kind || ''))) {
    if (hasAliasTokenMatch(content, entity.display_name || entity.normalized_name || '')) score += 0.45;
    if (SURFACE_PROJECT_PREFERRED_RE.test(content)) score += 0.6;
    if (claimTopic === 'project') score += 0.45;
    if (claimSubtopic === 'investment_relation' || claimSubtopic === 'interview_status') score += 0.45;
    if (claimTopic === 'identity') score -= 0.55;
    if (directness < 0.35) score -= 0.65;
  }
  return score;
};

const selectSurfaceBeliefsForEntity = (entity = {}, beliefs = [], limit = 5) => selectDistinctItems(
  [...beliefs]
    .filter((belief) => String(belief.status || '') === 'current')
    .filter((belief) => isDisplaySurfaceBelief(belief, entity))
    .sort((a, b) => surfaceBeliefDisplayScore(b, entity) - surfaceBeliefDisplayScore(a, entity)),
  (belief) => belief.payload?.claim_slot || belief.content,
  limit,
);

const pickSurfaceSummaryBelief = (entity = {}, beliefs = []) => {
  const ranked = selectSurfaceBeliefsForEntity(entity, beliefs, 5)
    .map((belief) => ({ belief, score: surfaceBeliefDisplayScore(belief, entity) }))
    .sort((a, b) => b.score - a.score);
  const minimumScore = String(entity.kind || '') === 'person' ? 1.7 : 1.8;
  const winner = ranked.find((entry) => {
    if (entry.score < minimumScore) return false;
    if (String(entity.kind || '') !== 'person') return true;
    const content = String(entry?.belief?.content || '').trim();
    const type = String(entry?.belief?.type || '').trim().toLowerCase();
    if (startsWithEntityAlias(content, entity)) return true;
    if (/^(?:\*\*)?[A-ZÄÖÜ][\p{L}'’-]+(?:\s+[A-ZÄÖÜ][\p{L}'’-]+)?\s*(?:—|-|:)/u.test(content)) return false;
    if (type === 'relationship') return false;
    return true;
  });
  return winner?.belief || null;
};

const isCuratedSurfaceAlias = (kind = '', value = '') => {
  const normalized = normalizeContent(value);
  if (!normalized || isGenericAlias(normalized)) return false;
  if (kind === 'project' && CURATED_PROJECT_SURFACE_STOPWORDS.has(normalized)) return false;
  if (kind === 'organization' && CURATED_ORGANIZATION_SURFACE_STOPWORDS.has(normalized)) return false;
  return true;
};

const hasCuratedEntityCue = (entity = {}, beliefs = []) => {
  const alias = normalizeContent(entity.display_name || entity.normalized_name || '');
  if (!alias) return false;
  const cueRe = entity.kind === 'organization' ? CURATED_ORG_CUE_RE : CURATED_PROJECT_CUE_RE;
  return beliefs.some((belief) => {
    if (String(belief.status || '') !== 'current') return false;
    if (isOperationalSurfaceBelief(belief)) return false;
    return hasAliasTokenMatch(belief.content, alias) && cueRe.test(String(belief.content || ''));
  });
};

const scoreCuratedSurfaceEntity = (entity = {}, beliefs = [], episodes = []) => {
  if (!entity?.payload?.surface_visible) return -1;
  if (!isCuratedSurfaceAlias(entity.kind, entity.display_name || entity.normalized_name || '')) return -1;
  const evidenceCount = Number(entity?.payload?.evidence_count || 0);
  const currentBeliefs = beliefs.filter((belief) => String(belief.status || '') === 'current' && !isOperationalSurfaceBelief(belief));
  if (entity.kind === 'person') {
    return Number(entity.confidence || 0) + Math.min(0.4, evidenceCount * 0.08) + Math.min(0.2, currentBeliefs.length * 0.04);
  }
  if (entity.kind === 'organization') {
    if (!(evidenceCount >= 2 || hasCuratedEntityCue(entity, beliefs))) return -1;
    return Number(entity.confidence || 0) + Math.min(0.35, evidenceCount * 0.07) + Math.min(0.15, currentBeliefs.length * 0.05);
  }
  if (entity.kind === 'project') {
    if (!(evidenceCount >= 3 || hasCuratedEntityCue(entity, beliefs))) return -1;
    return Number(entity.confidence || 0) + Math.min(0.4, evidenceCount * 0.06) + Math.min(0.12, episodes.length * 0.04);
  }
  return -1;
};

const isCuratedSurfaceEntity = (entity = {}, beliefs = [], episodes = []) => scoreCuratedSurfaceEntity(entity, beliefs, episodes) >= 0;

const resolveBeliefTemporalScope = (belief = {}) => {
  const status = String(belief.status || '').trim().toLowerCase();
  const validTo = String(belief.valid_to || '').trim();
  if (status === 'stale' || status === 'superseded') return 'historical';
  if (validTo) {
    const parsed = Date.parse(validTo);
    if (Number.isFinite(parsed) && parsed < Date.now()) return 'historical';
  }
  return 'currentish';
};

const resolveBeliefSourceStrength = (belief = {}) => {
  if (String(belief?.payload?.source_strength || '').trim()) {
    return String(belief.payload.source_strength).trim();
  }
  const confidence = Number(belief.confidence || 0);
  if (String(belief.source_layer || '').trim().toLowerCase() === 'registry') {
    return confidence >= 0.85 ? 'strong' : 'medium';
  }
  return confidence >= 0.9 ? 'strong' : confidence >= 0.8 ? 'medium' : 'weak';
};

const buildContradictionSignal = (belief = {}) => {
  const type = String(belief.type || '').trim().toLowerCase();
  const status = String(belief.status || '').trim().toLowerCase();
  const confidence = Number(belief.confidence || 0);
  if (!isDurableMemoryTier(belief?.payload?.memory_tier || '')) return null;
  if (!['current', 'uncertain', 'stale'].includes(status)) return null;
  if (confidence < CONTRADICTION_MIN_CONFIDENCE) return null;
  if (String(belief.source_layer || '').trim().toLowerCase() === 'native' && confidence < 0.8) return null;
  const content = String(belief.content || '').trim();
  if (!content) return null;
  const temporalScope = resolveBeliefTemporalScope(belief);
  const sourceStrength = resolveBeliefSourceStrength(belief);

  if (type === 'location' || LOCATION_RE.test(content)) {
    const location = extractLocationValue(content);
    if (!location) return null;
    return {
      topic: 'location',
      subtopic: 'current_location',
      normalized_value: location,
      value_polarity: 'positive',
      temporal_scope: temporalScope,
      source_strength: sourceStrength,
      incompatible_group: 'location',
    };
  }

  if (type === 'relationship') {
    const relationship = String(content.match(RELATIONSHIP_LABEL_RE)?.[1] || '').toLowerCase();
    if (!relationship) return null;
    return {
      topic: 'relationship',
      subtopic: 'primary_relationship',
      normalized_value: relationship,
      value_polarity: 'positive',
      temporal_scope: temporalScope,
      source_strength: sourceStrength,
      incompatible_group: 'relationship',
    };
  }

  if (type === 'preference') {
    const signal = extractPreferenceSignal(content);
    if (!signal) return null;
    return {
      topic: 'preference',
      subtopic: signal.object,
      normalized_value: signal.object,
      value_polarity: signal.polarity,
      temporal_scope: temporalScope,
      source_strength: sourceStrength,
      incompatible_group: `preference:${signal.object}`,
    };
  }

  if (type === 'decision') {
    const normalized = normalizeContent(content).split(/\s+/).slice(0, 8).join(' ');
    if (!normalized) return null;
    return {
      topic: 'decision',
      subtopic: normalized,
      normalized_value: normalized,
      value_polarity: 'positive',
      temporal_scope: temporalScope,
      source_strength: sourceStrength,
      incompatible_group: `decision:${normalized}`,
    };
  }

  if (type === 'role') {
    const role = extractRoleValue(content);
    if (!role || role.split(/\s+/).length > 4) return null;
    return {
      topic: 'role',
      subtopic: 'primary_role',
      normalized_value: role,
      value_polarity: 'positive',
      temporal_scope: temporalScope,
      source_strength: sourceStrength,
      incompatible_group: 'role',
    };
  }

  return null;
};

const beliefRecencyBoost = (belief = {}) => {
  const ts = Date.parse(String(belief.valid_from || belief.updated_at || belief.created_at || ''));
  if (!Number.isFinite(ts)) return 0;
  const ageDays = Math.max(0, (Date.now() - ts) / (24 * 60 * 60 * 1000));
  if (ageDays <= 7) return 0.08;
  if (ageDays <= 30) return 0.05;
  if (ageDays <= 90) return 0.03;
  if (ageDays <= 365) return 0.01;
  return 0;
};

const beliefPriorityScore = (belief = {}) => {
  let score = Number(belief.confidence || 0);
  score += beliefRecencyBoost(belief);
  if (String(belief.source_layer || '').trim().toLowerCase() === 'registry') score += 0.03;
  return score;
};

const normalizeClaimSlotFromBelief = (belief = {}) => {
  const type = String(belief.type || '').trim().toLowerCase();
  const content = String(belief.content || '').trim();
  const entityKey = slugify(normalizeContent(belief.entityKey || '')).replace(/-/g, '_') || '';
  const entityKind = String(belief.entityKind || '').trim().toLowerCase();
  if (!content) return null;
  if (RELATIONAL_NIMBUS_RE.test(content)) {
    return {
      slot: 'relationship.nimbus.relational_mode',
      normalizedValue: 'someone_not_tool',
      topic: 'relationship',
      subtopic: 'nimbus_relational_mode',
      operation: 'update',
    };
  }
  if (HEALTH_MEMORY_RE.test(content)) {
    return {
      slot: 'health.weight_goal',
      normalizedValue: summarizeContent(content, 120),
      topic: 'health',
      subtopic: 'weight_goal',
      operation: 'update',
    };
  }
  if (CONTACT_INFO_RE.test(content)) {
    return {
      slot: 'contact.telegram.primary',
      normalizedValue: summarizeContent(content, 120),
      topic: 'contact',
      subtopic: 'telegram.primary',
      operation: 'update',
    };
  }
  if (FLINT_RESPONSE_RE.test(content)) {
    return {
      slot: 'project.flint.response_behavior',
      normalizedValue: summarizeContent(content, 120),
      topic: 'project',
      subtopic: 'response_behavior',
      operation: 'update',
    };
  }
  if (KIMI_FOOD_IMAGE_RE.test(content)) {
    return {
      slot: 'project.kimi.food_image_comparison',
      normalizedValue: summarizeContent(content, 120),
      topic: 'project',
      subtopic: 'food_image_comparison',
      operation: 'update',
    };
  }
  if (/\b(?:calls? (?:me|user) |preferred name|go by)\b/i.test(content)) {
    return {
      slot: 'identity.preferred_name',
      normalizedValue: summarizeContent(content, 120),
      topic: 'identity',
      subtopic: 'preferred_name',
      operation: 'update',
    };
  }
  if (/\b(?:communication style|tone|warm but direct|short answers|be concise|thoughtful)\b/i.test(content)) {
    return {
      slot: 'identity.communication_style',
      normalizedValue: summarizeContent(content, 120),
      topic: 'identity',
      subtopic: 'communication_style',
      operation: 'update',
    };
  }
  if (/\b(?:visual identity|profile image|dark academia owl|chibi pastel-blue owl|owl identity)\b/i.test(content)) {
    return {
      slot: 'identity.visual_identity',
      normalizedValue: summarizeContent(content, 120),
      topic: 'identity',
      subtopic: 'visual_identity',
      operation: 'update',
    };
  }
  if (/\b(?:tts default engine|voice preset|elevenlabs voice|voice preference|pocket tts)\b/i.test(content)) {
    return {
      slot: 'ops.tts.voice_engine',
      normalizedValue: summarizeContent(content, 120),
      topic: 'ops',
      subtopic: 'tts.voice_engine',
      operation: 'update',
    };
  }
  if (/\b(?:birthday|geburtstag|october 3|3rd october)\b/i.test(content)) {
    return {
      slot: 'identity.birthday',
      normalizedValue: summarizeContent(content, 80),
      topic: 'identity',
      subtopic: 'birthday',
      operation: 'update',
    };
  }
  const relationship = String(content.match(RELATIONSHIP_LABEL_RE)?.[1] || '').toLowerCase();
  if (type === 'relationship' && relationship) {
    return {
      slot: 'relationship.primary_partner',
      normalizedValue: relationship,
      topic: 'relationship',
      subtopic: 'primary_partner',
      operation: 'update',
    };
  }
  const location = extractLocationValue(content);
  if ((type === 'location' || LOCATION_RE.test(content)) && location) {
    return {
      slot: 'location.current_city',
      normalizedValue: location,
      topic: 'location',
      subtopic: 'current_city',
      operation: 'update',
    };
  }
  const preference = extractPreferenceSignal(content);
  if (type === 'preference' && preference) {
    const objectKey = slugify(preference.object).replace(/-/g, '_');
    if (/\b(?:brandon sanderson|mistborn|stormlight)\b/i.test(content)) {
      return {
        slot: 'preference.books.favorite_author',
        normalizedValue: summarizeContent(content, 120),
        topic: 'preference',
        subtopic: 'books.favorite_author',
        operation: 'update',
      };
    }
    return {
      slot: `preference.${objectKey}`,
      normalizedValue: `${preference.object}:${preference.polarity}`,
      topic: 'preference',
      subtopic: objectKey,
      operation: 'update',
    };
  }
  const role = extractRoleValue(content);
  if (type === 'role' && role) {
    return {
      slot: 'role.primary_role',
      normalizedValue: role,
      topic: 'role',
      subtopic: 'primary_role',
      operation: 'update',
    };
  }
  if (type === 'decision') {
    if (FLINT_RESPONSE_RE.test(content)) {
      return {
        slot: 'project.flint.response_behavior',
        normalizedValue: summarizeContent(content, 120),
        topic: 'project',
        subtopic: 'response_behavior',
        operation: 'update',
      };
    }
    if (KIMI_FOOD_IMAGE_RE.test(content)) {
      return {
        slot: 'project.kimi.food_image_comparison',
        normalizedValue: summarizeContent(content, 120),
        topic: 'project',
        subtopic: 'food_image_comparison',
        operation: 'update',
      };
    }
    const normalized = normalizeContent(content).split(/\s+/).slice(0, 8).join('_');
    if (normalized) {
      return {
        slot: `decision.${normalized}`,
        normalizedValue: normalized,
        topic: 'decision',
        subtopic: normalized,
        operation: 'remember',
      };
    }
  }
  if (type === 'identity') {
    if (/\b(?:heartbeat|probe|openclaw\.log|recall-queries|capture-context)\b/i.test(content)) {
      return {
        slot: 'ops.identity_diagnostic',
        normalizedValue: summarizeContent(content, 120),
        topic: 'ops',
        subtopic: 'identity_diagnostic',
        operation: 'ignore',
      };
    }
    return null;
  }
  if ((type === 'fact' || type === 'episode' || type === 'context') && entityKey && ['project', 'organization', 'topic'].includes(entityKind) && /\b(?:investor|invested|investment|valuation)\b/i.test(content)) {
    return {
      slot: `project.${entityKey}.investment_relation`,
      normalizedValue: normalizeContent(content).split(/\s+/).filter(Boolean).slice(0, 8).join(' '),
      topic: 'project',
      subtopic: 'investment_relation',
      operation: 'extend',
    };
  }
  if ((type === 'fact' || type === 'episode' || type === 'context') && entityKey && ['project', 'organization', 'topic'].includes(entityKind) && /\binterview\b/i.test(content)) {
    return {
      slot: `project.${entityKey}.interview_status`,
      normalizedValue: summarizeContent(content, 120),
      topic: 'project',
      subtopic: 'interview_status',
      operation: 'update',
    };
  }
  if (type === 'fact' && /\b(?:investor|invested|investment|valuation)\b/i.test(content)) {
    return {
      slot: 'project.investment_relation',
      normalizedValue: normalizeContent(content).split(/\s+/).filter(Boolean).slice(0, 8).join(' '),
      topic: 'project',
      subtopic: 'investment_relation',
      operation: 'extend',
    };
  }
  return null;
};

const findSurfacePreferredGivenName = (entityRow = {}, relatedMemoryRows = [], availableKeys = new Set()) => {
  if (String(entityRow.kind || '') !== 'person') return '';
  const surname = normalizeContent(entityRow.normalized_name || entityRow.display_name || '');
  if (!surname || surname.includes(' ')) return '';
  const surnamePattern = new RegExp(`\\b([A-ZÄÖÜ][a-zäöüß][A-Za-zÄÖÜäöüß'’.-]{1,})\\s+${surname}\\b`, 'iu');
  for (const row of relatedMemoryRows) {
    const match = String(row.content || '').match(surnamePattern);
    const givenName = normalizeContent(match?.[1] || '');
    if (givenName && givenName !== surname && availableKeys.has(givenName)) return givenName;
  }
  return '';
};

const dedupeOpenLoopRows = (rows = []) => {
  const deduped = new Map();
  for (const row of rows) {
    const key = [
      String(row.kind || '').trim().toLowerCase(),
      String(row.related_entity_id || '').trim().toLowerCase(),
      normalizeContent(row.title || ''),
    ].join('|');
    const existing = deduped.get(key);
    if (!existing || Number(row.priority || 0) > Number(existing.priority || 0)) {
      deduped.set(key, row);
    }
  }
  return Array.from(deduped.values());
};

const selectDistinctItems = (rows = [], keyFn, limit = 8) => {
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    const key = String(keyFn(row) || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
};

const hasTable = (db, tableName) => Boolean(db.prepare(`
  SELECT name
  FROM sqlite_master
  WHERE type = 'table' AND name = ?
  LIMIT 1
`).get(String(tableName || ''))?.name);

const ensureRelationshipStore = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entity_relationships (
      relationship_id TEXT PRIMARY KEY,
      entity_id_a TEXT NOT NULL,
      entity_id_b TEXT NOT NULL,
      relationship_type TEXT,
      evidence_count INTEGER DEFAULT 1,
      source_memory_ids TEXT DEFAULT '[]',
      confidence REAL DEFAULT 0.5,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memory_entity_relationships_a ON memory_entity_relationships(entity_id_a);
    CREATE INDEX IF NOT EXISTS idx_memory_entity_relationships_b ON memory_entity_relationships(entity_id_b);
  `);
};

const ensureWorldModelStore = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_claims (
      memory_id TEXT PRIMARY KEY,
      memory_tier TEXT NOT NULL,
      claim_slot TEXT NOT NULL,
      consolidation_op TEXT NOT NULL,
      source_strength TEXT NOT NULL,
      surface_candidate INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_memory_claims_tier ON memory_claims(memory_tier, updated_at);
    CREATE INDEX IF NOT EXISTS idx_memory_claims_slot ON memory_claims(claim_slot);

    CREATE TABLE IF NOT EXISTS memory_entities (
      entity_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      display_name TEXT NOT NULL,
      normalized_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      confidence REAL NOT NULL DEFAULT 0.5,
      aliases TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_memory_entities_kind ON memory_entities(kind, status);
    CREATE INDEX IF NOT EXISTS idx_memory_entities_name ON memory_entities(normalized_name);

    CREATE TABLE IF NOT EXISTS memory_entity_aliases (
      alias_id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      alias TEXT NOT NULL,
      normalized_alias TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_entity_aliases_alias ON memory_entity_aliases(normalized_alias);
    CREATE INDEX IF NOT EXISTS idx_memory_entity_aliases_entity ON memory_entity_aliases(entity_id);

    CREATE TABLE IF NOT EXISTS memory_beliefs (
      belief_id TEXT PRIMARY KEY,
      entity_id TEXT NOT NULL,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'current',
      confidence REAL NOT NULL DEFAULT 0.5,
      valid_from TEXT,
      valid_to TEXT,
      supersedes_belief_id TEXT,
      source_memory_id TEXT,
      source_layer TEXT,
      source_path TEXT,
      source_line INTEGER,
      payload TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_memory_beliefs_entity ON memory_beliefs(entity_id, status);
    CREATE INDEX IF NOT EXISTS idx_memory_beliefs_source_memory ON memory_beliefs(source_memory_id);

    CREATE TABLE IF NOT EXISTS memory_episodes (
      episode_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      start_date TEXT,
      end_date TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      primary_entity_id TEXT,
      source_memory_ids TEXT NOT NULL DEFAULT '[]',
      payload TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_memory_episodes_entity ON memory_episodes(primary_entity_id, start_date);

    CREATE TABLE IF NOT EXISTS memory_open_loops (
      loop_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      priority REAL NOT NULL DEFAULT 0.5,
      related_entity_id TEXT,
      source_memory_ids TEXT NOT NULL DEFAULT '[]',
      payload TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_memory_open_loops_entity ON memory_open_loops(related_entity_id, status);
    CREATE INDEX IF NOT EXISTS idx_memory_open_loops_kind ON memory_open_loops(kind, status);

    CREATE TABLE IF NOT EXISTS memory_syntheses (
      synthesis_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      subject_type TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      content TEXT NOT NULL,
      stale INTEGER NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0.5,
      generated_at TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_memory_syntheses_subject ON memory_syntheses(subject_type, subject_id, kind);
    CREATE INDEX IF NOT EXISTS idx_memory_syntheses_kind ON memory_syntheses(kind, generated_at);
  `);
  ensureRelationshipStore(db);
};

const clearWorldModelStore = (db) => {
  ensureWorldModelStore(db);
  db.exec(`
    DELETE FROM memory_entity_relationships;
    DELETE FROM memory_syntheses;
    DELETE FROM memory_open_loops;
    DELETE FROM memory_episodes;
    DELETE FROM memory_beliefs;
    DELETE FROM memory_entity_aliases;
    DELETE FROM memory_entities;
    DELETE FROM memory_claims;
  `);
};

const queryEntityMentions = (db) => {
  ensurePersonStore(db);
  if (!hasTable(db, 'memory_entity_mentions')) return [];
  return db.prepare(`
    SELECT id, memory_id, entity_key, entity_display, role, confidence, source
    FROM memory_entity_mentions
    ORDER BY confidence DESC, entity_key ASC
  `).all();
};

const inferEntityKind = (entityKey, memoryRows = [], mentionRows = [], config = {}) => {
  const text = memoryRows.map((row) => String(row.content || '')).join('\n');
  const hasRelationshipMention = mentionRows.some((row) => String(row.role || '').toLowerCase() === 'relationship');
  const hasPublicProfileMention = mentionRows.some((row) => String(row.role || '').toLowerCase() === 'public_profile');
  const hasOrganizationCue = memoryRows.some((row) => hasAliasCueWithinWindow(row.content, entityKey, ORG_CUE_TOKENS, 5));
  const hasProjectCue = memoryRows.some((row) => hasAliasCueWithinWindow(
    row.content,
    entityKey,
    new Set([...PROJECT_CUE_TOKENS, 'model', 'tool', 'provider', 'weights', 'api', 'openrouter', 'moonshot']),
    5,
  ));
  const hasPlaceCue = memoryRows.some((row) => hasPlacePatternForAlias(row.content, entityKey));
  if (hasRelationshipMention && isEntityKindEnabled(config, 'person')) return 'person';
  if (hasPublicProfileMention && isLikelyPersonAlias(entityKey) && isEntityKindEnabled(config, 'person')) return 'person';
  if (RELATIONSHIP_RE.test(text) && isLikelyPersonAlias(entityKey) && isEntityKindEnabled(config, 'person')) return 'person';
  if (hasOrganizationCue && isEntityKindEnabled(config, 'organization')) return 'organization';
  if (hasProjectCue && isEntityKindEnabled(config, 'project')) return 'project';
  if (hasPlaceCue && isEntityKindEnabled(config, 'place')) return 'place';
  if (isEntityKindEnabled(config, 'topic')) return 'topic';
  return '';
};

const evaluateEntityCandidate = ({
  entityKey = '',
  kind = '',
  aliases = [],
  relatedMemoryRows = [],
  mentionRows = [],
  confidence = 0,
  config = {},
} = {}) => {
  const normalizedKey = normalizeContent(entityKey);
  const filteredAliases = filterEntityAliases(aliases);
  const surfaceConfig = resolveSurfaceEntityConfig(config);
  if (!kind || !isEntityKindEnabled(config, kind)) {
    return { accepted: false, kind, aliases: filteredAliases, reason: 'disabled_kind' };
  }
  if (!normalizedKey || isGenericAlias(normalizedKey) || filteredAliases.length === 0) {
    return { accepted: false, kind, aliases: filteredAliases, reason: 'generic_alias' };
  }

  const evidenceCount = relatedMemoryRows.length;
  const hasCuratedEvidence = hasCuratedOrMemoryEvidence(relatedMemoryRows);
  const explicitlyTyped = relatedMemoryRows.some((row) => String(row.type || '').trim().toUpperCase() === 'ENTITY');
  const normalizedAliases = filteredAliases.map((alias) => normalizeContent(alias)).filter(Boolean);
  const hasOrganizationCue = relatedMemoryRows.some((row) => filteredAliases.some((alias) => hasAliasCueWithinWindow(row.content, alias, ORG_CUE_TOKENS, 5)));
  const hasProjectCue = relatedMemoryRows.some((row) => filteredAliases.some((alias) => hasAliasCueWithinWindow(row.content, alias, PROJECT_CUE_TOKENS, 5)));
  const hasPlaceCue = relatedMemoryRows.some((row) => filteredAliases.some((alias) => hasPlacePatternForAlias(row.content, alias)));
  const strongName = filteredAliases.some((alias) => isLikelyPersonAlias(alias));
  const strongMention = mentionRows.some((row) => ['relationship', 'public_profile'].includes(String(row.role || '').toLowerCase()));
  const surfaceKindAllowed = surfaceConfig.allowedKinds.includes(String(kind || '').trim().toLowerCase());
  const surfaceConfidenceThreshold = kind === 'person'
    ? surfaceConfig.minConfidence
    : ['organization', 'project'].includes(kind)
      ? Math.min(surfaceConfig.minConfidence, 0.65)
      : surfaceConfig.minConfidence;
  const highSurfaceConfidence = confidence >= surfaceConfidenceThreshold;
  const effectiveSurfaceConfidence = kind === 'person' && strongName && evidenceCount >= surfaceConfig.minEvidence
    ? confidence >= Math.min(surfaceConfidenceThreshold, 0.62)
    : highSurfaceConfidence;

  if (kind === 'person') {
    const enoughEvidence = evidenceCount >= Math.max(surfaceConfig.minEvidence, 2);
    if ((!strongName && !strongMention) || !isLikelyPersonAlias(entityKey) || (!enoughEvidence && !strongMention && !hasCuratedEvidence)) {
      return { accepted: false, kind, aliases: filteredAliases, reason: 'weak_person_evidence' };
    }
  }

  if (kind === 'organization') {
    const enoughEvidence = evidenceCount >= 2 || mentionRows.length >= 2;
    if (!hasOrganizationCue && !explicitlyTyped && !hasCuratedEvidence && !enoughEvidence) {
      return { accepted: false, kind, aliases: filteredAliases, reason: 'weak_organization_evidence' };
    }
  }

  if (kind === 'project') {
    const enoughEvidence = evidenceCount >= 2 || mentionRows.length >= 2;
    if (!hasProjectCue && !explicitlyTyped && !hasCuratedEvidence && !enoughEvidence) {
      return { accepted: false, kind, aliases: filteredAliases, reason: 'weak_project_evidence' };
    }
  }

  if (kind === 'place') {
    const enoughEvidence = evidenceCount >= 2 || mentionRows.length >= 2;
    if (!hasPlaceCue && !explicitlyTyped && !hasCuratedEvidence && !enoughEvidence) {
      return { accepted: false, kind, aliases: filteredAliases, reason: 'weak_place_evidence' };
    }
  }

  if (kind === 'topic') {
    const topicConfig = resolveTopicEntityConfig(config);
    if (topicConfig.mode === 'off') {
      return { accepted: false, kind, aliases: filteredAliases, reason: 'topic_mode_off' };
    }
    if (!normalizedAliases.some((alias) => alias.length >= topicConfig.minAliasLength)) {
      return { accepted: false, kind, aliases: filteredAliases, reason: 'topic_alias_too_short' };
    }
    const lexicalSalience = normalizedAliases.some((alias) => alias.length >= topicConfig.minAliasLength && !ENTITY_ALIAS_STOPWORDS.has(alias));
    const enoughEvidence = evidenceCount >= topicConfig.minEvidenceCount;
    const strictTopicMode = topicConfig.mode === 'strict_hidden' ? 'strict' : topicConfig.mode;
    const admissibleByMode = strictTopicMode === 'broad'
      ? lexicalSalience
      : strictTopicMode === 'balanced'
        ? lexicalSalience && (enoughEvidence || hasCuratedEvidence || explicitlyTyped)
        : lexicalSalience && (explicitlyTyped || (hasCuratedEvidence && enoughEvidence));
    if (!admissibleByMode) {
      return { accepted: false, kind, aliases: filteredAliases, reason: 'topic_not_admitted' };
    }
    if (topicConfig.requireCuratedOrMemoryMd && !explicitlyTyped && !(hasCuratedEvidence && enoughEvidence)) {
      return { accepted: false, kind, aliases: filteredAliases, reason: 'topic_missing_durable_evidence' };
    }
    const recallAllowed = topicConfig.allowForRecall
      && (strictTopicMode !== 'strict' || explicitlyTyped || (hasCuratedEvidence && enoughEvidence));
    return {
      accepted: true,
      kind,
      aliases: filteredAliases,
      evidenceCount,
      confidence,
      score: confidence + (hasCuratedEvidence ? 0.25 : 0) + (enoughEvidence ? Math.min(0.3, evidenceCount * 0.08) : 0),
      recallAllowed,
      surfaceVisible: strictTopicMode !== 'strict' && topicConfig.exportToSurface && confidence >= 0.82 && evidenceCount >= topicConfig.minEvidenceCount,
      topicMode: topicConfig.mode,
      hasCuratedEvidence,
      explicitlyTyped,
    };
  }

  let surfaceVisible = false;
  if (surfaceKindAllowed && effectiveSurfaceConfidence) {
    if (kind === 'person') {
      const surfacedEvidenceFloor = strongMention || hasCuratedEvidence
        ? surfaceConfig.minEvidence
        : Math.max(surfaceConfig.minEvidence + 1, 3);
      surfaceVisible = evidenceCount >= surfacedEvidenceFloor || (strongName && strongMention) || hasCuratedEvidence;
    } else if (kind === 'organization' || kind === 'project') {
      const hasKindCue = kind === 'organization' ? hasOrganizationCue : hasProjectCue;
      surfaceVisible = evidenceCount >= surfaceConfig.minEvidence || explicitlyTyped || hasCuratedEvidence || hasKindCue;
    } else if (kind === 'place') {
      surfaceVisible = evidenceCount >= Math.max(surfaceConfig.minEvidence, 2) && (hasPlaceCue || explicitlyTyped || hasCuratedEvidence);
    }
  }

  return {
    accepted: true,
    kind,
    aliases: filteredAliases,
    evidenceCount,
    confidence,
    score: confidence + Math.min(0.2, evidenceCount * 0.04),
    recallAllowed: true,
    surfaceVisible,
    hasCuratedEvidence,
    explicitlyTyped,
  };
};

const inferBeliefType = (row = {}) => {
  const memoryType = String(row.type || '').trim().toUpperCase();
  const content = String(row.content || '');
  if (memoryType === 'PREFERENCE' || PREFERENCE_RE.test(content)) return 'preference';
  if (memoryType === 'DECISION') return 'decision';
  if (memoryType === 'AGENT_IDENTITY') return 'identity';
  if (RELATIONSHIP_RE.test(content)) return 'relationship';
  if (LOCATION_RE.test(content)) return 'location';
  if (ROLE_RE.test(content)) return 'role';
  if (memoryType === 'EPISODE') return 'episode';
  if (memoryType === 'USER_FACT') return 'fact';
  return 'context';
};

const inferBeliefTopic = (row = {}) => {
  const content = String(row.content || '');
  const type = inferBeliefType(row);
  if (LOCATION_RE.test(content)) return 'location';
  if (type === 'relationship') return 'relationship';
  if (type === 'role') return 'role';
  if (type === 'preference') return 'preference';
  if (type === 'decision') return 'decision';
  const normalized = normalizeContent(content).split(/\s+/).filter(Boolean).slice(0, 6).join('_');
  return normalized || type;
};

const isRelativeTimeStale = (row = {}) => {
  const content = String(row.content || '');
  if (!TEMPORAL_RE.test(content)) return false;
  const recorded = toDateOnly(row.content_time || row.updated_at || row.created_at);
  if (!recorded) return false;
  return recorded !== new Date().toISOString().slice(0, 10);
};

const inferBeliefStatus = (row = {}) => {
  const status = String(row.status || 'active').trim().toLowerCase();
  if (status === 'rejected') return 'rejected';
  if (status === 'superseded') return 'superseded';
  if (row.valid_until && Date.parse(String(row.valid_until)) < Date.now()) return 'stale';
  if (isRelativeTimeStale(row)) return 'stale';
  if (Number(row.confidence || 0) < 0.55) return 'uncertain';
  return 'current';
};

const inferEpisodeStatus = (row = {}) => {
  const content = String(row.content || '');
  if (FUTURE_RE.test(content)) return 'planned';
  return 'completed';
};

const summarizeContent = (value, limit = 160) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trim()}…`;
};

const buildBeliefContentKey = (belief = {}) => normalizeContent(String(belief.content || '').trim());

const consolidateBeliefRows = (beliefRows = []) => {
  const rows = beliefRows.map((belief) => ({
    ...belief,
    payload: belief?.payload && typeof belief.payload === 'object'
      ? { ...belief.payload }
      : {
        ...parseJsonSafe(belief.payload, {}),
      },
  }));
  const groups = new Map();
  for (const belief of rows) {
    const slot = String(belief?.payload?.claim_slot || '').trim();
    if (!slot) continue;
    const key = `${String(belief.entity_id || '').trim()}|${slot}`;
    const list = groups.get(key) || [];
    list.push(belief);
    groups.set(key, list);
  }

  const conflictGroups = [];
  for (const [, group] of groups.entries()) {
    if (group.length <= 1) continue;
    group.sort((a, b) => beliefPriorityScore(b) - beliefPriorityScore(a));
    const canonicalByValue = new Map();
    for (const belief of group) {
      const valueKey = String(belief?.payload?.claim_value || buildBeliefContentKey(belief)).trim();
      const existing = canonicalByValue.get(valueKey);
      if (!existing) {
        canonicalByValue.set(valueKey, belief);
        continue;
      }
      const winner = beliefPriorityScore(existing) >= beliefPriorityScore(belief) ? existing : belief;
      const loser = winner === existing ? belief : existing;
      loser.status = 'superseded';
      loser.supersedes_belief_id = winner.belief_id;
      loser.payload = {
        ...loser.payload,
        consolidation_operation: 'extend',
        auto_resolution: 'duplicate_merged',
      };
      winner.payload = {
        ...winner.payload,
        consolidation_operation: winner.payload?.consolidation_operation || 'remember',
      };
      canonicalByValue.set(valueKey, winner);
    }

    const canonicalBeliefs = Array.from(canonicalByValue.values()).sort((a, b) => beliefPriorityScore(b) - beliefPriorityScore(a));
    if (canonicalBeliefs.length <= 1) continue;
    const winner = canonicalBeliefs[0];
    const winnerScore = beliefPriorityScore(winner);
    const runnerUp = canonicalBeliefs[1];
    const runnerUpScore = beliefPriorityScore(runnerUp);
    const ambiguous = Math.abs(winnerScore - runnerUpScore) < 0.08;
    winner.payload = {
      ...winner.payload,
      slot_uncertain: ambiguous,
      consolidation_operation: winner.payload?.consolidation_operation || 'update',
    };
    for (const belief of canonicalBeliefs.slice(1)) {
      const historical = resolveBeliefTemporalScope(belief) === 'historical';
      belief.status = ambiguous ? 'uncertain' : historical ? 'stale' : 'superseded';
      belief.supersedes_belief_id = ambiguous ? null : winner.belief_id;
      belief.payload = {
        ...belief.payload,
        auto_resolution: ambiguous ? 'degraded_conflict' : 'superseded_by_slot_winner',
        consolidation_operation: ambiguous ? 'ignore' : 'update',
      };
    }
    if (ambiguous) {
      conflictGroups.push({
        entity_id: String(winner.entity_id || ''),
        slot: String(winner.payload?.claim_slot || ''),
        topic: String(winner.payload?.claim_topic || ''),
        subtopic: String(winner.payload?.claim_subtopic || ''),
        beliefs: canonicalBeliefs.map((belief) => ({
          belief_id: belief.belief_id,
          content: belief.content,
          normalized_value: belief.payload?.claim_value || '',
          temporal_scope: resolveBeliefTemporalScope(belief),
          confidence: Number(belief.confidence || 0),
          source_strength: resolveBeliefSourceStrength(belief),
          source_memory_id: belief.source_memory_id || '',
        })),
        suggested_winner_belief_id: winner.belief_id,
      });
    }
  }

  const seenContent = new Map();
  for (const belief of rows) {
    const key = `${String(belief.entity_id || '').trim()}|${String(belief.type || '').trim()}|${buildBeliefContentKey(belief)}`;
    const existing = seenContent.get(key);
    if (!existing) {
      seenContent.set(key, belief);
      continue;
    }
    const winner = beliefPriorityScore(existing) >= beliefPriorityScore(belief) ? existing : belief;
    const loser = winner === existing ? belief : existing;
    loser.status = 'superseded';
    loser.supersedes_belief_id = winner.belief_id;
    loser.payload = {
      ...loser.payload,
      consolidation_operation: 'extend',
      auto_resolution: 'duplicate_content_merged',
    };
    seenContent.set(key, winner);
  }

  return {
    rows,
    conflictGroups,
  };
};

const buildEntityBriefContent = ({
  entity,
  beliefs = [],
  episodes = [],
  openLoops = [],
  contradictions = [],
}) => {
  const lines = [];
  lines.push(`${entity.display_name} is tracked as a ${entity.kind}.`);
  const currentBeliefs = selectSurfaceBeliefsForEntity(entity, beliefs, 5);
  if (currentBeliefs.length > 0) {
    lines.push('Current beliefs:');
    for (const belief of currentBeliefs) lines.push(`- ${belief.content}`);
  }
  const staleBeliefs = beliefs.filter((belief) => belief.status === 'stale').slice(0, 2);
  if (staleBeliefs.length > 0) {
    lines.push('Potentially stale beliefs:');
    for (const belief of staleBeliefs) lines.push(`- ${belief.content}`);
  }
  const surfaceEpisodes = episodes.filter((episode) => isDisplaySurfaceEpisode(episode));
  if (surfaceEpisodes.length > 0) {
    lines.push('Key timeline items:');
    for (const episode of surfaceEpisodes.slice(0, 3)) {
      const when = episode.start_date || 'undated';
      lines.push(`- ${when}: ${episode.summary}`);
    }
  }
  if (contradictions.length > 0) {
    lines.push('Uncertainty notes:');
    for (const item of contradictions.slice(0, 2)) lines.push(`- ${item.title}`);
  } else if (openLoops.length > 0) {
    lines.push('Pending context:');
    for (const item of openLoops.slice(0, 2)) lines.push(`- ${item.title}`);
  }
  return `${lines.join('\n')}\n`;
};

const buildGlobalSummaryContent = ({
  title,
  intro,
  items = [],
  formatter = (item) => `- ${String(item || '')}`,
}) => {
  const lines = [title];
  if (intro) lines.push('', intro);
  if (items.length > 0) {
    lines.push('');
    for (const item of items) lines.push(formatter(item));
  }
  return `${lines.join('\n')}\n`;
};

const ensureWorldModelReady = ({
  db,
  config,
  rebuildIfEmpty = true,
} = {}) => {
  ensureProjectionStore(db);
  ensureNativeStore(db);
  ensurePersonStore(db);
  ensureWorldModelStore(db);
  if (config?.worldModel?.enabled === false) return { rebuilt: false, counts: {} };
  const entityCount = Number(db.prepare('SELECT COUNT(*) AS c FROM memory_entities').get()?.c || 0);
  const activeCount = Number(db.prepare(`
    SELECT COUNT(*) AS c
    FROM memory_current
    WHERE status = 'active'
  `).get()?.c || 0);
  const latestMemoryUpdatedAt = String(db.prepare(`
    SELECT COALESCE(MAX(updated_at), '') AS updated_at
    FROM memory_current
    WHERE status IN ('active', 'superseded')
  `).get()?.updated_at || '').trim();
  const latestSynthesisGeneratedAt = String(db.prepare(`
    SELECT COALESCE(MAX(generated_at), '') AS generated_at
    FROM memory_syntheses
  `).get()?.generated_at || '').trim();
  const projectedRows = Number(db.prepare(`
    SELECT (
      (SELECT COUNT(*) FROM memory_entities)
      + (SELECT COUNT(*) FROM memory_beliefs)
      + (SELECT COUNT(*) FROM memory_episodes)
      + (SELECT COUNT(*) FROM memory_open_loops)
      + (SELECT COUNT(*) FROM memory_syntheses)
    ) AS c
  `).get()?.c || 0);
  const needsRefresh = Boolean(
    activeCount > 0
    && latestMemoryUpdatedAt
    && (!latestSynthesisGeneratedAt || Date.parse(latestMemoryUpdatedAt) > Date.parse(latestSynthesisGeneratedAt)),
  );
  if (activeCount === 0) {
    if (projectedRows > 0) {
      clearWorldModelStore(db);
      return {
        ok: true,
        rebuilt: true,
        cleared: true,
        counts: {
          entities: 0,
          aliases: 0,
          beliefs: 0,
          episodes: 0,
          open_loops: 0,
          contradictions: 0,
          syntheses: 0,
        },
      };
    }
    return {
      rebuilt: false,
      counts: {
        entities: 0,
      },
    };
  }
  if ((!rebuildIfEmpty && !needsRefresh) || (entityCount > 0 && !needsRefresh)) {
    return {
      rebuilt: false,
      counts: {
        entities: entityCount,
      },
    };
  }
  return rebuildWorldModel({ db, config });
};

const rebuildWorldModel = ({
  db,
  config,
  now = new Date().toISOString(),
} = {}) => {
  ensureWorldModelStore(db);
  ensureProjectionStore(db);
  ensurePersonStore(db);

  const rows = listCurrentMemories(db, {
    statuses: ['active', 'superseded'],
    limit: 10000,
  }).map((row) => ({
    ...row,
    memory_id: String(row.memory_id || ''),
    content: String(row.content || ''),
    updated_at: String(row.updated_at || row.created_at || now),
    created_at: String(row.created_at || row.updated_at || now),
    scope: normalizeScope(row.scope),
    source_layer: String(row.source_layer || 'registry'),
    source_path: row.source_path ? String(row.source_path) : null,
    source_line: Number.isFinite(Number(row.source_line)) ? Number(row.source_line) : null,
  }));
  if (rows.length === 0) {
    clearWorldModelStore(db);
    return {
      ok: true,
      rebuilt: true,
      cleared: true,
      counts: {
        entities: 0,
        aliases: 0,
        beliefs: 0,
        episodes: 0,
        open_loops: 0,
        contradictions: 0,
        syntheses: 0,
        relationships: 0,
      },
    };
  }
  const rowById = new Map(rows.map((row) => [row.memory_id, row]));
  const mentionRows = queryEntityMentions(db).filter((row) => rowById.has(String(row.memory_id || '')));
  const mentionsByKey = new Map();
  const mentionsByMemory = new Map();
  for (const row of mentionRows) {
    const key = normalizeContent(row.entity_key);
    if (!key) continue;
    const list = mentionsByKey.get(key) || [];
    list.push(row);
    mentionsByKey.set(key, list);
    const memoryId = String(row.memory_id || '');
    const byMemory = mentionsByMemory.get(memoryId) || new Set();
    byMemory.add(key);
    mentionsByMemory.set(memoryId, byMemory);
  }

  const resolveRowClaimContext = (row, acceptedEntityIds = new Map()) => {
    const entityKeys = Array.from(mentionsByMemory.get(String(row.memory_id || '')) || []);
    const enriched = entityKeys.map((key) => {
      const entityId = String(acceptedEntityIds.get(key) || '').trim();
      return {
        key,
        entityId,
        kind: entityId ? entityId.split(':')[0] : '',
      };
    });
    const content = String(row.content || '');
    const projectish = /\b(?:investor|invested|investment|valuation|interview|project|feature|launch|rollout|integration|neobank|startup|company)\b/i.test(content);
    const preferred = projectish
      ? enriched.find((item) => ['project', 'organization', 'topic'].includes(String(item.kind || '')))
      : enriched[0];
    return {
      entityKeys,
      primaryEntityKey: String(preferred?.key || entityKeys[0] || '').trim(),
      primaryEntityKind: String(preferred?.kind || '').trim(),
    };
  };

  const buildClaimForRow = (row, acceptedEntityIds = new Map()) => {
    const context = resolveRowClaimContext(row, acceptedEntityIds);
    const beliefType = inferBeliefType(row);
    const claimSignal = normalizeClaimSlotFromBelief({
      ...row,
      type: beliefType,
      entityKey: context.primaryEntityKey,
      entityKind: context.primaryEntityKind,
    });
    return buildMemoryClaim({
      row,
      claimSignal,
      entityKeys: context.entityKeys,
    });
  };

  const preliminaryClaimRows = rows.map((row) => buildClaimForRow(row));
  const preliminaryClaimByMemoryId = new Map(preliminaryClaimRows.map((row) => [row.memory_id, row]));

  const entityRows = [];
  const aliasRows = [];
  const beliefRows = [];
  const episodeRows = [];
  const openLoopRows = [];
  const synthesisRows = [];
  const contradictions = [];
  const entityIdByKey = new Map();
  const relatedRowsByEntityKey = new Map();
  const topicEntityBundles = [];
  const topicConfig = resolveTopicEntityConfig(config);

  for (const [entityKey, entityMentions] of mentionsByKey.entries()) {
    const relatedMemoryIds = Array.from(new Set(entityMentions.map((row) => String(row.memory_id || ''))));
    const relatedMemoryRows = relatedMemoryIds
      .map((id) => rowById.get(id))
      .filter(Boolean)
      .filter((row) => normalizeMemoryTier(preliminaryClaimByMemoryId.get(String(row.memory_id || ''))?.memory_tier || 'working_reference') !== 'ops_runbook');
    relatedRowsByEntityKey.set(entityKey, relatedMemoryRows);
    const kind = inferEntityKind(entityKey, relatedMemoryRows, entityMentions, config);
    if (isGenericAlias(entityKey)) continue;
    if (!kind) continue;
    const entityId = `${kind}:${slugify(entityKey)}`;
    const display = String(entityMentions[0]?.entity_display || displayNameFromKey(entityKey));
    const aliases = Array.from(new Set([
      display,
      displayNameFromKey(entityKey),
      ...entityMentions.map((row) => String(row.entity_display || '').trim()).filter(Boolean),
    ]));
    const confidence = clamp01(
      entityMentions.reduce((sum, row) => sum + Number(row.confidence || 0.5), 0) / Math.max(entityMentions.length, 1),
    );
    const evaluation = evaluateEntityCandidate({
      entityKey,
      kind,
      aliases,
      relatedMemoryRows,
      mentionRows: entityMentions,
      confidence,
      config,
    });
    if (!evaluation.accepted) continue;
    const updatedAt = relatedMemoryRows
      .map((row) => Date.parse(String(row.updated_at || row.created_at || now)) || 0)
      .sort((a, b) => b - a)[0] || Date.parse(now);
    const entityRow = {
      entity_id: entityId,
      kind,
      display_name: display,
      normalized_name: entityKey,
      status: 'active',
      confidence,
      aliases: evaluation.aliases,
      created_at: now,
      updated_at: new Date(updatedAt).toISOString(),
      payload: {
        evidence_count: relatedMemoryRows.length,
        scopes: Array.from(new Set(relatedMemoryRows.map((row) => row.scope))),
        recall_allowed: evaluation.recallAllowed !== false,
        surface_visible: evaluation.surfaceVisible !== false,
        topic_mode: evaluation.topicMode || null,
      },
    };
    const seenAliases = new Set();
    const candidateAliasRows = [];
    for (const alias of evaluation.aliases) {
      const normalizedAlias = normalizeContent(alias);
      if (!normalizedAlias || seenAliases.has(normalizedAlias)) continue;
      seenAliases.add(normalizedAlias);
      candidateAliasRows.push({
        alias_id: `${entityId}:${slugify(normalizedAlias)}`,
        entity_id: entityId,
        alias,
        normalized_alias: normalizedAlias,
        confidence,
        created_at: now,
        updated_at: now,
      });
    }
    if (kind === 'topic') {
      topicEntityBundles.push({
        score: Number(evaluation.score || 0),
        entityKey,
        entityRow,
        aliasRows: candidateAliasRows,
      });
      continue;
    }
    entityIdByKey.set(entityKey, entityId);
    entityRows.push(entityRow);
    aliasRows.push(...candidateAliasRows);
  }

  const admittedTopicBundles = topicEntityBundles
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || String(a.entityRow.display_name || '').localeCompare(String(b.entityRow.display_name || '')))
    .slice(0, topicConfig.maxGenerated);
  for (const bundle of admittedTopicBundles) {
    entityIdByKey.set(bundle.entityKey, bundle.entityRow.entity_id);
    entityRows.push(bundle.entityRow);
    aliasRows.push(...bundle.aliasRows);
  }

  const claimRows = rows.map((row) => buildClaimForRow(row, entityIdByKey));
  const claimByMemoryId = new Map(claimRows.map((row) => [row.memory_id, row]));

  const availableEntityKeys = new Set(entityRows.map((row) => normalizeContent(row.normalized_name || row.display_name || '')).filter(Boolean));
  for (const entityRow of entityRows) {
    if (String(entityRow.kind || '') !== 'person') continue;
    if (entityRow?.payload?.surface_visible === false) continue;
    const relatedMemoryRows = relatedRowsByEntityKey.get(normalizeContent(entityRow.normalized_name || entityRow.display_name || '')) || [];
    const preferredGivenName = findSurfacePreferredGivenName(entityRow, relatedMemoryRows, availableEntityKeys);
    if (preferredGivenName) {
      entityRow.payload = {
        ...entityRow.payload,
        surface_visible: false,
        surface_suppressed_reason: 'surname_shadowed_by_given_name',
        surface_preferred_entity: `person:${slugify(preferredGivenName)}`,
      };
    }
  }

  for (const row of rows) {
    const entityKeys = Array.from(mentionsByMemory.get(row.memory_id) || []);
    const memoryClaim = claimByMemoryId.get(row.memory_id) || buildClaimForRow(row, entityIdByKey);
    if (entityKeys.length === 0) continue;
    for (const entityKey of entityKeys) {
      const entityId = entityIdByKey.get(entityKey);
      if (!entityId) continue;
      const beliefId = `belief:${row.memory_id}:${slugify(entityKey)}`;
      const beliefType = inferBeliefType(row);
      const claimSignal = normalizeClaimSlotFromBelief({
        ...row,
        type: beliefType,
        entityKey,
        entityKind: String(entityId || '').split(':')[0],
      });
      const beliefStatus = inferBeliefStatus(row);
      beliefRows.push({
        belief_id: beliefId,
        entity_id: entityId,
        type: beliefType,
        content: row.content,
        status: beliefStatus,
        confidence: clamp01(row.confidence),
        valid_from: toDateOnly(row.content_time || row.created_at || row.updated_at),
        valid_to: row.valid_until ? toDateOnly(row.valid_until) : null,
        supersedes_belief_id: row.superseded_by ? `belief:${row.superseded_by}:${slugify(entityKey)}` : null,
        source_memory_id: row.memory_id,
        source_layer: row.source_layer,
        source_path: row.source_path,
        source_line: row.source_line,
        updated_at: row.updated_at,
        created_at: row.created_at,
        payload: {
          scope: row.scope,
          memory_type: row.type,
          topic: inferBeliefTopic(row),
          source_layer: row.source_layer,
          memory_tier: memoryClaim.memory_tier,
          source_strength: memoryClaim.source_strength,
          surface_candidate: memoryClaim.surface_candidate === 1,
          claim_slot: claimSignal?.slot || memoryClaim.claim_slot || '',
          claim_value: claimSignal?.normalizedValue || memoryClaim.payload?.claim_value || '',
          claim_topic: claimSignal?.topic || memoryClaim.payload?.claim_topic || '',
          claim_subtopic: claimSignal?.subtopic || memoryClaim.payload?.claim_subtopic || '',
          consolidation_operation: claimSignal?.operation || memoryClaim.consolidation_op || (beliefStatus === 'stale' ? 'forget' : 'remember'),
        },
      });

      if (String(row.type || '').toUpperCase() === 'EPISODE' || TEMPORAL_RE.test(row.content)) {
        episodeRows.push({
          episode_id: `episode:${row.memory_id}:${slugify(entityKey)}`,
          title: summarizeContent(row.content, 72),
          summary: summarizeContent(row.content, 180),
          start_date: toDateOnly(row.content_time || row.created_at || row.updated_at),
          end_date: toDateOnly(row.valid_until || row.content_time || row.created_at || row.updated_at),
          status: inferEpisodeStatus(row),
          primary_entity_id: entityId,
          source_memory_ids: [row.memory_id],
          payload: {
            scope: row.scope,
            source_layer: row.source_layer,
            memory_tier: memoryClaim.memory_tier,
          },
        });
      }

      if (OPEN_LOOP_RE.test(row.content)) {
        openLoopRows.push({
          loop_id: `loop:${row.memory_id}:${slugify(entityKey)}`,
          kind: QUESTION_WORD_RE.test(row.content) ? 'question' : 'follow_up',
          title: summarizeContent(row.content, 120),
          status: 'open',
          priority: clamp01((Number(row.confidence || 0.6) * 0.6) + 0.2),
          related_entity_id: entityId,
          source_memory_ids: [row.memory_id],
          payload: {
            scope: row.scope,
            source_layer: row.source_layer,
            memory_tier: memoryClaim.memory_tier,
          },
        });
      }
    }
  }

  const consolidatedBeliefs = consolidateBeliefRows(beliefRows);
  const resolvedBeliefRows = consolidatedBeliefs.rows;
  const beliefsByEntity = new Map();
  for (const belief of resolvedBeliefRows) {
    const list = beliefsByEntity.get(belief.entity_id) || [];
    list.push(belief);
    beliefsByEntity.set(belief.entity_id, list);
  }

  for (const group of consolidatedBeliefs.conflictGroups) {
    const entityId = String(group.entity_id || '').trim();
    const displayEntity = entityRows.find((row) => row.entity_id === entityId)?.display_name
      || entityId.split(':').slice(1).join(' ')
      || entityId;
    const contradiction = {
      loop_id: `loop:contradiction:${slugify(entityId)}:${slugify(group.slot || group.subtopic || 'conflict')}`,
      kind: 'contradiction_review',
      title: `Potential ${String(group.subtopic || group.topic || 'memory').replace(/_/g, ' ')} conflict for ${displayEntity}`,
      status: 'open',
      priority: 0.78,
      related_entity_id: entityId,
      source_memory_ids: group.beliefs.map((belief) => belief.source_memory_id).filter(Boolean),
      payload: {
        topic: group.topic || 'fact',
        subtopic: group.subtopic || group.slot || 'memory',
        candidate_beliefs: group.beliefs,
        candidate_values: group.beliefs.map((belief) => belief.normalized_value).filter(Boolean),
        temporal_scope: 'currentish',
        suggested_winner_belief_id: group.suggested_winner_belief_id || null,
        reason: `${group.subtopic || group.topic || 'memory'} remains ambiguous after auto-resolution`,
        internal_only: true,
      },
    };
    contradictions.push(contradiction);
    openLoopRows.push(contradiction);
  }

  const dedupedOpenLoopRows = dedupeOpenLoopRows(openLoopRows);

  const episodesByEntity = new Map();
  for (const episode of episodeRows) {
    const list = episodesByEntity.get(String(episode.primary_entity_id || '')) || [];
    list.push(episode);
    episodesByEntity.set(String(episode.primary_entity_id || ''), list);
  }

  const openLoopsByEntity = new Map();
  for (const loop of dedupedOpenLoopRows) {
    const list = openLoopsByEntity.get(String(loop.related_entity_id || '')) || [];
    list.push(loop);
    openLoopsByEntity.set(String(loop.related_entity_id || ''), list);
  }

  for (const entity of entityRows) {
    const entityBeliefs = beliefsByEntity.get(entity.entity_id) || [];
    const entityEpisodes = episodesByEntity.get(entity.entity_id) || [];
    const surfacePriority = scoreCuratedSurfaceEntity(entity, entityBeliefs, entityEpisodes);
    entity.payload = {
      ...entity.payload,
      surface_curated: surfacePriority >= 0,
      surface_priority: surfacePriority >= 0 ? Number(surfacePriority.toFixed(4)) : null,
    };
  }

  for (const entity of entityRows) {
    const entityBeliefs = (beliefsByEntity.get(entity.entity_id) || [])
      .sort((a, b) => Date.parse(String(b.valid_from || '')) - Date.parse(String(a.valid_from || '')));
    const entityEpisodes = (episodesByEntity.get(entity.entity_id) || [])
      .sort((a, b) => Date.parse(String(b.start_date || '')) - Date.parse(String(a.start_date || '')));
    const entityLoops = (openLoopsByEntity.get(entity.entity_id) || [])
      .sort((a, b) => Number(b.priority || 0) - Number(a.priority || 0));
    const entityContradictions = entityLoops.filter((loop) => loop.kind === 'contradiction_review');
    const kind = entity.kind === 'person' && entityBeliefs.some((belief) => belief.type === 'relationship')
      ? 'relationship_brief'
      : entity.kind === 'project' || entity.kind === 'organization'
        ? 'project_brief'
        : 'entity_brief';
    const content = buildEntityBriefContent({
      entity,
      beliefs: entityBeliefs,
      episodes: entityEpisodes,
      openLoops: entityLoops,
      contradictions: entityContradictions,
    });
    synthesisRows.push({
      synthesis_id: `${kind}:${entity.entity_id}`,
      kind,
      subject_type: 'entity',
      subject_id: entity.entity_id,
      content,
      stale: entityBeliefs.some((belief) => belief.status === 'stale') ? 1 : 0,
      confidence: clamp01(
        entityBeliefs.reduce((sum, belief) => sum + Number(belief.confidence || 0.5), 0)
        / Math.max(entityBeliefs.length, 1),
      ),
      generated_at: now,
      input_hash: hashNormalized(content),
      payload: {
        kind: entity.kind,
        open_loops: entityLoops.length,
        contradictions: entityContradictions.length,
      },
    });
  }

  const currentBeliefs = selectDistinctItems(
    [...resolvedBeliefRows]
      .filter((belief) => belief.status === 'current')
      .filter((belief) => isCurrentStateRelevantBelief(belief))
      .sort((a, b) => beliefPriorityScore(b) - beliefPriorityScore(a)),
    (belief) => belief.payload?.claim_slot || belief.content,
    8,
  );
  const recentBeliefs = selectDistinctItems(
    [...resolvedBeliefRows]
      .filter((belief) => ['current', 'superseded', 'stale'].includes(String(belief.status || '')))
      .filter((belief) => isCurrentStateRelevantBelief(belief))
      .sort((a, b) => {
        const bTs = Date.parse(String(b.valid_from || b.updated_at || b.created_at || '')) || 0;
        const aTs = Date.parse(String(a.valid_from || a.updated_at || a.created_at || '')) || 0;
        return bTs - aTs || beliefPriorityScore(b) - beliefPriorityScore(a);
      }),
    (belief) => belief.payload?.claim_slot || belief.content,
    12,
  );
  const importantPeople = entityRows
    .filter((entity) => entity.kind === 'person' && entity.payload?.surface_curated === true)
    .sort((a, b) => Number(b.payload?.surface_priority || 0) - Number(a.payload?.surface_priority || 0) || Number(b.confidence || 0) - Number(a.confidence || 0))
    .slice(0, 6);
  const importantProjects = entityRows
    .filter((entity) => ['project', 'organization'].includes(String(entity.kind || '')) && entity.payload?.surface_curated === true)
    .sort((a, b) => Number(b.payload?.surface_priority || 0) - Number(a.payload?.surface_priority || 0) || Number(b.confidence || 0) - Number(a.confidence || 0))
    .slice(0, 6);
  const recentEpisodes = selectDistinctItems(
    [...episodeRows]
      .filter((episode) => isDisplaySurfaceEpisode(episode))
      .sort((a, b) => Date.parse(String(b.start_date || b.end_date || '')) - Date.parse(String(a.start_date || a.end_date || ''))),
    (episode) => episode.summary,
    6,
  );
  synthesisRows.push({
    synthesis_id: 'report:open-loops',
    kind: 'open_loops_report',
    subject_type: 'global',
    subject_id: 'global',
    content: buildGlobalSummaryContent({
      title: 'Open Loops',
      intro: `${dedupedOpenLoopRows.length} internal open loops currently tracked.`,
      items: dedupedOpenLoopRows.slice(0, 12),
      formatter: (item) => `- [${item.kind}] ${item.title}`,
    }),
    stale: 0,
    confidence: 0.8,
    generated_at: now,
    input_hash: hashNormalized(JSON.stringify(dedupedOpenLoopRows.map((row) => row.loop_id))),
    payload: { count: dedupedOpenLoopRows.length, internal_only: true },
  });
  synthesisRows.push({
    synthesis_id: 'report:contradictions',
    kind: 'contradiction_report',
    subject_type: 'global',
    subject_id: 'global',
    content: buildGlobalSummaryContent({
      title: 'Contradictions',
      intro: contradictions.length > 0
        ? `${contradictions.length} internal ambiguity clusters were auto-degraded.`
        : 'No significant ambiguity clusters are currently open.',
      items: contradictions.slice(0, 12),
      formatter: (item) => `- ${item.title}`,
    }),
    stale: 0,
    confidence: contradictions.length > 0 ? 0.7 : 0.95,
    generated_at: now,
    input_hash: hashNormalized(JSON.stringify(contradictions.map((row) => row.loop_id))),
    payload: { count: contradictions.length, internal_only: true },
  });
  synthesisRows.push({
    synthesis_id: 'profile:current-state',
    kind: 'current_state',
    subject_type: 'global',
    subject_id: 'global',
    content: (() => {
      const usedSummaryKeys = new Set();
      const usedSummarySlots = new Set();
      const lines = [];
      for (const entity of [...importantPeople.slice(0, 3), ...importantProjects.slice(0, 3)]) {
        const summaryBelief = pickSurfaceSummaryBelief(entity, beliefsByEntity.get(entity.entity_id) || []);
        if (!summaryBelief || !isCurrentStateRelevantBelief(summaryBelief)) continue;
        const content = summarizeContent(summaryBelief.content, 220);
        const slot = String(summaryBelief?.payload?.claim_slot || '').trim();
        if (slot) usedSummarySlots.add(slot);
        usedSummaryKeys.add(normalizeContent(content));
        lines.push(`- ${content}`);
      }
      for (const belief of currentBeliefs) {
        const content = summarizeContent(belief.content, 220);
        const slot = String(belief?.payload?.claim_slot || '').trim();
        if (slot && usedSummarySlots.has(slot)) continue;
        const normalizedContent = normalizeContent(content);
        const overlapsSummary = Array.from(usedSummaryKeys).some((key) => (
          key === normalizedContent
          || key.startsWith(normalizedContent)
          || normalizedContent.startsWith(key)
        ));
        if (overlapsSummary) continue;
        lines.push(`- ${content}`);
      }
      return buildGlobalSummaryContent({
        title: 'Current State',
        intro: 'High-confidence current memory state across important people and projects.',
        items: selectDistinctItems(lines, (line) => normalizeContent(line), 6),
        formatter: (item) => item,
      });
    })(),
    stale: 0,
    confidence: 0.84,
    generated_at: now,
    input_hash: hashNormalized(JSON.stringify([
      ...currentBeliefs.slice(0, 6).map((belief) => belief.belief_id),
      ...recentEpisodes.slice(0, 3).map((episode) => episode.episode_id),
    ])),
    payload: {
      people: importantPeople.map((entity) => entity.entity_id),
      projects: importantProjects.map((entity) => entity.entity_id),
      curated: true,
    },
  });
  synthesisRows.push({
    synthesis_id: 'briefing:session',
    kind: 'session_brief',
    subject_type: 'global',
    subject_id: 'global',
    content: (() => {
      const sessionPeople = importantPeople.slice(0, 2);
      const sessionProjects = importantProjects.slice(0, 2);
      const usedSummaryKeys = new Set();
      const usedSummarySlots = new Set();
      const sessionBeliefs = selectDistinctItems(
        recentBeliefs.filter((belief) => isSessionRelevantBelief(belief)),
        (belief) => belief.payload?.claim_slot || belief.content,
        2,
      );
      const lines = [];
      for (const entity of sessionPeople) {
        const summaryBelief = pickSurfaceSummaryBelief(entity, beliefsByEntity.get(entity.entity_id) || []);
        if (!summaryBelief) continue;
        const key = normalizeContent(summaryBelief.content);
        const slot = String(summaryBelief?.payload?.claim_slot || '').trim();
        usedSummaryKeys.add(key);
        if (slot) usedSummarySlots.add(slot);
        lines.push(`- ${summaryBelief.content}`);
      }
      for (const entity of sessionProjects) {
        const summaryBelief = pickSurfaceSummaryBelief(entity, beliefsByEntity.get(entity.entity_id) || []);
        if (!summaryBelief) continue;
        const key = normalizeContent(summaryBelief.content);
        const slot = String(summaryBelief?.payload?.claim_slot || '').trim();
        usedSummaryKeys.add(key);
        if (slot) usedSummarySlots.add(slot);
        lines.push(`- ${summaryBelief.content}`);
      }
      for (const belief of sessionBeliefs) {
        const content = summarizeContent(belief.content, 180);
        const slot = String(belief?.payload?.claim_slot || '').trim();
        if (slot && usedSummarySlots.has(slot)) continue;
        const normalizedContent = normalizeContent(content);
        const overlapsSummary = Array.from(usedSummaryKeys).some((key) => (
          key === normalizedContent
          || key.startsWith(normalizedContent)
          || normalizedContent.startsWith(key)
        ));
        if (overlapsSummary) continue;
        lines.push(`- ${content}`);
      }
      return buildGlobalSummaryContent({
        title: 'Session Brief',
        intro: 'A short, high-confidence grounding brief for the next session.',
        items: selectDistinctItems(lines, (line) => normalizeContent(line), 6),
        formatter: (item) => item,
      });
    })(),
    stale: 0,
    confidence: 0.82,
    generated_at: now,
    input_hash: hashNormalized(JSON.stringify([
      ...importantPeople.map((entity) => entity.entity_id),
      ...importantProjects.map((entity) => entity.entity_id),
      ...recentBeliefs.slice(0, 5).map((row) => row.belief_id),
    ])),
    payload: { count: recentBeliefs.length, curated: true },
  });
  synthesisRows.push({
    synthesis_id: 'briefing:daily-memory',
    kind: 'daily_memory_briefing',
    subject_type: 'global',
    subject_id: 'global',
    content: buildGlobalSummaryContent({
      title: 'Daily Memory Briefing',
      intro: 'Key beliefs and episodes refreshed during nightly maintenance.',
      items: [
        ...recentBeliefs.slice(0, 6).map((belief) => ({ kind: 'belief', belief })),
        ...recentEpisodes.slice(0, 3).map((episode) => ({ kind: 'episode', episode })),
      ],
      formatter: (item) => item.kind === 'episode'
        ? `- [episode] ${item.episode.summary}`
        : `- [${item.belief.type}] ${item.belief.content}`,
    }),
    stale: 0,
    confidence: 0.8,
    generated_at: now,
    input_hash: hashNormalized(JSON.stringify(recentBeliefs.map((row) => row.belief_id))),
    payload: { count: recentBeliefs.length, curated: true },
  });
  synthesisRows.push({
    synthesis_id: 'report:what-changed',
    kind: 'what_changed',
    subject_type: 'global',
    subject_id: 'global',
    content: buildGlobalSummaryContent({
      title: 'What Changed',
      intro: 'Most recent memory facts reflected in the world model.',
      items: recentBeliefs,
      formatter: (item) => `- ${item.valid_from || 'recent'} · ${summarizeContent(item.content, 220)}`,
    }),
    stale: 0,
    confidence: 0.78,
    generated_at: now,
    input_hash: hashNormalized(JSON.stringify(recentBeliefs.map((row) => row.belief_id))),
    payload: { count: recentBeliefs.length },
  });

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM memory_claims').run();
    db.prepare('DELETE FROM memory_entities').run();
    db.prepare('DELETE FROM memory_entity_aliases').run();
    db.prepare('DELETE FROM memory_beliefs').run();
    db.prepare('DELETE FROM memory_episodes').run();
    db.prepare('DELETE FROM memory_open_loops').run();
    db.prepare('DELETE FROM memory_syntheses').run();
    db.prepare('DELETE FROM memory_entity_relationships').run();

    const insertClaim = db.prepare(`
      INSERT INTO memory_claims (
        memory_id, memory_tier, claim_slot, consolidation_op, source_strength, surface_candidate, updated_at, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of claimRows) {
      insertClaim.run(
        row.memory_id,
        row.memory_tier,
        row.claim_slot,
        row.consolidation_op,
        row.source_strength,
        Number(row.surface_candidate || 0),
        row.updated_at,
        JSON.stringify(row.payload || {}),
      );
    }

    const insertEntity = db.prepare(`
      INSERT INTO memory_entities (
        entity_id, kind, display_name, normalized_name, status, confidence, aliases, created_at, updated_at, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of entityRows) {
      insertEntity.run(
        row.entity_id,
        row.kind,
        row.display_name,
        row.normalized_name,
        row.status,
        row.confidence,
        JSON.stringify(row.aliases || []),
        row.created_at,
        row.updated_at,
        JSON.stringify(row.payload || {}),
      );
    }

    const insertAlias = db.prepare(`
      INSERT INTO memory_entity_aliases (
        alias_id, entity_id, alias, normalized_alias, confidence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of aliasRows) {
      insertAlias.run(
        row.alias_id,
        row.entity_id,
        row.alias,
        row.normalized_alias,
        row.confidence,
        row.created_at,
        row.updated_at,
      );
    }

    const insertBelief = db.prepare(`
      INSERT INTO memory_beliefs (
        belief_id, entity_id, type, content, status, confidence, valid_from, valid_to,
        supersedes_belief_id, source_memory_id, source_layer, source_path, source_line, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of resolvedBeliefRows) {
      insertBelief.run(
        row.belief_id,
        row.entity_id,
        row.type,
        row.content,
        row.status,
        row.confidence,
        row.valid_from,
        row.valid_to,
        row.supersedes_belief_id,
        row.source_memory_id,
        row.source_layer,
        row.source_path,
        row.source_line,
        JSON.stringify(row.payload || {}),
      );
    }

    const insertEpisode = db.prepare(`
      INSERT INTO memory_episodes (
        episode_id, title, summary, start_date, end_date, status, primary_entity_id, source_memory_ids, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of episodeRows) {
      insertEpisode.run(
        row.episode_id,
        row.title,
        row.summary,
        row.start_date,
        row.end_date,
        row.status,
        row.primary_entity_id,
        JSON.stringify(row.source_memory_ids || []),
        JSON.stringify(row.payload || {}),
      );
    }

    const insertOpenLoop = db.prepare(`
      INSERT INTO memory_open_loops (
        loop_id, kind, title, status, priority, related_entity_id, source_memory_ids, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of dedupedOpenLoopRows) {
      insertOpenLoop.run(
        row.loop_id,
        row.kind,
        row.title,
        row.status,
        row.priority,
        row.related_entity_id,
        JSON.stringify(row.source_memory_ids || []),
        JSON.stringify(row.payload || {}),
      );
    }

    const insertSynthesis = db.prepare(`
      INSERT INTO memory_syntheses (
        synthesis_id, kind, subject_type, subject_id, content, stale, confidence, generated_at, input_hash, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const row of synthesisRows) {
      insertSynthesis.run(
        row.synthesis_id,
        row.kind,
        row.subject_type,
        row.subject_id,
        row.content,
        Number(row.stale || 0),
        row.confidence,
        row.generated_at,
        row.input_hash,
        JSON.stringify(row.payload || {}),
      );
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  // Phase 5A: build entity co-occurrence relationships after main rebuild
  const relationshipResult = buildEntityRelationships(db, now);

  return {
    ok: true,
    rebuilt: true,
    counts: {
      claims: claimRows.length,
      entities: entityRows.length,
      aliases: aliasRows.length,
      beliefs: resolvedBeliefRows.length,
      episodes: episodeRows.length,
      open_loops: dedupedOpenLoopRows.length,
      contradictions: contradictions.length,
      syntheses: synthesisRows.length,
      relationships: relationshipResult.written,
    },
  };
};

const listEntities = (db, options = {}) => {
  ensureWorldModelStore(db);
  const kind = String(options.kind || '').trim();
  const includeHidden = options.includeHidden === true;
  const limit = Math.max(1, Math.min(2000, Number(options.limit || 200) || 200));
  const where = [];
  const params = [];
  if (kind) {
    where.push('kind = ?');
    params.push(kind);
  }
  const rows = db.prepare(`
    SELECT entity_id, kind, display_name, normalized_name, status, confidence, aliases, created_at, updated_at, payload
    FROM memory_entities
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY updated_at DESC, display_name ASC
    LIMIT ?
  `).all(...params, limit);
  return rows
    .map((row) => ({
      ...row,
      aliases: parseJsonSafe(row.aliases, []),
      payload: parseJsonSafe(row.payload, {}),
    }))
    .filter((row) => includeHidden || row?.payload?.surface_visible !== false);
};

const listEntityAliases = (db, entityId) => {
  ensureWorldModelStore(db);
  return db.prepare(`
    SELECT alias, normalized_alias, confidence
    FROM memory_entity_aliases
    WHERE entity_id = ?
    ORDER BY confidence DESC, alias ASC
  `).all(String(entityId || ''));
};

const listBeliefs = (db, options = {}) => {
  ensureWorldModelStore(db);
  const entityId = String(options.entityId || '').trim();
  const status = String(options.status || '').trim();
  const limit = Math.max(1, Math.min(5000, Number(options.limit || 500) || 500));
  const where = [];
  const params = [];
  if (entityId) {
    where.push('entity_id = ?');
    params.push(entityId);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  const rows = db.prepare(`
    SELECT belief_id, entity_id, type, content, status, confidence, valid_from, valid_to,
      supersedes_belief_id, source_memory_id, source_layer, source_path, source_line, payload
    FROM memory_beliefs
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY COALESCE(valid_from, '') DESC, confidence DESC
    LIMIT ?
  `).all(...params, limit);
  return rows.map((row) => ({
    ...row,
    payload: parseJsonSafe(row.payload, {}),
  }));
};

const listEpisodes = (db, options = {}) => {
  ensureWorldModelStore(db);
  const entityId = String(options.entityId || '').trim();
  const limit = Math.max(1, Math.min(1000, Number(options.limit || 200) || 200));
  const where = [];
  const params = [];
  if (entityId) {
    where.push('primary_entity_id = ?');
    params.push(entityId);
  }
  const rows = db.prepare(`
    SELECT episode_id, title, summary, start_date, end_date, status, primary_entity_id, source_memory_ids, payload
    FROM memory_episodes
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY COALESCE(start_date, '') DESC, title ASC
    LIMIT ?
  `).all(...params, limit);
  return rows.map((row) => ({
    ...row,
    source_memory_ids: parseJsonSafe(row.source_memory_ids, []),
    payload: parseJsonSafe(row.payload, {}),
  }));
};

const listOpenLoops = (db, options = {}) => {
  ensureWorldModelStore(db);
  const kind = String(options.kind || '').trim();
  const entityId = String(options.entityId || '').trim();
  const limit = Math.max(1, Math.min(2000, Number(options.limit || 500) || 500));
  const where = [];
  const params = [];
  if (kind) {
    where.push('kind = ?');
    params.push(kind);
  }
  if (entityId) {
    where.push('related_entity_id = ?');
    params.push(entityId);
  }
  const rows = db.prepare(`
    SELECT loop_id, kind, title, status, priority, related_entity_id, source_memory_ids, payload
    FROM memory_open_loops
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY priority DESC, title ASC
    LIMIT ?
  `).all(...params, limit);
  return rows.map((row) => ({
    ...row,
    source_memory_ids: parseJsonSafe(row.source_memory_ids, []),
    payload: parseJsonSafe(row.payload, {}),
  }));
};

const listContradictions = (db, options = {}) => (
  listOpenLoops(db, { ...options, kind: 'contradiction_review' })
);

const listSyntheses = (db, options = {}) => {
  ensureWorldModelStore(db);
  const kind = String(options.kind || '').trim();
  const subjectType = String(options.subjectType || '').trim();
  const subjectId = String(options.subjectId || '').trim();
  const limit = Math.max(1, Math.min(2000, Number(options.limit || 500) || 500));
  const where = [];
  const params = [];
  if (kind) {
    where.push('kind = ?');
    params.push(kind);
  }
  if (subjectType) {
    where.push('subject_type = ?');
    params.push(subjectType);
  }
  if (subjectId) {
    where.push('subject_id = ?');
    params.push(subjectId);
  }
  const rows = db.prepare(`
    SELECT synthesis_id, kind, subject_type, subject_id, content, stale, confidence, generated_at, input_hash, payload
    FROM memory_syntheses
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY generated_at DESC, kind ASC
    LIMIT ?
  `).all(...params, limit);
  return rows.map((row) => ({
    ...row,
    stale: Number(row.stale || 0) === 1,
    payload: parseJsonSafe(row.payload, {}),
  }));
};

const getSynthesis = (db, { kind = '', subjectType = '', subjectId = '' } = {}) => (
  listSyntheses(db, {
    kind,
    subjectType,
    subjectId,
    limit: 1,
  })[0] || null
);

const findEntityMatches = (db, query, options = {}) => {
  ensureWorldModelStore(db);
  const raw = normalizeContent(query);
  if (!raw) return [];
  const limit = Math.max(1, Math.min(100, Number(options.limit || 12) || 12));
  const temporalPenaltyKinds = Array.isArray(options.temporalPenaltyKinds)
    ? options.temporalPenaltyKinds
    : ['topic'];
  const temporalQuery = TEMPORAL_RE.test(raw);
  const aliases = db.prepare(`
    SELECT a.entity_id, a.alias, a.normalized_alias, a.confidence, e.kind, e.display_name, e.status, e.updated_at, e.confidence AS entity_confidence, e.payload
    FROM memory_entity_aliases a
    JOIN memory_entities e ON e.entity_id = a.entity_id
    ORDER BY a.confidence DESC, e.updated_at DESC
  `).all();
  const scored = aliases.map((row) => {
    const normalizedAlias = String(row.normalized_alias || '');
    if (!normalizedAlias || isGenericAlias(normalizedAlias)) return null;
    const payload = parseJsonSafe(row.payload, {});
    if (payload?.recall_allowed === false) return null;
    let lexicalScore = 0;
    if (raw === normalizedAlias) lexicalScore += 1.45;
    if (raw.includes(normalizedAlias)) lexicalScore += 1.05;
    if (normalizedAlias.includes(raw) && raw.length >= 4) lexicalScore += 0.55;
    const tokens = raw.split(/\s+/).filter(Boolean);
    const aliasTokens = normalizedAlias.split(/\s+/).filter(Boolean);
    let overlapCount = 0;
    for (const token of tokens) {
      if (token.length < 3) continue;
      if (aliasTokens.includes(token)) {
        lexicalScore += 0.12;
        overlapCount += 1;
      }
    }
    if (lexicalScore <= 0) return null;
    let score = lexicalScore + Math.min(0.18, Number(row.confidence || 0) * 0.12);
    score += Math.min(0.12, Number(row.entity_confidence || 0) * 0.1);
    if (['person', 'organization', 'project', 'place'].includes(String(row.kind || ''))) score += 0.08;
    if (String(row.kind || '') === 'topic') score -= 0.18;
    if (temporalQuery && temporalPenaltyKinds.includes(String(row.kind || ''))) score -= 0.12;
    if (overlapCount === 0 && raw !== normalizedAlias && !raw.includes(normalizedAlias)) {
      score -= 0.2;
    }
    return {
      entity_id: String(row.entity_id || ''),
      kind: String(row.kind || ''),
      display_name: String(row.display_name || ''),
      alias: String(row.alias || ''),
      score,
    };
  }).filter((row) => row && row.score > 0.25);
  const deduped = new Map();
  for (const row of scored) {
    const prev = deduped.get(row.entity_id);
    if (!prev || row.score > prev.score) deduped.set(row.entity_id, row);
  }
  return Array.from(deduped.values())
    .sort((a, b) => b.score - a.score || a.display_name.localeCompare(b.display_name))
    .slice(0, limit);
};

const getEntityDetail = (db, entityId) => {
  ensureWorldModelStore(db);
  const row = db.prepare(`
    SELECT entity_id, kind, display_name, normalized_name, status, confidence, aliases, created_at, updated_at, payload
    FROM memory_entities
    WHERE entity_id = ?
    LIMIT 1
  `).get(String(entityId || ''));
  const entity = row ? {
    ...row,
    aliases: parseJsonSafe(row.aliases, []),
    payload: parseJsonSafe(row.payload, {}),
  } : null;
  if (!entity) return null;
  return {
    ...entity,
    aliases: listEntityAliases(db, entity.entity_id).map((row) => row.alias),
    beliefs: listBeliefs(db, { entityId: entity.entity_id, limit: 200 }),
    episodes: listEpisodes(db, { entityId: entity.entity_id, limit: 100 }),
    open_loops: listOpenLoops(db, { entityId: entity.entity_id, limit: 100 }),
    syntheses: listSyntheses(db, { subjectType: 'entity', subjectId: entity.entity_id, limit: 20 }),
  };
};

// Phase 4B: Entity evolution timeline
const getEntityEvolution = (db, entityId) => {
  ensureWorldModelStore(db);
  const beliefs = listBeliefs(db, { entityId: String(entityId || ''), limit: 500 });
  const sourceIds = Array.from(new Set(
    beliefs
      .map((belief) => String(belief.source_memory_id || '').trim())
      .filter(Boolean),
  ));
  const sourceTimes = new Map();
  const sourceLookup = db.prepare(`
    SELECT memory_id, content_time, updated_at, created_at
    FROM memory_current
    WHERE memory_id = ?
    LIMIT 1
  `);
  for (const sourceId of sourceIds) {
    const row = sourceLookup.get(sourceId);
    if (!row) continue;
    sourceTimes.set(sourceId, {
      source_memory_id: sourceId,
      timestamp: String(row.content_time || row.updated_at || row.created_at || '').trim(),
    });
  }
  const bySlot = new Map();
  for (const belief of beliefs) {
    const payload = belief.payload || {};
    const slot = String(payload.claim_slot || 'unknown').trim() || 'unknown';
    const sourceMeta = sourceTimes.get(String(belief.source_memory_id || '').trim()) || null;
    const normalized = {
      belief_id: String(belief.belief_id || ''),
      belief_type: String(belief.type || ''),
      claim_slot: slot,
      claim_value: String(payload.claim_value || belief.content || '').trim(),
      confidence: Number(belief.confidence || 0),
      valid_from: belief.valid_from || null,
      valid_to: belief.valid_to || null,
      status: belief.status || 'active',
      source_memory_id: String(belief.source_memory_id || '').trim(),
      source_layer: String(belief.source_layer || '').trim(),
      source_path: String(belief.source_path || '').trim(),
      source_line: Number.isFinite(Number(belief.source_line)) ? Number(belief.source_line) : null,
      timestamp: String(belief.valid_from || sourceMeta?.timestamp || '').trim() || null,
      content: String(belief.content || '').trim(),
    };
    const list = bySlot.get(slot) || [];
    list.push(normalized);
    bySlot.set(slot, list);
  }
  const evolution = [];
  for (const [slot, slotBeliefs] of bySlot) {
    const sorted = slotBeliefs.sort((a, b) => {
      const aDate = String(a.timestamp || '');
      const bDate = String(b.timestamp || '');
      return aDate.localeCompare(bDate);
    });
    const current = [...sorted].reverse().find((belief) => String(belief.status || '') === 'active') || null;
    evolution.push({
      claim_slot: slot,
      history: sorted,
      current,
      changed: sorted.length > 1,
    });
  }
  return evolution.filter((e) => e.history.length > 0);
};

// Phase 4C: Auto-resolve open loops from new memories
const resolveOpenLoopsFromNewMemories = (db, config = {}) => {
  ensureWorldModelStore(db);
  if (config?.worldModel?.autoResolveLoops === false) return { resolved: 0 };
  const openLoops = db.prepare(`
    SELECT loop_id, title, source_memory_ids, related_entity_id
    FROM memory_open_loops
    WHERE status = 'open' AND kind != 'contradiction_review'
    ORDER BY priority DESC
    LIMIT 200
  `).all();
  let resolved = 0;
  const minOverlap = Number(config?.worldModel?.autoResolveOverlapThreshold ?? 0.5);
  const minConfidence = Number(config?.worldModel?.autoResolveMinConfidence ?? 0.7);

  for (const loop of openLoops) {
    const loopTitle = String(loop.title || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!loopTitle) continue;
    const loopTokens = new Set(loopTitle.split(/\s+/).filter((t) => t.length >= 3));
    if (loopTokens.size === 0) continue;
    const sourceIds = parseJsonSafe(loop.source_memory_ids, []).map((value) => String(value || '').trim()).filter(Boolean);
    if (sourceIds.length === 0) continue;
    const sourceRows = sourceIds
      .map((memoryId) => db.prepare(`
        SELECT memory_id, content_time, updated_at, created_at
        FROM memory_current
        WHERE memory_id = ?
        LIMIT 1
      `).get(memoryId))
      .filter(Boolean);
    const latestSourceMs = sourceRows.reduce((latest, row) => {
      const ts = Date.parse(String(row.content_time || row.updated_at || row.created_at || '')) || 0;
      return Math.max(latest, ts);
    }, 0);
    if (!latestSourceMs) continue;

    const entityId = String(loop.related_entity_id || '').trim();
    const placeholders = sourceIds.map(() => '?').join(', ');
    let candidates = [];
    if (entityId) {
      candidates = db.prepare(`
        SELECT DISTINCT mc.memory_id, mc.content, mc.confidence, mc.content_time, mc.updated_at, mc.created_at
        FROM memory_current mc
        JOIN memory_beliefs mb ON mb.source_memory_id = mc.memory_id
        WHERE mc.status = 'active'
          AND mb.entity_id = ?
          AND mc.memory_id NOT IN (${placeholders})
        ORDER BY COALESCE(mc.content_time, mc.updated_at, mc.created_at, '') DESC
        LIMIT 100
      `).all(entityId, ...sourceIds);
    } else {
      candidates = db.prepare(`
        SELECT mc.memory_id, mc.content, mc.confidence, mc.content_time, mc.updated_at, mc.created_at
        FROM memory_current mc
        WHERE mc.status = 'active'
          AND mc.memory_id NOT IN (${placeholders})
        ORDER BY COALESCE(mc.content_time, mc.updated_at, mc.created_at, '') DESC
        LIMIT 200
      `).all(...sourceIds);
    }

    for (const candidate of candidates) {
      const candConfidence = Number(candidate.confidence || 0);
      if (candConfidence < minConfidence) continue;
      const candidateMs = Date.parse(String(candidate.content_time || candidate.updated_at || candidate.created_at || '')) || 0;
      if (!candidateMs || candidateMs <= latestSourceMs) continue;
      const candTokens = new Set(
        String(candidate.content || '').toLowerCase().replace(/\s+/g, ' ').split(/\s+/).filter((t) => t.length >= 3)
      );
      let overlap = 0;
      for (const token of loopTokens) {
        if (candTokens.has(token)) overlap += 1;
      }
      const overlapRatio = overlap / loopTokens.size;
      if (overlapRatio >= minOverlap) {
        db.prepare(`
          UPDATE memory_open_loops
          SET status = 'resolved_auto',
              payload = json_set(
                COALESCE(payload, '{}'),
                '$.resolved_by_memory_id', ?,
                '$.resolved_at', ?,
                '$.auto_resolved_reason', 'newer_memory_overlap'
              )
          WHERE loop_id = ?
        `).run(
          String(candidate.memory_id || ''),
          new Date().toISOString(),
          String(loop.loop_id || ''),
        );
        resolved += 1;
        break;
      }
    }
  }
  return { resolved };
};

// Phase 4D: Contradiction resolution suggestions (heuristic)
const suggestContradictionResolution = (db, options = {}) => {
  ensureWorldModelStore(db);
  const contradictions = listOpenLoops(db, { kind: 'contradiction_review', limit: Number(options.limit || 100) });
  const suggestions = [];

  for (const contradiction of contradictions) {
    const sourceIds = Array.isArray(contradiction.source_memory_ids) ? contradiction.source_memory_ids : [];
    if (sourceIds.length < 2) {
      suggestions.push({
        ...contradiction,
        suggested_resolution: null,
        resolution_reason: 'insufficient_sources',
      });
      continue;
    }

    // Load source memories
    const sources = sourceIds
      .map((id) => db.prepare('SELECT memory_id, content, confidence, updated_at, source FROM memory_current WHERE memory_id = ?').get(String(id)))
      .filter(Boolean);

    if (sources.length < 2) {
      suggestions.push({
        ...contradiction,
        suggested_resolution: null,
        resolution_reason: 'sources_not_found',
      });
      continue;
    }

    // Heuristic: recency + source strength + confidence
    const scored = sources.map((s) => {
      const recencyMs = Date.parse(String(s.updated_at || '')) || 0;
      const recencyScore = recencyMs / 1e13; // normalize
      const confidenceScore = Number(s.confidence || 0);
      const sourceStrength = String(s.source || '') === 'capture' ? 0.1 : 0;
      return {
        memory_id: s.memory_id,
        content: String(s.content || '').slice(0, 200),
        total_score: recencyScore + confidenceScore + sourceStrength,
        confidence: confidenceScore,
        updated_at: s.updated_at,
      };
    }).sort((a, b) => b.total_score - a.total_score);

    suggestions.push({
      ...contradiction,
      suggested_resolution: {
        winner: scored[0],
        loser: scored[1],
        reason: 'heuristic_recency_confidence',
        confidence_delta: Math.abs(scored[0].confidence - scored[1].confidence),
      },
      resolution_reason: 'heuristic',
    });
  }
  return suggestions;
};

// Phase 5A: Build entity co-occurrence relationships from shared source memories
const buildEntityRelationships = (db, now = new Date().toISOString()) => {
  ensureRelationshipStore(db);
  const beliefs = db.prepare(`
    SELECT belief_id, entity_id, source_memory_id
    FROM memory_beliefs
    WHERE source_memory_id IS NOT NULL AND source_memory_id != ''
  `).all();

  // Group entity_ids by source_memory_id
  const entitiesByMemory = new Map();
  for (const belief of beliefs) {
    const memId = String(belief.source_memory_id || '').trim();
    if (!memId) continue;
    const set = entitiesByMemory.get(memId) || new Set();
    set.add(String(belief.entity_id || ''));
    entitiesByMemory.set(memId, set);
  }

  // Build co-occurrence pairs
  const pairMap = new Map(); // 'entityA||entityB' -> { count, memoryIds }
  for (const [memId, entitySet] of entitiesByMemory) {
    const entities = Array.from(entitySet).filter(Boolean).sort();
    for (let i = 0; i < entities.length; i++) {
      for (let j = i + 1; j < entities.length; j++) {
        const key = `${entities[i]}||${entities[j]}`;
        const entry = pairMap.get(key) || { entityA: entities[i], entityB: entities[j], count: 0, memoryIds: new Set() };
        entry.count += 1;
        entry.memoryIds.add(memId);
        pairMap.set(key, entry);
      }
    }
  }

  // Write relationships
  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO memory_entity_relationships (
      relationship_id, entity_id_a, entity_id_b, relationship_type,
      evidence_count, source_memory_ids, confidence, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let written = 0;
  for (const [, entry] of pairMap) {
    const confidence = Math.min(0.95, Math.max(0.3, 0.3 + (entry.count - 1) * 0.1));
    const relationshipId = `rel:${slugify(entry.entityA)}--${slugify(entry.entityB)}`;
    insertStmt.run(
      relationshipId,
      entry.entityA,
      entry.entityB,
      'co_occurrence',
      entry.count,
      JSON.stringify(Array.from(entry.memoryIds)),
      confidence,
      now,
      now,
    );
    written += 1;
  }
  return { written };
};

// Phase 5A: List entity relationships
const listRelationships = (db, options = {}) => {
  ensureRelationshipStore(db);
  const entityId = String(options.entityId || '').trim();
  const limit = Math.max(1, Math.min(2000, Number(options.limit || 500) || 500));
  const minEvidence = Math.max(0, Number(options.minEvidence || 0) || 0);
  const where = [];
  const params = [];
  if (entityId) {
    where.push('(entity_id_a = ? OR entity_id_b = ?)');
    params.push(entityId, entityId);
  }
  if (minEvidence > 0) {
    where.push('evidence_count >= ?');
    params.push(minEvidence);
  }
  const rows = db.prepare(`
    SELECT relationship_id, entity_id_a, entity_id_b, relationship_type,
      evidence_count, source_memory_ids, confidence, created_at, updated_at
    FROM memory_entity_relationships
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY evidence_count DESC, confidence DESC
    LIMIT ?
  `).all(...params, limit);
  return rows.map((row) => ({
    ...row,
    source_memory_ids: parseJsonSafe(row.source_memory_ids, []),
  }));
};

const listRelationshipDetails = (db, options = {}) => {
  const entityId = String(options.entityId || '').trim();
  const relationships = listRelationships(db, options);
  const entityMap = new Map(
    listEntities(db, { limit: 5000 }).map((entity) => [entity.entity_id, entity]),
  );
  return relationships.map((relationship) => {
    const entityA = entityMap.get(relationship.entity_id_a) || null;
    const entityB = entityMap.get(relationship.entity_id_b) || null;
    const counterpartId = entityId
      ? (relationship.entity_id_a === entityId ? relationship.entity_id_b : relationship.entity_id_a)
      : '';
    const counterpart = counterpartId ? entityMap.get(counterpartId) || null : null;
    return {
      ...relationship,
      entity_a: entityA ? {
        entity_id: entityA.entity_id,
        display_name: entityA.display_name,
        kind: entityA.kind,
      } : null,
      entity_b: entityB ? {
        entity_id: entityB.entity_id,
        display_name: entityB.display_name,
        kind: entityB.kind,
      } : null,
      counterpart_entity: counterpart ? {
        entity_id: counterpart.entity_id,
        display_name: counterpart.display_name,
        kind: counterpart.kind,
      } : null,
    };
  });
};

export {
  ensureWorldModelStore,
  ensureWorldModelReady,
  ensureRelationshipStore,
  rebuildWorldModel,
  buildEntityRelationships,
  normalizeMemoryTier,
  isDurableMemoryTier,
  resolveMemoryTier,
  listEntities,
  listEntityAliases,
  findEntityMatches,
  getEntityDetail,
  listBeliefs,
  listEpisodes,
  listOpenLoops,
  listContradictions,
  listSyntheses,
  getSynthesis,
  listRelationships,
  listRelationshipDetails,
  isDisplaySurfaceEpisode,
  selectSurfaceBeliefsForEntity,
  pickSurfaceSummaryBelief,
  getEntityEvolution,
  resolveOpenLoopsFromNewMemories,
  suggestContradictionResolution,
};
