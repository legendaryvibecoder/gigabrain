import { ensureNativeStore } from './native-sync.js';
import { normalizeContent } from './policy.js';
import { ensureProjectionStore, normalizeProjectionScope } from './projection-store.js';

const RELATIONSHIP_RE = /\b(?:partner(?:in)?|wife|husband|girlfriend|boyfriend|friend|best friend|relationship|lebt zusammen|live together|dating|date)\b/i;
const PUBLIC_PROFILE_RE = /\b(?:tedx|coach|coaching|speaker|life coaching|beratung|berater(?:in)?|sozialarbeiter(?:in)?|lebens(?:-|\s+und\s+)sozialberater(?:in)?)\b/i;
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
const ENTITY_NOISE_STOPWORDS = new Set([
  'partner', 'partnerin', 'beziehung', 'relationship', 'friend', 'boyfriend', 'girlfriend',
  'wife', 'husband', 'coach', 'life', 'berater', 'beraterin', 'speaker', 'community',
  'freundin', 'freund', 'sozialarbeiterin', 'sozialarbeiter',
  'profile', 'update', 'memory', 'context', 'entity', 'project', 'company',
  'add', 'are', 'was', 'ist', 'als', 'about', 'with', 'without', 'follow',
  'access', 'agent', 'approval', 'bridge', 'brigittaplatz', 'browser', 'calorie', 'calories',
  'chrome', 'club', 'code', 'cookies', 'disk', 'detaillierte', 'email', 'first', 'fort',
  'full', 'gateway', 'geburtstag', 'identity', 'kaffee', 'lebt', 'mac', 'menschen',
  'neobank', 'original', 'poly', 'prozess', 'refresh', 'restart', 'send', 'setup', 'soft',
  'studio', 'thoughtful', 'token', 'topic', 'uhr', 'user', 'verify', 'vienna', 'wichtige',
  'wien', 'wrong', 'zumsteinplatz', 'archive', 'contact', 'content', 'date',
  'warm',
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december', 'jan', 'feb', 'mar', 'apr',
  'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec', 'today', 'heute',
]);
const PLACEISH_TOKEN_RE = /(?:platz|strasse|straße|gasse|weg|allee|street|road)$/i;
const TECHISH_TOKEN_RE = /^(?:email|chrome|cookies|gateway|token|verify|refresh|restart|setup|plugin|vault|repo|project|company|organization|organisation|business|startup|browser|agent|user)$/i;

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

const isLikelyStandaloneNameCandidate = (original, normalized) => {
  if (!normalized || ENTITY_NOISE_STOPWORDS.has(normalized)) return false;
  if (PLACEISH_TOKEN_RE.test(original) || PLACEISH_TOKEN_RE.test(normalized)) return false;
  if (TECHISH_TOKEN_RE.test(normalized)) return false;
  if (!/^[a-zäöüß][a-zäöüß'’.-]{2,47}$/i.test(original)) return false;
  return true;
};

const splitNameCandidates = (value) => {
  const text = String(value || '');
  const out = new Set();
  const proper = text.match(/\b[A-ZÄÖÜ][a-zäöüß]{2,}\b/g) || [];
  for (const item of proper) {
    const normalized = normalizeContent(item);
    if (!isLikelyStandaloneNameCandidate(item, normalized)) continue;
    out.add(normalized);
  }

  const relation = text.match(/\b(?:partner(?:in)?|friend|wife|husband|girlfriend|boyfriend)\s+([A-Za-zÄÖÜäöüß-]{3,})\b/gi) || [];
  for (const match of relation) {
    const name = match.split(/\s+/).slice(-1).join(' ');
    if (!/^[A-ZÄÖÜ]/.test(name)) continue;
    const normalized = normalizeContent(name);
    if (!normalized || ENTITY_NOISE_STOPWORDS.has(normalized)) continue;
    out.add(normalized);
  }

  const known = text.match(WELL_KNOWN_NAMES_RE) || [];
  for (const item of known) {
    const normalized = normalizeContent(item);
    if (normalized) out.add(normalized);
  }
  return Array.from(out).filter((item) => item.length >= 3
    && item.length <= 48
    && !QUERY_STOPWORDS.has(item)
    && !ENTITY_NOISE_STOPWORDS.has(item));
};

const isLikelyEntityToken = (value) => {
  const token = normalizeContent(value);
  if (!token) return false;
  if (token.length < 3 || token.length > 48) return false;
  if (/^\d+$/.test(token)) return false;
  if (QUERY_STOPWORDS.has(token)) return false;
  if (ENTITY_NOISE_STOPWORDS.has(token)) return false;
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
      source TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'shared',
      source_path TEXT,
      linked_memory_id TEXT
    );
  `);
  try { db.exec("ALTER TABLE memory_entity_mentions ADD COLUMN scope TEXT NOT NULL DEFAULT 'shared'"); } catch {}
  try { db.exec('ALTER TABLE memory_entity_mentions ADD COLUMN source_path TEXT'); } catch {}
  try { db.exec('ALTER TABLE memory_entity_mentions ADD COLUMN linked_memory_id TEXT'); } catch {}
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_memory_entity_mentions_entity ON memory_entity_mentions(entity_key, role);
    CREATE INDEX IF NOT EXISTS idx_memory_entity_mentions_memory ON memory_entity_mentions(memory_id, source);
    CREATE INDEX IF NOT EXISTS idx_memory_entity_mentions_scope_entity ON memory_entity_mentions(scope, entity_key);
  `);
};

