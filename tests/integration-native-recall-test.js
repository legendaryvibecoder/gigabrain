import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeConfig } from '../lib/core/config.js';
import { runMaintenance } from '../lib/core/maintenance-service.js';
import { rebuildEntityMentions } from '../lib/core/person-service.js';
import { recallForQuery } from '../lib/core/recall-service.js';
import { makeTempWorkspace, makeConfigObject, openDb } from './helpers.js';

const run = async () => {
  const ws = makeTempWorkspace('gb-v3-int-native-recall-');
  const memoryDir = path.join(ws.workspace, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(ws.workspace, 'MEMORY.md'), `
# MEMORY

## Relationship

- Riley is Jordan partner and they live together.
`, 'utf8');
  fs.writeFileSync(path.join(memoryDir, '2026-01-15.md'), `
# 2026-01-15

## 08:00 UTC

### CONTEXT
- [m:abc12345-aaaa-bbbb-cccc-1234567890ab] In January 2026, Jordan and Atlas worked on gigabrain architecture.
`, 'utf8');
  fs.writeFileSync(path.join(memoryDir, 'whois.md'), `
# whois

- Riley is Jordan partner and has birthday on Nov 6.
`, 'utf8');

  const config = normalizeConfig(makeConfigObject(ws.workspace).plugins.entries.gigabrain.config);
  const maintain = runMaintenance({
    dbPath: ws.dbPath,
    config,
    dryRun: false,
    runId: 'run-native-recall-maint',
    reviewVersion: 'rv-native-recall-maint',
  });
  assert.equal(maintain.ok, true);

  const db = openDb(ws.dbPath);
  try {
    // Seed a noisy instruction-like memory plus a factual memory for a synthetic entity.
    // Entity questions should prefer direct facts over "add to profile" instruction text.
    db.prepare(`
      INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash, source, confidence, scope, status, value_score, value_label, created_at, updated_at
      ) VALUES (
        ?, 'CONTEXT', ?, ?, ?, 'capture', 0.9, 'shared', 'active', 0.99, 'core', datetime('now'), datetime('now')
      )
    `).run(
      'm-novara-instruction',
      'Add to profile: Novara is Jordan partner and birthday Nov 6.',
      'add to profile novara is jordan partner and birthday nov 6',
      'h-novara-instruction',
    );
    db.prepare(`
      INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash, source, confidence, scope, status, value_score, value_label, created_at, updated_at
      ) VALUES (
        ?, 'USER_FACT', ?, ?, ?, 'capture', 0.95, 'shared', 'active', 0.72, 'core', datetime('now'), datetime('now')
      )
    `).run(
      'm-novara-fact',
      'Novara is Jordan partner and birthday Nov 6.',
      'novara is jordan partner and birthday nov 6',
      'h-novara-fact',
    );
    rebuildEntityMentions(db);

    const jan = recallForQuery({
      db,
      config,
      query: 'What happened in January 2026 with gigabrain?',
      scope: 'main',
    });
    assert.equal(jan.results.length >= 1, true, 'temporal query should return at least one result');
    const hasJanuaryNative = jan.results.some((row) =>
      String(row._source || '') === 'native'
      && String(row.source_date || '').startsWith('2026-01'),
    );
    assert.equal(hasJanuaryNative, true, 'temporal recall should pull January native chunk');

    const shared = recallForQuery({
      db,
      config,
      query: 'wer ist riley?',
      scope: 'shared',
    });
    const leaksMemoryMd = shared.results.some((row) => String(row.source_kind || '') === 'memory_md');
    assert.equal(leaksMemoryMd, false, 'shared recall must not pull private MEMORY.md chunks');

    const novara = recallForQuery({
      db,
      config,
      query: 'wer ist novara?',
      scope: 'shared',
    });
    assert.equal(novara.results.length >= 1, true, 'entity query should return synthetic Novara memories');
    const topNovara = String(novara.results[0]?.content || '').toLowerCase();
    assert.equal(topNovara.startsWith('add to profile'), false, 'entity query should prefer direct facts over instruction-like text');
    assert.equal(topNovara.includes('novara is jordan partner'), true, 'top entity memory should still carry direct relationship fact');
    const inj = String(novara.injection || '').toLowerCase();
    assert.equal(inj.includes('entity_answer_hints:'), true, 'entity injection should expose high-priority answer hints');
    const hintsSection = inj.split('entity_answer_hints:')[1]?.split('\nmemories:')[0] || '';
    assert.equal(hintsSection.includes('novara is jordan partner and birthday nov 6.'), true, 'entity hints should include direct fact');
    assert.equal(hintsSection.includes('add to profile: novara is jordan partner and birthday nov 6.'), false, 'entity hints should exclude instruction-like text');
  } finally {
    db.close();
  }
};

export { run };
