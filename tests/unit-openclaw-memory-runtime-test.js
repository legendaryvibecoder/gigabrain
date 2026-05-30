import assert from 'node:assert/strict';
import fs from 'node:fs';

import { createGigabrainMemoryManager } from '../lib/core/openclaw-memory-runtime.js';
import { hasTable } from '../lib/core/projection-store.js';
import { makeConfigObject, makeTempWorkspace, openDb, seedMemoryCurrent } from './helpers.js';

const run = async () => {
  const ws = makeTempWorkspace('gb-v3-openclaw-memory-runtime-');
  const raw = makeConfigObject(ws.workspace).plugins.entries.gigabrain.config;
  raw.runtime.paths.registryPath = ws.dbPath;
  raw.recall.semanticRerankEnabled = false;

  const db = openDb(ws.dbPath);
  try {
    seedMemoryCurrent(db, [{
      memory_id: 'runtime-memory-1',
      type: 'USER_FACT',
      content: 'The main operator uses a profile-scoped memory lane.',
      scope: 'profile:main',
      confidence: 0.96,
      value_score: 0.78,
    }]);
    assert.equal(hasTable(db, 'memory_syntheses'), false, 'test starts without world-model synthesis table');
  } finally {
    db.close();
  }

  const before = fs.statSync(ws.dbPath).mtimeMs;
  const manager = createGigabrainMemoryManager({ config: raw, agentId: 'main' });
  const status = manager.status();
  assert.equal(status.provider, 'gigabrain');

  const results = await manager.search('Which memory lane does the main operator use?', { maxResults: 3 });
  assert.match(String(results[0]?.snippet || ''), /profile-scoped memory lane/i);

  const after = fs.statSync(ws.dbPath).mtimeMs;
  assert.equal(after, before, 'status/search must not mutate the registry database');

  const ro = openDb(ws.dbPath);
  try {
    assert.equal(hasTable(ro, 'memory_syntheses'), false, 'read commands must not create synthesis/world-model tables');
  } finally {
    ro.close();
  }
};

export { run };
