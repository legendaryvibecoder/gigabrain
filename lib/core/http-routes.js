import { timingSafeEqual } from 'node:crypto';
import { openDatabase } from './sqlite.js';

import { ensureEventStore, listTimeline } from './event-store.js';
import { ensureProjectionStore, getCurrentMemory, materializeProjectionFromMemories } from './projection-store.js';
import { ensureNativeStore } from './native-sync.js';
import { ensurePersonStore } from './person-service.js';
import { recallForQuery } from './recall-service.js';
import { captureFromEvent } from './capture-service.js';

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

const requireToken = (req, token, allowNoAuth = false) => {
  const expectedToken = String(token || '').trim();
  if (!expectedToken) return allowNoAuth === true;
  const candidate = String(req.headers['x-gb-token'] || '');
  if (candidate.length !== expectedToken.length) return false;
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(expectedToken));
};

const _rateLimits = new Map();
const checkRateLimit = (endpoint, maxPerMinute = 60) => {
  const now = Date.now();
  let bucket = _rateLimits.get(endpoint);
  if (!bucket) {
    bucket = [];
    _rateLimits.set(endpoint, bucket);
  }
  while (bucket.length > 0 && bucket[0] < now - 60000) bucket.shift();
  if (bucket.length >= maxPerMinute) return false;
  bucket.push(now);
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
  const openDb = () => {
    const db = openDatabase(dbPath);
    try {
      ensureProjectionStore(db);
      ensureEventStore(db);
      ensureNativeStore(db);
      ensurePersonStore(db);
      const count = db.prepare('SELECT COUNT(*) AS c FROM memory_current').get()?.c || 0;
      if (Number(count) === 0) materializeProjectionFromMemories(db);
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
          const result = recallForQuery({ db, config, query, scope });
          sendJson(res, 200, {
            ok: true,
            results: result.results,
            debug: { fallbackUsed: result.fallbackUsed, budget: result.budget },
          });
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
          const recall = recallForQuery({ db, config, query, scope });
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
            results,
            count: results.length,
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
};
