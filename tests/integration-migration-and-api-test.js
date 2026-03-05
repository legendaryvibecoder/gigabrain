import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { DatabaseSync } from 'node:sqlite';

import { normalizeConfig } from '../lib/core/config.js';
import { createMemoryHttpHandler } from '../lib/core/http-routes.js';
import { makeTempWorkspace, makeConfigObject, writeConfigFile, assertFileExists } from './helpers.js';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const runScript = (args) => {
  const result = spawnSync('node', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`script failed: ${args.join(' ')}\n${result.stderr || result.stdout}`);
  }
  return result;
};

const createLegacyFixtureDb = (dbPath) => {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      normalized TEXT NOT NULL,
      confidence REAL,
      status TEXT,
      scope TEXT,
      created_at TEXT,
      updated_at TEXT
    );
  `);
  const insert = db.prepare(`
    INSERT INTO memories (id, type, content, normalized, confidence, status, scope, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const nowIso = new Date().toISOString();
  insert.run(randomUUID(), 'PREFERENCE', 'User likes Mozzarella', 'user likes mozzarella', 0.7, 'active', 'shared', nowIso, nowIso);
  insert.run(randomUUID(), 'AGENT_IDENTITY', 'I am Atlas and evolving', 'i am atlas and evolving', 0.8, 'active', 'profile:main', nowIso, nowIso);
  db.close();
};

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
  if (!address || typeof address === 'string') throw new Error('failed to bind server');
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
};

const run = async () => {
  const ws = makeTempWorkspace('gb-v3-int-migrate-');
  createLegacyFixtureDb(ws.dbPath);

  const configObject = makeConfigObject(ws.workspace);
  // simulate legacy-era keys so migration must convert to v3 grouped config
  configObject.plugins.entries.gigabrain.config = {
    enabled: true,
    recallTopK: 9,
    recallMinScore: 0.5,
    recallMaxTokens: 1100,
    captureSemanticDedupe: true,
    memorySemanticDedupeAutoThreshold: 0.92,
    memorySemanticDedupeReviewThreshold: 0.85,
    memoryScope: 'shared',
    sharedAgentId: 'shared',
    paths: { workspaceRoot: ws.workspace, memoryRoot: 'memory' },
    memoryRegistryPath: ws.dbPath,
    memoryJunkFilterEnabled: true,
    memoryMinContentChars: 25,
    memoryMinConfidence: 0.6,
    ollamaUrl: 'http://127.0.0.1:11434',
    translationModel: 'qwen2.5:14b',
  };
  writeConfigFile(ws.configPath, configObject);

  const rollbackPath = path.join(ws.outputRoot, 'rollback-meta.json');
  runScript([
    'scripts/migrate-v3.js',
    '--apply',
    '--config', ws.configPath,
    '--db', ws.dbPath,
    '--rollback-meta', rollbackPath,
  ]);

  assertFileExists(rollbackPath, 'rollback metadata');
  const migratedConfig = JSON.parse(fs.readFileSync(ws.configPath, 'utf8'));
  const pluginConfig = migratedConfig.plugins.entries.gigabrain.config;
  assert.equal(typeof pluginConfig.runtime, 'object', 'migrated config must include runtime group');
  assert.equal(Object.prototype.hasOwnProperty.call(pluginConfig, 'memoryRegistryPath'), false, 'legacy memoryRegistryPath must be removed');
  assert.equal(Object.prototype.hasOwnProperty.call(pluginConfig, 'translationModel'), false, 'legacy translationModel must be removed');

  const db = new DatabaseSync(ws.dbPath);
  const projectionRows = db.prepare('SELECT COUNT(*) AS c FROM memory_current').get()?.c || 0;
  const eventRows = db.prepare('SELECT COUNT(*) AS c FROM memory_events').get()?.c || 0;
  assert.equal(Number(projectionRows) >= 2, true, 'migration should materialize projection rows');
  assert.equal(Number(eventRows) >= 2, true, 'migration should backfill events');
  const sampleId = String(db.prepare('SELECT memory_id FROM memory_current LIMIT 1').get()?.memory_id || '');
  db.close();

  const normalized = normalizeConfig(pluginConfig);
  const testToken = 'test-integration-token';
  const handler = createMemoryHttpHandler({
    dbPath: ws.dbPath,
    config: normalized,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    token: testToken,
  });
  const { server, baseUrl } = await startServer(handler);
  try {
    const unauthorizedTimelineRes = await fetch(`${baseUrl}/gb/memory/${encodeURIComponent(sampleId)}/timeline`);
    assert.equal(unauthorizedTimelineRes.status, 401, 'timeline endpoint should require auth');

    const timelineRes = await fetch(`${baseUrl}/gb/memory/${encodeURIComponent(sampleId)}/timeline`, {
      headers: { 'X-GB-Token': testToken },
    });
    assert.equal(timelineRes.ok, true, 'timeline endpoint should return 200');
    const timelineJson = await timelineRes.json();
    assert.equal(timelineJson.ok, true);
    assert.equal(Array.isArray(timelineJson.timeline), true);
    assert.equal(timelineJson.timeline.length >= 1, true, 'timeline should contain backfilled history');

    for (let i = 1; i < timelineJson.timeline.length; i += 1) {
      const prev = Date.parse(timelineJson.timeline[i - 1].timestamp);
      const curr = Date.parse(timelineJson.timeline[i].timestamp);
      assert.equal(prev <= curr, true, 'timeline should be ordered ascending');
    }
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve(undefined))));
  }
};

export { run };
