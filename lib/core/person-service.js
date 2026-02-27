import { normalizeContent } from './policy.js';

const RELATIONSHIP_RE = /\b(?:partner(?:in)?|wife|husband|girlfriend|boyfriend|friend|best friend|relationship|lebt zusammen|live together|dating|date)\b/i;
const PUBLIC_PROFILE_RE = /\b(?:tedx|coach|coaching|website|community|wien|vienna|talk|speaker|life coaching|beratung)\b/i;
const OPS_NOISE_RE = /\b(?:script|pipeline|cron|review|migration|deploy|run|todo|worker)\b/i;
const PERSON_QUERY_HINT_RE = /\b(?:wer ist|who is|about|über|ueber|tell me about|was weißt du über|was weisst du über)\b/i;
const ENTITY_QUERY_HINT_TAIL_RE = /\b(?:wer ist|wer war|who is|who was|about|über|ueber|tell me about|was weißt du über|was weisst du über)\s+(.+)$/i;
const WELL_KNOWN_NAMES_RE = /(?!x)x/gi; // configurable — no hardcoded names
const PROPER_NAME_RE = /\b[A-ZÄÖÜ][a-zäöüß][A-Za-zÄÖÜäöüß0-9-]{1,}\b/g;
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
  // Additional stopwords to prevent entity noise from sentence-initial words
  'after', 'before', 'also', 'just', 'here', 'there', 'then', 'that',
  'these', 'those', 'with', 'from', 'have', 'been', 'will', 'would',
  'should', 'could', 'each', 'every', 'some', 'both', 'other', 'such',
  'keep', 'make', 'need', 'want', 'get', 'set', 'use', 'run', 'try',
  'let', 'put', 'new', 'old', 'all', 'any', 'not', 'but', 'yet',
  'now', 'how', 'can', 'may', 'did', 'does', 'done', 'its', 'our',
  'your', 'his', 'her', 'their', 'this', 'which', 'when', 'where',
  'while', 'since', 'until', 'into', 'only', 'very', 'more', 'most',
  'noch', 'auch', 'aber', 'denn', 'weil', 'wenn', 'dann', 'hier',
  'dort', 'schon', 'jetzt', 'immer', 'alles', 'mein', 'dein', 'sein',
]);

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

const escapeRegex = (value) => String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const containsEntity = (content, entityKey, requireWordBoundaryMatch = true) => {
  const text = normalizeContent(content);
  const key = normalizeContent(entityKey);
  if (!text || !key) return false;
  if (!requireWordBoundaryMatch) return text.includes(key);
  const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${escapeRegex(key)}([^\\p{L}\\p{N}_]|$)`, 'iu');
  return re.test(text);
};

const classifyPersonRole = (content) => {
  const text = String(content || '');
  if (RELATIONSHIP_RE.test(text)) return 'relationship';
  if (PUBLIC_PROFILE_RE.test(text)) return 'public_profile';
  if (OPS_NOISE_RE.test(text)) return 'ops_noise';
  return 'general';
};

const splitNameCandidates = (value) => {
  const text = String(value || '');
  const out = new Set();
  const proper = text.match(/\b[A-ZÄÖÜ][a-zäöüß]{2,}\b/g) || [];
  for (const item of proper) out.add(normalizeContent(item));

  const relation = text.match(/\b(?:partner(?:in)?|friend|wife|husband|girlfriend|boyfriend)\s+([A-Za-zÄÖÜäöüß-]{3,})\b/gi) || [];
  for (const match of relation) {
    const name = match.split(/\s+/).slice(-1).join(' ');
    const normalized = normalizeContent(name);
    if (normalized) out.add(normalized);
  }

  const known = text.match(WELL_KNOWN_NAMES_RE) || [];
  for (const item of known) {
    const normalized = normalizeContent(item);
    if (normalized) out.add(normalized);
  }
  return Array.from(out).filter((item) => item.length >= 3 && item.length <= 48 && !QUERY_STOPWORDS.has(item));
};

const isLikelyEntityToken = (value) => {
  const token = normalizeContent(value);
  if (!token) return false;
  if (token.length < 3 || token.length > 48) return false;
  if (/^\d+$/.test(token)) return false;
  if (QUERY_STOPWORDS.has(token)) return false;
  return true;
};

const pushEntityCandidate = (set, value) => {
  const normalized = normalizeContent(value);
  if (!isLikelyEntityToken(normalized)) return;
  set.add(normalized);
};

const scorePersonContent = ({
  content = '',
  entityKeys = [],
  config = {},
} = {}) => {
  const keys = Array.isArray(entityKeys) ? entityKeys.map((item) => normalizeContent(item)).filter(Boolean) : [];
  if (keys.length === 0) return null;
  let matched = false;
  for (const key of keys) {
    if (containsEntity(content, key, config?.person?.requireWordBoundaryMatch !== false)) {
      matched = true;
      break;
    }
  }
  if (!matched) return null;

  const role = classifyPersonRole(content);
  let score = 0.35;
  if (role === 'relationship') score += Number(config?.person?.relationshipPriorityBoost ?? 0.35);
  if (role === 'public_profile' && config?.person?.keepPublicFacts !== false) {
    score += Number(config?.person?.publicProfileBoost ?? 0.1);
  }
  if (role === 'ops_noise') score -= 0.25;
  return {
    score: clamp01(score),
    role,
  };
};

const ensurePersonStore = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_entity_mentions (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      entity_display TEXT NOT NULL,
      role TEXT NOT NULL,
      confidence REAL NOT NULL,
      source TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_entity_mentions_entity ON memory_entity_mentions(entity_key, role);
    CREATE INDEX IF NOT EXISTS idx_memory_entity_mentions_memory ON memory_entity_mentions(memory_id, source);
  `);
};

