import assert from 'node:assert/strict';

import { normalizeConfig } from '../lib/core/config.js';
import { runMaintenance } from '../lib/core/maintenance-service.js';
import { runAudit } from '../lib/core/audit-service.js';
import { makeTempWorkspace, makeConfigObject, openDb, seedMemoryCurrent } from './helpers.js';

const run = async () => {
  const ws = makeTempWorkspace('gb-v3-regression-');
  const config = normalizeConfig(makeConfigObject(ws.workspace).plugins.entries.gigabrain.config);
  const db = openDb(ws.dbPath);
  try {
    seedMemoryCurrent(db, [
      { memory_id: 'm-pref-1', type: 'PREFERENCE', content: 'User likes Mozzarella', scope: 'shared', confidence: 0.66 },
      { memory_id: 'm-rel-1', type: 'EPISODE', content: 'Alex told Atlas: I am proud of you', scope: 'shared', confidence: 0.6 },
      { memory_id: 'm-id-1', type: 'AGENT_IDENTITY', content: 'I am Atlas, learning every day', scope: 'profile:main', confidence: 0.63 },
      { memory_id: 'm-junk-1', type: 'CONTEXT', content: '<memory_clusters>meta wrapper</memory_clusters>', scope: 'shared', confidence: 0.8 },
      { memory_id: 'm-dupe-a', type: 'CONTEXT', content: 'Use markdown headings for release notes', scope: 'shared', confidence: 0.5 },
      { memory_id: 'm-dupe-b', type: 'CONTEXT', content: 'Use markdown headings for release notes', scope: 'shared', confidence: 0.45 },
      { memory_id: 'm-jabber-1', type: 'USER_FACT', content: 'User started a jabber on January 11, 2026, at 90kg', scope: 'nimbusmain', confidence: 0.5 },
    ]);
  } finally {
    db.close();
  }

  const maintenance = runMaintenance({
    dbPath: ws.dbPath,
    config,
    dryRun: false,
    runId: 'run-regression-maint',
    reviewVersion: 'rv-regression-maint',
  });
  assert.equal(maintenance.ok, true);

  const audit = await runAudit({
    dbPath: ws.dbPath,
    config,
    mode: 'apply',
    runId: 'run-regression-audit',
    reviewVersion: 'rv-regression-audit',
    llm: { enabled: false, provider: 'none' },
  });
  assert.equal(audit.ok, true);

  const verifyDb = openDb(ws.dbPath);
  try {
    const pref = verifyDb.prepare('SELECT status FROM memory_current WHERE memory_id = ?').get('m-pref-1');
    assert.equal(String(pref?.status || ''), 'active', 'preference must remain active');

    const rel = verifyDb.prepare('SELECT status FROM memory_current WHERE memory_id = ?').get('m-rel-1');
    assert.equal(String(rel?.status || ''), 'active', 'relationship memory must remain active');

    const identity = verifyDb.prepare('SELECT status FROM memory_current WHERE memory_id = ?').get('m-id-1');
    assert.equal(String(identity?.status || ''), 'active', 'agent identity must remain active');

    const junk = verifyDb.prepare('SELECT status FROM memory_current WHERE memory_id = ?').get('m-junk-1');
    assert.equal(String(junk?.status || ''), 'rejected', 'junk wrapper must be rejected');

    const jabber = verifyDb.prepare('SELECT status FROM memory_current WHERE memory_id = ?').get('m-jabber-1');
    assert.equal(String(jabber?.status || ''), 'archived', 'broken low-confidence user fact should be archived');

    const dupGroups = verifyDb.prepare(`
      SELECT COUNT(*) AS c
      FROM (
        SELECT normalized_hash, scope, COUNT(*) AS cnt
        FROM memory_current
        WHERE status = 'active'
        GROUP BY normalized_hash, scope
        HAVING cnt > 1
      )
    `).get()?.c || 0;
    assert.equal(Number(dupGroups), 0, 'exact duplicate groups in active set must be zero');
  } finally {
    verifyDb.close();
  }
};

export { run };
