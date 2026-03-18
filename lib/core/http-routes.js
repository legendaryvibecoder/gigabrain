import { timingSafeEqual } from 'node:crypto';
import { openDatabase } from './sqlite.js';

import { ensureEventStore, listTimeline } from './event-store.js';
import { ensureProjectionStore, getCurrentMemory, materializeProjectionFromMemories } from './projection-store.js';
import { ensureNativeStore } from './native-sync.js';
import { ensurePersonStore } from './person-service.js';
import { orchestrateRecall } from './orchestrator.js';
import { captureFromEvent } from './capture-service.js';
import {
  ensureWorldModelReady,
  ensureWorldModelStore,
  getEntityDetail,
  getEntityEvolution,
  listBeliefs,
  listContradictions,
  listEntities,
  listEpisodes,
  listRelationshipDetails,
  listOpenLoops,
  suggestContradictionResolution,
} from './world-model.js';

export const GIGABRAIN_HTTP_ROUTES = [
  { path: '/gb', match: 'exact' },
  { path: '/gb/health', match: 'exact' },
  { path: '/gb/bench/recall', match: 'exact' },
  { path: '/gb/control/apply', match: 'exact' },
  { path: '/gb/entities', match: 'exact' },
  { path: '/gb/entities/', match: 'prefix' },
  { path: '/gb/beliefs', match: 'exact' },
  { path: '/gb/episodes', match: 'exact' },
  { path: '/gb/open-loops', match: 'exact' },
  { path: '/gb/contradictions', match: 'exact' },
  { path: '/gb/relationships', match: 'exact' },
  { path: '/gb/evolution', match: 'exact' },
  { path: '/gb/recall', match: 'exact' },
  { path: '/gb/recall/explain', match: 'exact' },
  { path: '/gb/suggestions', match: 'exact' },
];

const parseJsonBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 262144) {
      req.destroy();
      reject(new Error('payload too large'));
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (size > 262144) return;
    try {
      const raw = Buffer.concat(chunks).toString('utf8');
      resolve(raw ? JSON.parse(raw) : {});
    } catch (err) {
      reject(err);
    }
  });
  req.on('error', reject);
});

const sendJson = (res, status, payload) => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
};

const isWhitespaceChar = (value = '') => (
  value === ' '
  || value === '\t'
  || value === '\n'
  || value === '\r'
  || value === '\f'
  || value === '\v'
);

const getBearerToken = (req) => {
  const authorization = String(req?.headers?.authorization || req?.headers?.Authorization || '');
  let index = 0;
  while (index < authorization.length && isWhitespaceChar(authorization[index])) index += 1;
  const scheme = authorization.slice(index, index + 6);
  if (scheme.toLowerCase() !== 'bearer') return '';
  index += 6;
  if (index >= authorization.length || !isWhitespaceChar(authorization[index])) return '';
  while (index < authorization.length && isWhitespaceChar(authorization[index])) index += 1;
  if (index >= authorization.length) return '';
  return authorization.slice(index).trim();
};

const requireToken = (req, token, allowNoAuth = false) => {
  const expectedToken = String(token || '').trim();
  if (!expectedToken) return allowNoAuth === true;
  const candidate = String(
    req.headers['x-gb-token']
    || req.headers['x-openclaw-token']
    || getBearerToken(req)
    || '',
  ).trim();
  if (candidate.length !== expectedToken.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(expectedToken));
};

const _rateLimits = new Map();
const RATE_LIMIT_MAX_ENDPOINTS = 256;
const RATE_LIMIT_WINDOW_MS = 60000;

const pruneRateLimits = (now = Date.now()) => {
  for (const [endpoint, bucket] of _rateLimits.entries()) {
    while (bucket.hits.length > 0 && bucket.hits[0] < now - RATE_LIMIT_WINDOW_MS) bucket.hits.shift();
    bucket.lastSeenAt = bucket.hits.length > 0 ? bucket.hits[bucket.hits.length - 1] : bucket.lastSeenAt;
    if (bucket.hits.length === 0) {
      _rateLimits.delete(endpoint);
    }
  }
};