const rebuildEntityMentions = (db) => {
  ensurePersonStore(db);
  const rowsCurrent = db.prepare(`
    SELECT memory_id, content
    FROM memory_current
    WHERE status = 'active'
  `).all();
  const rowsNative = db.prepare(`
    SELECT chunk_id, content
    FROM memory_native_chunks
    WHERE status = 'active'
  `).all();

  const insert = db.prepare(`
    INSERT INTO memory_entity_mentions (
      id, memory_id, entity_key, entity_display, role, confidence, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const clear = db.prepare('DELETE FROM memory_entity_mentions');

  db.exec('BEGIN');
  try {
    clear.run();
    for (const row of rowsCurrent) {
      const memoryId = String(row.memory_id || '');
      const content = String(row.content || '');
      if (!memoryId || !content) continue;
      const role = classifyPersonRole(content);
      const confidence = role === 'relationship' ? 0.92 : role === 'public_profile' ? 0.84 : 0.65;
      for (const entity of splitNameCandidates(content)) {
        insert.run(
          `${memoryId}|${entity}|memory_current`,
          memoryId,
          entity,
          entity,
          role,
          confidence,
          'memory_current',
        );
      }
    }
    for (const row of rowsNative) {
      const chunkId = String(row.chunk_id || '');
      const content = String(row.content || '');
      if (!chunkId || !content) continue;
      const role = classifyPersonRole(content);
      const confidence = role === 'relationship' ? 0.86 : role === 'public_profile' ? 0.78 : 0.62;
      for (const entity of splitNameCandidates(content)) {
        insert.run(
          `${chunkId}|${entity}|memory_native`,
          `native:${chunkId}`,
          entity,
          entity,
          role,
          confidence,
          'memory_native',
        );
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
};

const resolveEntityKeysForQuery = (db, query, options = {}) => {
  ensurePersonStore(db);
  const raw = String(query || '').trim();
  if (!raw) return [];
  const queryNormalized = normalizeContent(raw);
  const tokens = queryNormalized.split(/\s+/).filter(Boolean);
  const out = new Set();

  const rows = db.prepare(`
    SELECT entity_key
    FROM memory_entity_mentions
    GROUP BY entity_key
    ORDER BY COUNT(*) DESC
    LIMIT 500
  `).all();
  for (const row of rows) {
    const key = normalizeContent(row.entity_key);
    if (!key) continue;
    if (key.includes(' ')) {
      if (queryNormalized.includes(key)) out.add(key);
      continue;
    }
    if (tokens.includes(key)) out.add(key);
  }

  const explicitTail = raw.match(ENTITY_QUERY_HINT_TAIL_RE)?.[1] || '';
  if (explicitTail) {
    const cleaned = String(explicitTail).split(/[?.!,:;]/)[0].trim();
    pushEntityCandidate(out, cleaned);
    const explicitTokens = normalizeContent(cleaned).split(/\s+/).filter(Boolean);
    for (const token of explicitTokens) pushEntityCandidate(out, token);
  }

  const properNames = raw.match(PROPER_NAME_RE) || [];
  for (const item of properNames) pushEntityCandidate(out, item);

  if (PERSON_QUERY_HINT_RE.test(raw)) {
    const directKnown = raw.match(WELL_KNOWN_NAMES_RE) || [];
    for (const item of directKnown) pushEntityCandidate(out, item);
  }

  if (options?.fallbackTokens === true || out.size === 0) {
    for (const token of tokens) {
      if (token.length >= 3 && token.length <= 24) pushEntityCandidate(out, token);
    }
    if (tokens.length > 0) pushEntityCandidate(out, tokens[tokens.length - 1]);
  }

  return Array.from(out).filter(Boolean).slice(0, 8);
};

export {
  containsEntity,
  classifyPersonRole,
  scorePersonContent,
  ensurePersonStore,
  rebuildEntityMentions,
  resolveEntityKeysForQuery,
};
