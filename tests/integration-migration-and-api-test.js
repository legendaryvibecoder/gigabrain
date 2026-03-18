import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { DatabaseSync } from 'node:sqlite';

import { normalizeConfig } from '../lib/core/config.js';
import { createMemoryHttpHandler } from '../lib/core/http-routes.js';
import { ensureWorldModelStore } from '../lib/core/world-model.js';
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
  const pluginManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'openclaw.plugin.json'), 'utf8'));
  assert.equal(pluginManifest.kind, 'memory', 'plugin manifest must declare kind=memory for OpenClaw memory slot registration');

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
    translationModel: 'qwen3.5:9b',
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
  ensureWorldModelStore(db);
  db.prepare(`
    INSERT INTO memory_current (
      memory_id, type, content, normalized, normalized_hash, source, source_layer, confidence, scope, status,
      value_score, value_label, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'capture', 'registry', ?, ?, 'active', ?, 'core', ?, ?)
  `).run(
    'wm-source-riley-vienna',
    'USER_FACT',
    'Riley lives in Vienna.',
    'riley lives in vienna',
    'wm-source-riley-vienna',
    0.82,
    'shared',
    0.75,
    '2026-01-01T09:00:00.000Z',
    '2026-01-01T09:00:00.000Z',
  );
  db.prepare(`
    INSERT INTO memory_current (
      memory_id, type, content, normalized, normalized_hash, source, source_layer, confidence, scope, status,
      value_score, value_label, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'capture', 'registry', ?, ?, 'active', ?, 'core', ?, ?)
  `).run(
    'wm-source-riley-berlin',
    'USER_FACT',
    'Riley lives in Berlin now.',
    'riley lives in berlin now',
    'wm-source-riley-berlin',
    0.91,
    'shared',
    0.8,
    '2026-02-01T09:00:00.000Z',
    '2026-02-01T09:00:00.000Z',
  );
  db.prepare(`
    INSERT INTO memory_entities (
      entity_id, kind, display_name, normalized_name, status, confidence, aliases, created_at, updated_at, payload
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
  `).run(
    'person:riley',
    'person',
    'Riley',
    'riley',
    0.92,
    JSON.stringify(['Riley']),
    '2026-02-02T09:00:00.000Z',
    '2026-02-02T09:00:00.000Z',
    '{}',
  );
  db.prepare(`
    INSERT INTO memory_entities (
      entity_id, kind, display_name, normalized_name, status, confidence, aliases, created_at, updated_at, payload
    ) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)
  `).run(
    'person:jordan',
    'person',
    'Jordan',
    'jordan',
    0.89,
    JSON.stringify(['Jordan']),
    '2026-02-02T09:00:00.000Z',
    '2026-02-02T09:00:00.000Z',
    '{}',
  );
  db.prepare(`
    INSERT INTO memory_beliefs (
      belief_id, entity_id, type, content, status, confidence, valid_from, valid_to, supersedes_belief_id,
      source_memory_id, source_layer, source_path, source_line, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'belief:riley-vienna',
    'person:riley',
    'USER_FACT',
    'Riley lives in Vienna.',
    'stale',
    0.82,
    '2026-01-01',
    null,
    null,
    'wm-source-riley-vienna',
    'registry',
    '',
    null,
    JSON.stringify({ claim_slot: 'location.current', claim_value: 'Vienna' }),
  );
  db.prepare(`
    INSERT INTO memory_beliefs (
      belief_id, entity_id, type, content, status, confidence, valid_from, valid_to, supersedes_belief_id,
      source_memory_id, source_layer, source_path, source_line, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'belief:riley-berlin',
    'person:riley',
    'USER_FACT',
    'Riley lives in Berlin now.',
    'active',
    0.91,
    '2026-02-01',
    null,
    'belief:riley-vienna',
    'wm-source-riley-berlin',
    'registry',
    '',
    null,
    JSON.stringify({ claim_slot: 'location.current', claim_value: 'Berlin' }),
  );
  db.prepare(`
    INSERT INTO memory_entity_relationships (
      relationship_id, entity_id_a, entity_id_b, relationship_type,
      evidence_count, source_memory_ids, confidence, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'rel:riley-jordan',
    'person:jordan',
    'person:riley',
    'co_occurrence',
    2,
    JSON.stringify([sampleId, 'wm-source-riley-berlin']),
    0.74,
    '2026-02-03T09:00:00.000Z',
    '2026-02-03T09:00:00.000Z',
  );
  db.prepare(`
    INSERT INTO memory_syntheses (
      synthesis_id, kind, subject_type, subject_id, content, stale, confidence, generated_at, input_hash, payload
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'synth:fixture-world',
    'entity_brief',
    'entity',
    'person:riley',
    'Riley currently lives in Berlin.',
    0,
    0.88,
    '2099-01-01T00:00:00.000Z',
    'fixture-world',
    '{}',
  );
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

    const entitiesRes = await fetch(`${baseUrl}/gb/entities`, {
      headers: { 'X-GB-Token': testToken },
    });
    assert.equal(entitiesRes.ok, true, 'entities endpoint should return 200');
    const entitiesJson = await entitiesRes.json();
    assert.equal(Array.isArray(entitiesJson.items), true);

    const explainRes = await fetch(`${baseUrl}/gb/recall/explain`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GB-Token': testToken,
      },
      body: JSON.stringify({
        query: 'Who is Atlas?',
        scope: 'profile:main',
      }),
    });
    assert.equal(explainRes.ok, true, 'recall explain endpoint should return 200');
    const explainJson = await explainRes.json();
    assert.equal(typeof explainJson.strategy, 'string');
    assert.equal(Object.prototype.hasOwnProperty.call(explainJson, 'deep_lookup_allowed'), true, 'explain payload should expose deep lookup gating');

    const evolutionRes = await fetch(`${baseUrl}/gb/evolution?entity_id=${encodeURIComponent('person:riley')}`, {
      headers: { 'X-GB-Token': testToken },
    });
    assert.equal(evolutionRes.ok, true, 'evolution endpoint should return 200');
    const evolutionJson = await evolutionRes.json();
    assert.equal(evolutionJson.ok, true);
    assert.equal(evolutionJson.slots >= 1, true, 'evolution endpoint should return at least one slot history');
    assert.equal(
      evolutionJson.evolution[0]?.history?.some((row) => row.claim_value === 'Vienna'),
      true,
      'evolution history should expose earlier belief values from payload.claim_value',
    );
    assert.equal(
      evolutionJson.evolution[0]?.current?.claim_value,
      'Berlin',
      'evolution endpoint should expose the current normalized belief value',
    );

    const relationshipsRes = await fetch(`${baseUrl}/gb/relationships?entity_id=${encodeURIComponent('person:riley')}`, {
      headers: { 'X-GB-Token': testToken },
    });
    assert.equal(relationshipsRes.ok, true, 'relationships endpoint should return 200');
    const relationshipsJson = await relationshipsRes.json();
    assert.equal(relationshipsJson.ok, true);
    assert.equal(relationshipsJson.count >= 1, true, 'relationships endpoint should return stored relationship rows');
    assert.equal(
      relationshipsJson.relationships.some((row) => row.counterpart_entity?.display_name === 'Jordan'),
      true,
      'relationships endpoint should use canonical stored relationships rather than ad-hoc belief field guesses',
    );

    const controlRes = await fetch(`${baseUrl}/gb/control/apply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GB-Token': testToken,
      },
      body: JSON.stringify({
        action: 'protect',
        target_memory_id: sampleId,
      }),
    });
    assert.equal(controlRes.ok, true, 'control apply endpoint should return 200');
    const controlJson = await controlRes.json();
    assert.equal(controlJson.ok, true);
    assert.equal(Number(controlJson?.result?.actions_protected || 0) >= 1, true, 'protect action should be applied through the HTTP route');

    const verifyDb = new DatabaseSync(ws.dbPath);
    try {
      const protectedRow = verifyDb.prepare('SELECT tags FROM memory_current WHERE memory_id = ?').get(sampleId);
      assert.equal(String(protectedRow?.tags || '').includes('protected'), true, 'control action should persist protected tag');
    } finally {
      verifyDb.close();
    }
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve(undefined))));
  }
};

export { run };