const checkRateLimit = (endpoint, maxPerMinute = 60) => {
  const now = Date.now();
  pruneRateLimits(now);
  let bucket = _rateLimits.get(endpoint);
  if (!bucket) {
    if (_rateLimits.size >= RATE_LIMIT_MAX_ENDPOINTS) {
      const sorted = Array.from(_rateLimits.entries())
        .sort((a, b) => Number(a[1]?.lastSeenAt || 0) - Number(b[1]?.lastSeenAt || 0));
      while (_rateLimits.size >= RATE_LIMIT_MAX_ENDPOINTS && sorted.length > 0) {
        const [staleEndpoint] = sorted.shift();
        _rateLimits.delete(staleEndpoint);
      }
    }
    bucket = {
      hits: [],
      lastSeenAt: now,
    };
    _rateLimits.set(endpoint, bucket);
  }
  while (bucket.hits.length > 0 && bucket.hits[0] < now - RATE_LIMIT_WINDOW_MS) bucket.hits.shift();
  if (bucket.hits.length >= maxPerMinute) {
    bucket.lastSeenAt = now;
    return false;
  }
  bucket.hits.push(now);
  bucket.lastSeenAt = now;
  return true;
};

const resolveRankSource = (row, recallResult) => {
  const source = String(row?._source || '').toLowerCase();
  const hasHybridSignals = Boolean(recallResult?.temporalWindow)
    || (Array.isArray(recallResult?.entityKeys) && recallResult.entityKeys.length > 0);
  if (source === 'native') return 'hybrid';
  if (hasHybridSignals) return 'hybrid';
  return 'vector';
};

const toRecallScore = (row) => {
  if (Number.isFinite(Number(row?._score))) return Number(row._score);
  if (Number.isFinite(Number(row?.score))) return Number(row.score);
  return 0;
};