const normalizeEntityScopeQuery = (value = '') => {
  const normalized = normalizeProjectionScope(value || '', { allowEmpty: true });
  if (!normalized) return 'shared';
  return normalized;
};

const normalizeStoredMentionScope = (value = '') => {
  try {
    return normalizeProjectionScope(value || '', { allowEmpty: true });
  } catch {
    return '';
  }
};

const resolveNativeMentionScope = (row = {}) => {
  const linkedScope = normalizeStoredMentionScope(row.linked_scope);
  if (linkedScope) return linkedScope;
  const chunkScope = normalizeStoredMentionScope(row.chunk_scope);
  if (chunkScope) return chunkScope;
  const sourceKind = String(row.source_kind || '').trim().toLowerCase();
  if (sourceKind === 'curated') return 'shared';
  if (sourceKind === 'memory_md') return 'profile:main';
  return '';
};

const buildEntityMentionScopeFilter = (scope = '', column = 'scope') => {
  const normalizedScope = normalizeEntityScopeQuery(scope);
  if (normalizedScope === 'shared') {
    return {
      sql: `${column} = ?`,
      params: ['shared'],
    };
  }
  if (!normalizedScope.startsWith('project:') && !normalizedScope.startsWith('profile:')) {
    return {
      sql: `(${column} = ? OR ${column} = 'shared' OR ${column} = ''${normalizedScope === 'main' ? ` OR ${column} = 'profile:main'` : ''})`,
      params: [normalizedScope],
    };
  }
  return {
    sql: `(${column} = ? OR ${column} = 'shared')`,
    params: [normalizedScope],
  };
};

const rebuildEntityMentions = (db) => {
  ensureProjectionStore(db);
  ensureNativeStore(db);
  ensurePersonStore(db);
  const rowsCurrent = db.prepare(`
    SELECT memory_id, content, scope, source_path
    FROM memory_current
    WHERE status = 'active'
  `).all();
  const rowsNative = db.prepare(`
    SELECT
      chunk.chunk_id,
      chunk.content,
      chunk.scope AS chunk_scope,
      chunk.source_path,
      chunk.linked_memory_id,
      chunk.source_kind,
      linked.scope AS linked_scope
    FROM memory_native_chunks AS chunk
    LEFT JOIN memory_current AS linked
      ON linked.memory_id = chunk.linked_memory_id
      AND linked.status = 'active'
    WHERE chunk.status = 'active'
  `).all();

  const insert = db.prepare(`
    INSERT INTO memory_entity_mentions (
      id, memory_id, entity_key, entity_display, role, confidence, source, scope, source_path, linked_memory_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      const scope = normalizeStoredMentionScope(row.scope) || 'shared';
      for (const entity of splitNameCandidates(content)) {
        insert.run(
          `${memoryId}|${entity}|memory_current`,
          memoryId,
          entity,
          entity,
          role,
          confidence,
          'memory_current',
          scope,
          row.source_path ? String(row.source_path) : null,
          null,
        );
      }
    }
    for (const row of rowsNative) {
      const chunkId = String(row.chunk_id || '');
      const content = String(row.content || '');
      if (!chunkId || !content) continue;
      const role = classifyPersonRole(content);
      const confidence = role === 'relationship' ? 0.86 : role === 'public_profile' ? 0.78 : 0.62;
      const scope = resolveNativeMentionScope(row);
      for (const entity of splitNameCandidates(content)) {
        insert.run(
          `${chunkId}|${entity}|memory_native`,
          `native:${chunkId}`,
          entity,
          entity,
          role,
          confidence,
          'memory_native',
          scope,
          row.source_path ? String(row.source_path) : null,
          row.linked_memory_id ? String(row.linked_memory_id) : null,
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
  const scopeFilter = buildEntityMentionScopeFilter(options?.scope || 'shared');

  const rows = db.prepare(`
    SELECT entity_key
    FROM memory_entity_mentions
    WHERE ${scopeFilter.sql}
    GROUP BY entity_key
    ORDER BY COUNT(*) DESC
    LIMIT 500
  `).all(...scopeFilter.params);
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
  buildEntityMentionScopeFilter,
  containsEntity,
  classifyPersonRole,
  scorePersonContent,
  ensurePersonStore,
  rebuildEntityMentions,
  resolveEntityKeysForQuery,
};
