import assert from 'node:assert/strict';
import fs from 'node:fs';

import gigabrainPlugin, {
  deriveScopeFromWorkspaceDir,
  hasSessionPrelude,
  markSessionBriefed,
} from '../index.ts';
import {
  makeConfigObject,
  makeTempWorkspace,
  openDb,
  seedMemoryCurrent,
} from './helpers.js';

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
  const workspaceScope = deriveScopeFromWorkspaceDir('/tmp/Agent Workspace/CPTO Ops');
  assert.equal(workspaceScope.startsWith('project:cpto-ops:'), true, 'workspace-derived scope should be stable and slugged');

  const cache = new Map();
  markSessionBriefed(cache, 'session-a');
  markSessionBriefed(cache, 'session-b');
  assert.equal(hasSessionPrelude(cache, 'session-a'), true, 'marked sessions should be detected');
  assert.equal(hasSessionPrelude(cache, 'missing-session'), false, 'missing sessions should not appear briefed');

  for (let index = 0; index < 2105; index += 1) {
    markSessionBriefed(cache, `session-${index}`);
  }
  assert.equal(cache.size <= 2048, true, 'session cache pruning should stay below the hard session limit');
  assert.equal(cache.has('session-2104'), true, 'most recent session keys should survive pruning');

  const ws = makeTempWorkspace('gb-plugin-observational-recall-');
  try {
    const config = makeConfigObject(ws.workspace).plugins.entries.gigabrain.config;
    config.recall = {
      ...config.recall,
      autoInjectEnabled: true,
    };
    const handlers = new Map();
    gigabrainPlugin.register({
      config,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      on: (event, handler) => handlers.set(event, handler),
    });
    const db = openDb(ws.dbPath);
    seedMemoryCurrent(db, [{
      memory_id: 'plugin-observational-recall',
      type: 'DECISION',
      scope: 'cpto',
      content: 'The cpto agent owns roadmap planning and release sequencing.',
      normalized: 'the cpto agent owns roadmap planning and release sequencing',
    }]);
    const before = mutationCounts(db);
    db.close();

    const recall = await handlers.get('before_agent_start')(
      { messages: [{ role: 'user', content: 'Who owns roadmap planning?' }] },
      { agentId: 'cpto', sessionKey: 'plugin-observational-session', workspaceDir: ws.workspace },
    );
    assert.match(String(recall?.appendSystemContext || ''), /roadmap planning and release sequencing/);

    const afterDb = openDb(ws.dbPath);
    const after = mutationCounts(afterDb);
    afterDb.close();
    assert.deepEqual(after, before, 'plugin recall must not mutate sync, event, entity, or projection tables');
  } finally {
    fs.rmSync(ws.root, { recursive: true, force: true });
  }
};

export { run };