const createMemoryHttpHandler = ({
  dbPath,
  config,
  logger,
  token,
  allowNoAuth = false,
}) => {
  const renderMemoryActionTag = ({
    action = '',
    type = '',
    confidence = '',
    scope = '',
    target = '',
    targetMemoryId = '',
    content = '',
  } = {}) => {
    const attrs = [];
    const pushAttr = (key, value) => {
      const text = String(value || '').trim();
      if (!text) return;
      const escaped = text.replace(/"/g, '&quot;');
      attrs.push(`${key}="${escaped}"`);
    };
    pushAttr('action', action);
    pushAttr('type', type);
    pushAttr('confidence', confidence);
    pushAttr('scope', scope);
    pushAttr('target', target);
    pushAttr('target_memory_id', targetMemoryId);
    const body = String(content || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<memory_action ${attrs.join(' ')}>${body}</memory_action>`;
  };

  const openDb = () => {
    const db = openDatabase(dbPath);
    try {
      ensureProjectionStore(db);
      ensureEventStore(db);
      ensureNativeStore(db);
      ensurePersonStore(db);
      ensureWorldModelStore(db);
      const count = db.prepare('SELECT COUNT(*) AS c FROM memory_current').get()?.c || 0;
      if (Number(count) === 0) materializeProjectionFromMemories(db);
      ensureWorldModelReady({ db, config, rebuildIfEmpty: true });
      return db;
    } catch (err) {
      db.close();
      throw err;
    }
  };

  return async (req, res) => {
    try {
      if (!req?.url) return false;
      const full = new URL(req.url, 'http://localhost');
      const pathname = full.pathname;
      const method = String(req.method || 'GET').toUpperCase();

      if (pathname === '/gb' || pathname === '/gb/') {
        sendJson(res, 200, { ok: true, service: 'gigabrain-v3' });
        return true;
      }

      if (pathname === '/gb/health' && method === 'GET') {
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (pathname === '/gb/bench/recall' && method === 'POST') {
        if (!requireToken(req, token, allowNoAuth)) {
          sendJson(res, 401, { detail: 'invalid token' });
          return true;
        }
        const body = await parseJsonBody(req);
        const query = String(body?.query || '').trim();
        const scope = String(body?.agentId || body?.scope || '').trim();
        if (!query) {
          sendJson(res, 400, { detail: 'query required' });
          return true;
        }
        const db = openDb();
        try {
          const result = orchestrateRecall({ db, config, query, scope });
          sendJson(res, 200, {
            ok: true,
            results: result.results,
            debug: {
              fallbackUsed: result.fallbackUsed,
              budget: result.budget,
              strategy: result.strategy,
              deepLookupAllowed: result.deepLookupAllowed,
              entityIds: result.entityIds,
            },
          });
        } finally {
          db.close();
        }
        return true;
      }

      if (pathname === '/gb/control/apply' && method === 'POST') {
        if (!requireToken(req, token, allowNoAuth)) {
          sendJson(res, 401, { detail: 'invalid token' });
          return true;
        }
        const body = await parseJsonBody(req);
        const action = String(body?.action || '').trim().toLowerCase();
        const scope = String(body?.scope || body?.agentId || 'shared').trim() || 'shared';
        if (!action) {
          sendJson(res, 400, { detail: 'action required' });
          return true;
        }
        const tag = renderMemoryActionTag({
          action,
          type: body?.type || '',
          confidence: body?.confidence ?? '',
          scope,
          target: body?.target || '',
          targetMemoryId: body?.target_memory_id || '',
          content: body?.content || '',
        });
        const db = openDb();
        try {
          const result = captureFromEvent({
            db,
            config,
            event: {
              scope,
              agentId: scope,
              sessionKey: `http:${scope}`,
              text: tag,
              output: tag,
              prompt: '',
              messages: [],
            },
            logger,
            runId: `http-action-${new Date().toISOString().replace(/[:.]/g, '-')}`,
            reviewVersion: '',
          });
          sendJson(res, 200, { ok: true, action, scope, result });
        } finally {
          db.close();
        }
        return true;
      }

      const entityIdFromQuery = String(full.searchParams.get('id') || full.searchParams.get('entity_id') || '').trim();
      const entityMatch = pathname.match(/^\/gb\/entities\/([^/]+)$/);
      if (pathname === '/gb/entities' && method === 'GET') {
        if (!requireToken(req, token, allowNoAuth)) {
          sendJson(res, 401, { detail: 'invalid token' });
          return true;
        }
        const db = openDb();
        try {
          const items = listEntities(db, {
            kind: full.searchParams.get('kind') || '',
            limit: Number(full.searchParams.get('limit') || 200),
          });
          sendJson(res, 200, { ok: true, items, count: items.length });
        } finally {
          db.close();
        }
        return true;
      }

      if ((entityMatch || pathname === '/gb/entities/detail') && method === 'GET') {
        if (!requireToken(req, token, allowNoAuth)) {
          sendJson(res, 401, { detail: 'invalid token' });
          return true;
        }
        const db = openDb();
        try {
          const entityId = decodeURIComponent(String(entityMatch?.[1] || entityIdFromQuery || '').trim());
          if (!entityId) {
            sendJson(res, 400, { detail: 'entity id required' });
            return true;
          }
          const item = getEntityDetail(db, entityId);
          if (!item) {
            sendJson(res, 404, { detail: 'entity not found' });
            return true;
          }
          sendJson(res, 200, { ok: true, item });
        } finally {
          db.close();
        }
        return true;
      }

      if (pathname === '/gb/beliefs' && method === 'GET') {
        if (!requireToken(req, token, allowNoAuth)) {
          sendJson(res, 401, { detail: 'invalid token' });
          return true;
        }
        const db = openDb();
        try {
          const items = listBeliefs(db, {
            entityId: full.searchParams.get('entity_id') || '',
            status: full.searchParams.get('status') || '',
            limit: Number(full.searchParams.get('limit') || 200),
          });
          sendJson(res, 200, { ok: true, items, count: items.length });
        } finally {
          db.close();
        }
        return true;
      }

      if (pathname === '/gb/episodes' && method === 'GET') {
        if (!requireToken(req, token, allowNoAuth)) {
          sendJson(res, 401, { detail: 'invalid token' });
          return true;
        }
        const db = openDb();
        try {
          const items = listEpisodes(db, {
            entityId: full.searchParams.get('entity_id') || '',
            limit: Number(full.searchParams.get('limit') || 200),
          });
          sendJson(res, 200, { ok: true, items, count: items.length });
        } finally {
          db.close();
        }
        return true;
      }

      if (pathname === '/gb/open-loops' && method === 'GET') {
        if (!requireToken(req, token, allowNoAuth)) {
          sendJson(res, 401, { detail: 'invalid token' });
          return true;
        }
        const db = openDb();
        try {
          const items = listOpenLoops(db, {
            entityId: full.searchParams.get('entity_id') || '',
            kind: full.searchParams.get('kind') || '',
            limit: Number(full.searchParams.get('limit') || 200),
          });
          sendJson(res, 200, { ok: true, items, count: items.length });
        } finally {
          db.close();
        }
        return true;
      }

      if (pathname === '/gb/contradictions' && method === 'GET') {
        if (!requireToken(req, token, allowNoAuth)) {
          sendJson(res, 401, { detail: 'invalid token' });
          return true;
        }
        const db = openDb();
        try {
          const items = listContradictions(db, {
            entityId: full.searchParams.get('entity_id') || '',
            limit: Number(full.searchParams.get('limit') || 200),
          });
          sendJson(res, 200, { ok: true, items, count: items.length });
        } finally {
          db.close();
        }
        return true;
      }

      // Phase 5A: Relationships endpoint (canonical relationship graph)
      if (pathname === '/gb/relationships' && method === 'GET') {
        if (!requireToken(req, token, allowNoAuth)) {
          sendJson(res, 401, { detail: 'invalid token' });
          return true;
        }
        const db = openDb();
        try {
          const entityId = String(full.searchParams.get('entity_id') || '').trim();
          if (!entityId) {
            sendJson(res, 400, { detail: 'entity_id query param required' });
            return true;
          }
          const detail = getEntityDetail(db, entityId);
          if (!detail) {
            sendJson(res, 404, { detail: 'entity not found' });
            return true;
          }
          const relationships = listRelationshipDetails(db, {
            entityId,
            minEvidence: Math.max(1, Number(full.searchParams.get('min_evidence') || 1) || 1),
            limit: Math.max(1, Math.min(500, Number(full.searchParams.get('limit') || 200) || 200)),
          });
          sendJson(res, 200, { ok: true, entity_id: entityId, relationships, count: relationships.length });
        } finally {
          db.close();
        }
        return true;
      }

      // Phase 4B: Entity evolution endpoint
      if (pathname === '/gb/evolution' && method === 'GET') {
        if (!requireToken(req, token, allowNoAuth)) {
          sendJson(res, 401, { detail: 'invalid token' });
          return true;
        }
        const db = openDb();
        try {
          const entityId = String(full.searchParams.get('entity_id') || '').trim();
          if (!entityId) {
            sendJson(res, 400, { detail: 'entity_id query param required' });
            return true;
          }
          const evolution = getEntityEvolution(db, entityId);
          sendJson(res, 200, { ok: true, entity_id: entityId, evolution, slots: evolution.length });
        } finally {
          db.close();
        }
        return true;
      }

      const timelineMatch = pathname.match(/^\/gb\/memory\/([^/]+)\/timeline$/);
      if (timelineMatch && method === 'GET') {
        if (!requireToken(req, token, allowNoAuth)) {
          sendJson(res, 401, { detail: 'invalid token' });
          return true;
        }
        const memoryId = decodeURIComponent(String(timelineMatch[1] || '').trim());
        if (!memoryId) {
          sendJson(res, 400, { detail: 'memory id required' });
          return true;
        }
        const db = openDb();
        try {
          const current = getCurrentMemory(db, memoryId);
          const timeline = listTimeline(db, memoryId, {
            limit: Number(full.searchParams.get('limit') || 500),
          });
          sendJson(res, 200, { ok: true, memory_id: memoryId, current, timeline });
        } finally {
          db.close();
        }
        return true;
      }

      if (pathname === '/gb/recall' && method === 'POST') {
        if (!requireToken(req, token, allowNoAuth)) {
          sendJson(res, 401, { detail: 'invalid token' });
          return true;
        }
        if (!checkRateLimit('/gb/recall', 30)) {
          sendJson(res, 429, { detail: 'rate limit exceeded' });
          return true;
        }
        const body = await parseJsonBody(req);
        const query = String(body?.query || '').trim();
        const scope = String(body?.scope || '').trim();
        const topK = Math.max(1, Math.min(20, Number(body?.topK || 5) || 5));
        if (!query) {
          sendJson(res, 400, { detail: 'query required' });
          return true;
        }

        const db = openDb();
        try {
          const recall = orchestrateRecall({ db, config, query, scope });
          const results = (recall.results || []).slice(0, topK).map((row) => ({
            memory_id: row.memory_id || row.id || '',
            content: row.content || '',
            type: row.type || '',
            score: toRecallScore(row),
            scope: row.scope || '',
            rank_source: resolveRankSource(row, recall),
          }));

          sendJson(res, 200, {
            ok: true,
            schema_version: '1.0',
            query,
            strategy: recall.strategy,
            ranking_mode: recall.rankingMode,
            deep_lookup_allowed: recall.deepLookupAllowed,
            deep_lookup_reason: recall.deepLookupReason,
            selected_entity_id: recall.selectedEntityId,
            selected_entity_kind: recall.selectedEntityKind,
            selected_entity_display_name: recall.selectedEntityDisplayName,
            results,
            count: results.length,
          });
        } finally {
          db.close();
        }
        return true;
      }

      if (pathname === '/gb/recall/explain' && method === 'POST') {
        if (!requireToken(req, token, allowNoAuth)) {
          sendJson(res, 401, { detail: 'invalid token' });
          return true;
        }
        if (!checkRateLimit('/gb/recall/explain', 20)) {
          sendJson(res, 429, { detail: 'rate limit exceeded' });
          return true;
        }
        const body = await parseJsonBody(req);
        const query = String(body?.query || '').trim();
        const scope = String(body?.scope || '').trim();
        if (!query) {
          sendJson(res, 400, { detail: 'query required' });
          return true;
        }
        const db = openDb();
        try {
          const recall = orchestrateRecall({ db, config, query, scope });
          sendJson(res, 200, {
            ok: true,
            query,
            strategy: recall.strategy,
            ranking_mode: recall.rankingMode,
            confidence: recall.confidence,
            deep_lookup_allowed: recall.deepLookupAllowed,
            deep_lookup_reason: recall.deepLookupReason,
            used_world_model: recall.usedWorldModel,
            stale_flags: recall.staleFlags,
            temporal_window: recall.temporalWindow,
            entity_matches: recall.entityMatches,
            selected_entity_id: recall.selectedEntityId,
            selected_entity_kind: recall.selectedEntityKind,
            selected_entity_display_name: recall.selectedEntityDisplayName,
            selected_entity_confidence: recall.selectedEntityConfidence,
            contradictions: recall.contradictions,
            open_loops: recall.openLoops,
            result_count: Array.isArray(recall.results) ? recall.results.length : 0,
            explain: recall.explain,
          });
        } finally {
          db.close();
        }
        return true;
      }

      if (pathname === '/gb/suggestions' && method === 'POST') {
        if (!requireToken(req, token, allowNoAuth)) {
          sendJson(res, 401, { detail: 'invalid token' });
          return true;
        }
        if (!checkRateLimit('/gb/suggestions', 10)) {
          sendJson(res, 429, { detail: 'rate limit exceeded' });
          return true;
        }
        const body = await parseJsonBody(req);
        const suggestions = body?.suggestions;
        if (!Array.isArray(suggestions) || suggestions.length === 0) {
          sendJson(res, 400, { detail: 'suggestions array required' });
          return true;
        }

        const validSuggestions = suggestions
          .filter((s) => s?.content && typeof s.content === 'string' && s.content.trim().length >= 15)
          .slice(0, 20);

        if (validSuggestions.length === 0) {
          sendJson(res, 400, { detail: 'no valid suggestions (min 15 chars)' });
          return true;
        }

        const memoryNoteTags = validSuggestions
          .map((s) => {
            const type = String(s.type || 'CONTEXT').toUpperCase();
            const validTypes = ['USER_FACT', 'PREFERENCE', 'DECISION', 'ENTITY', 'EPISODE', 'AGENT_IDENTITY', 'CONTEXT'];
            const safeType = validTypes.includes(type) ? type : 'CONTEXT';
            const confidence = Math.max(0.5, Math.min(1.0, Number(s.confidence || 0.6)));
            const content = String(s.content).trim().slice(0, 500);
            const escaped = content
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;');
            return `<memory_note type="${safeType}" confidence="${confidence}">${escaped}</memory_note>`;
          })
          .join('\n');

        const db = openDb();
        try {
          const result = captureFromEvent({
            db,
            config,
            event: {
              scope: 'shared',
              agentId: 'spark-bridge',
              sessionKey: 'spark-bridge:shared',
              text: memoryNoteTags,
              output: memoryNoteTags,
              prompt: '',
              messages: [],
              meta: {
                source: 'spark-giga-bridge',
                schema_version: String(body?.schema_version || '1.0'),
                trace_id: String(body?.trace_id || ''),
              },
              metadata: { source: 'spark-giga-bridge' },
              llmUnavailable: false,
            },
            logger,
            runId: `spark-suggest-${new Date().toISOString().replace(/[:.]/g, '-')}`,
            reviewVersion: '',
          });

          sendJson(res, 200, {
            ok: true,
            schema_version: '1.0',
            inserted: result.inserted || 0,
            queued_review: result.queued_review || 0,
            duplicates: result.duplicates || 0,
            received: validSuggestions.length,
          });
        } finally {
          db.close();
        }
        return true;
      }

      return false;
    } catch (err) {
      logger?.error?.(`[gigabrain] http route failure ${err instanceof Error ? err.message : String(err)}`);
      sendJson(res, 500, { detail: 'internal error' });
      return true;
    }
  };
};

export {
  createMemoryHttpHandler,
  checkRateLimit,
  pruneRateLimits,
};
