import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';

import {
  GIGABRAIN_HTTP_ROUTES,
  createMemoryHttpHandler,
  checkRateLimit,
  rateLimitKeyForRequest,
  requireToken,
  resolveRankSource,
} from '../lib/core/http-routes.js';
import { normalizeConfig } from '../lib/core/config.js';
import {
  makeConfigObject,
  makeTempWorkspace,
  openDb,
  seedMemoryCurrent,
} from './helpers.js';

const routeRegistryCovers = (path) => GIGABRAIN_HTTP_ROUTES.some((route) => (
  route.match === 'prefix' ? path.startsWith(route.path) : path === route.path
));

const startServer = async (handler) => {
  const server = http.createServer(async (req, res) => {
    const handled = await handler(req, res);
    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not handled');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind test server');
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
};

const mutationCounts = (db) => {
  const count = (table) => {
    try {
      return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c || 0);
    } catch {
      return 0;
    }
  };
  return {
    current: count('memory_current'),
    events: count('memory_events'),
    native: count('memory_native_sync_state'),
    entities: count('memory_entities'),
  };
};

const run = async () => {
  const baseEndpoint = `rate-limit-${Date.now()}`;
  for (let i = 0; i < 70; i += 1) {
    const allowed = checkRateLimit(`${baseEndpoint}-many-${i}`, 1);
    assert.equal(allowed, true, 'new endpoints should be admitted up to the cap');
  }
  assert.equal(checkRateLimit(`${baseEndpoint}-single`, 1), true, 'first request should pass');
  assert.equal(checkRateLimit(`${baseEndpoint}-single`, 1), false, 'second request in the same minute should be rate limited');
  assert.notEqual(
    rateLimitKeyForRequest({ socket: { remoteAddress: '192.0.2.10' } }, '/gb/recall'),
    rateLimitKeyForRequest({ socket: { remoteAddress: '192.0.2.11' } }, '/gb/recall'),
    'independent clients must not share one global endpoint bucket',
  );
  assert.equal(resolveRankSource({ _source: 'active' }), 'lexical');
  assert.equal(resolveRankSource({ _lex_rank: 0, _dense_rank: null }), 'lexical');
  assert.equal(resolveRankSource({ _source: 'dense', _lex_rank: null, _dense_rank: 0 }), 'vector');
  assert.equal(resolveRankSource({ _lex_rank: 0, _dense_rank: 1 }), 'hybrid');

  const expectedToken = 'abcd';
  assert.equal(
    requireToken({ headers: { 'x-gb-token': expectedToken } }, expectedToken),
    true,
    'matching UTF-8 token bytes authenticate',
  );
  assert.doesNotThrow(
    () => requireToken({ headers: { 'x-gb-token': 'éééé' } }, expectedToken),
    'equal UTF-16 lengths with different UTF-8 byte lengths must not reach timingSafeEqual',
  );
  assert.equal(
    requireToken({ headers: { 'x-gb-token': 'éééé' } }, expectedToken),
    false,
    'non-ASCII byte-length mismatch is rejected instead of throwing',
  );

  const handledPaths = [
    '/gb',
    '/gb/health',
    '/gb/bench/recall',
    '/gb/control/apply',
    '/gb/entities',
    '/gb/entities/example-entity',
    '/gb/beliefs',
    '/gb/episodes',
    '/gb/open-loops',
    '/gb/contradictions',
    '/gb/adjudications',
    '/gb/beliefs-as-of',
    '/gb/review-queue',
    '/gb/relationships',
    '/gb/evolution',
    '/gb/memory/example-memory/timeline',
    '/gb/recall',
    '/gb/recall/explain',
    '/gb/suggestions',
  ];
  for (const path of handledPaths) {
    assert.equal(routeRegistryCovers(path), true, `${path} must be registered with the host gateway`);
  }

  const ws = makeTempWorkspace('gb-http-observational-recall-');
  try {
    const configObject = makeConfigObject(ws.workspace);
    const db = openDb(ws.dbPath);
    seedMemoryCurrent(db, [
      {
        memory_id: 'http-shared-recall',
        type: 'DECISION',
        scope: 'shared',
        content: 'Shared copper lighthouse release policy is active.',
        normalized: 'shared copper lighthouse release policy is active',
      },
      {
        memory_id: 'http-project-recall',
        type: 'DECISION',
        scope: 'project:alpha',
        content: 'Project copper lighthouse release policy is active.',
        normalized: 'project copper lighthouse release policy is active',
      },
      {
        memory_id: 'http-private-profile-shadow',
        type: 'USER_FACT',
        scope: 'profile:user',
        content: 'Private profile copper lighthouse release policy is active.',
        normalized: 'private profile copper lighthouse release policy is active',
      },
    ]);
    db.close();
    const handler = createMemoryHttpHandler({
      dbPath: ws.dbPath,
      config: normalizeConfig(configObject.plugins.entries.gigabrain.config),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      token: 'test-http-token',
    });
    const beforeDb = openDb(ws.dbPath);
    const before = mutationCounts(beforeDb);
    beforeDb.close();
    const { server, baseUrl } = await startServer(handler);
    try {
      const response = await fetch(`${baseUrl}/gb/recall`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-gb-token': 'test-http-token',
        },
        body: JSON.stringify({ query: 'copper lighthouse release policy', topK: 3 }),
      });
      assert.equal(response.ok, true, 'HTTP recall should remain available through the read-only path');
      const payload = await response.json();
      assert.match(String(payload.results?.[0]?.content || ''), /copper lighthouse/);
      assert.deepEqual(
        [...new Set((payload.results || []).map((row) => row.scope))],
        ['shared'],
        'missing HTTP scope must default to shared-only recall',
      );
      const projectResponse = await fetch(`${baseUrl}/gb/recall`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-gb-token': 'test-http-token',
        },
        body: JSON.stringify({
          query: 'copper lighthouse release policy',
          scope: 'project:alpha',
          topK: 10,
        }),
      });
      assert.equal(projectResponse.ok, true, 'explicit project HTTP recall should return 200');
      const projectPayload = await projectResponse.json();
      assert.match(String(projectPayload.results?.[0]?.content || ''), /Project copper lighthouse/);
      assert.deepEqual(
        [...new Set((projectPayload.results || []).map((row) => row.scope))],
        ['project:alpha'],
        'explicit project HTTP recall must exclude shared and profile rows',
      );
    } finally {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    }
    const afterDb = openDb(ws.dbPath);
    const after = mutationCounts(afterDb);
    afterDb.close();
    assert.deepEqual(after, before, 'HTTP recall must not mutate sync, event, entity, or projection tables');
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
};

export { run };
