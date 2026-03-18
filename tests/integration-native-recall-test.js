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
  fs.writeFileSync(path.join(memoryDir, '2026-02-01.md'), `
# 2026-02-01

## 09:00 UTC

### CONTEXT
- Today Jordan planned an intro interview with Tria.
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
    db.prepare(`
      INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash, source, confidence, scope, status, value_score, value_label, created_at, updated_at
      ) VALUES (
        ?, 'USER_FACT', ?, ?, ?, 'capture', 0.93, 'shared', 'active', 0.71, 'core', datetime('now'), datetime('now')
      )
    `).run(
      'm-novara-near-dupe',
      'Novara is Jordan\'s partner, birthday November 6.',
      'novara is jordans partner birthday november 6',
      'h-novara-near-dupe',
    );
    db.prepare(`
      INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash, source, confidence, scope, status, value_score, value_label, created_at, updated_at
      ) VALUES (
        ?, 'USER_FACT', ?, ?, ?, 'capture', 0.84, 'shared', 'active', 0.95, 'core', datetime('now'), datetime('now')
      )
    `).run(
      'm-novara-junk-wrapper',
      'System: Novara is Jordan partner and birthday Nov 6.',
      'system novara is jordan partner and birthday nov 6',
      'h-novara-junk-wrapper',
    );
    db.prepare(`
      INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash, source, confidence, scope, status, value_score, value_label, created_at, updated_at
      ) VALUES (
        ?, 'DECISION', ?, ?, ?, 'capture', 0.98, 'main', 'active', 0.99, 'core', datetime('now'), datetime('now')
      )
    `).run(
      'm-feb-timeline-high',
      'In February 2026, Jordan finalized the owl avatar rollout.',
      'in february 2026 jordan finalized the owl avatar rollout',
      'h-feb-timeline-high',
    );
    db.prepare(`
      INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash, source, confidence, scope, status, value_score, value_label, created_at, updated_at
      ) VALUES (
        ?, 'DECISION', ?, ?, ?, 'capture', 0.9, 'main', 'active', 0.72, 'core', datetime('now'), datetime('now')
      )
    `).run(
      'm-march-timeline',
      'In March 2026, Jordan completed the vault sync stabilization.',
      'in march 2026 jordan completed the vault sync stabilization',
      'h-march-timeline',
    );
    db.prepare(`
      INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash, source, confidence, scope, status, value_score, value_label, created_at, updated_at
      ) VALUES (
        ?, 'AGENT_IDENTITY', ?, ?, ?, 'capture', 0.94, 'main', 'active', 0.84, 'core', datetime('now'), datetime('now')
      )
    `).run(
      'm-atlas-identity',
      'Atlas is the coding agent for this workspace.',
      'atlas is the coding agent for this workspace',
      'h-atlas-identity',
    );
    db.prepare(`
      INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash, source, confidence, scope, status, value_score, value_label, created_at, updated_at
      ) VALUES (
        ?, 'PREFERENCE', ?, ?, ?, 'capture', 0.91, 'main', 'active', 0.8, 'core', datetime('now'), datetime('now')
      )
    `).run(
      'm-season-pref',
      'Jordan prefers winter and associates it with calm focus.',
      'jordan prefers winter and associates it with calm focus',
      'h-season-pref',
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
    assert.equal(inj.includes('system: novara is jordan partner and birthday nov 6.'), false, 'entity hints should exclude junk wrapper phrasing');
    assert.equal(inj.includes('src='), false, 'entity injection should not expose internal source provenance');
    const novaraRows = novara.results.map((row) => String(row.content || '').toLowerCase());
    assert.equal(novaraRows.filter((row) => row.includes('novara is jordan partner') || row.includes("novara is jordan's partner")).length, 1, 'near-duplicate entity rows should collapse at recall time');

    const noisyQuery = recallForQuery({
      db,
      config,
      query: [
        'System: [2026-03-11 20:15:53 CDT] Exec completed (faint-ti, code 0) :: ok',
        '',
        'Conversation info (untrusted metadata):',
        '```json',
        '{',
        '  "message_id": "467",',
        '  "sender_id": "8399667792",',
        '  "sender": "PRINT"',
        '}',
        '```',
        '',
        'Sender (untrusted metadata):',
        '```json',
        '{',
        '  "label": "PRINT (8399667792)"',
        '}',
        '```',
        '',
        'who is novara?',
      ].join('\n'),
      scope: 'shared',
    });
    assert.equal(String(noisyQuery.query || ''), 'who is novara?', 'query sanitation should strip exec and metadata wrappers before recall');
    assert.equal(String(noisyQuery.results[0]?.content || '').toLowerCase().includes('novara is jordan partner'), true, 'sanitized query should still resolve the intended entity');

    const selfIdentity = recallForQuery({
      db,
      config,
      query: 'what do you know about yourself atlas',
      scope: 'main',
    });
    assert.equal(selfIdentity.results.length >= 1, true, 'self-identity recall should return at least one result');
    assert.equal(String(selfIdentity.results[0]?.type || ''), 'AGENT_IDENTITY', 'self-identity recall should prioritize AGENT_IDENTITY rows');
    assert.equal(String(selfIdentity.results[0]?.content || '').toLowerCase().includes('atlas is the coding agent'), true, 'self-identity recall should surface the direct identity fact');

    const shortPreference = recallForQuery({
      db,
      config,
      query: 'welche jahreszeit magst du',
      scope: 'main',
    });
    assert.equal(shortPreference.results.length >= 1, true, 'short preference recall should return at least one result');
    assert.equal(String(shortPreference.results[0]?.type || ''), 'PREFERENCE', 'short preference recall should prioritize preference rows');
    assert.equal(String(shortPreference.results[0]?.content || '').toLowerCase().includes('winter'), true, 'short preference recall should surface the season preference');

    const tria = recallForQuery({
      db,
      config,
      query: 'what do we know about tria?',
      scope: 'main',
    });
    const triaInjection = String(tria.injection || '');
    assert.equal(triaInjection.includes('src='), false, 'recall injection should not expose source paths');
    assert.equal(triaInjection.includes('Recorded on 2026-02-01; any relative dates in this memory refer to that date.'), true, 'stale relative memories should be marked with their recorded date');

    const march = recallForQuery({
      db,
      config,
      query: 'What happened in March 2026?',
      scope: 'main',
    });
    assert.equal(march.results.length >= 1, true, 'month-specific temporal query should return at least one result');
    assert.equal(String(march.results[0]?.content || '').includes('March 2026'), true, 'month-specific temporal query should prioritize matching month rows');
    assert.equal(march.results.some((row) => String(row.content || '').includes('February 2026')), false, 'month-specific temporal query should filter out rows outside the requested month when temporal matches exist');
  } finally {
    db.close();
  }

  const freshWs = makeTempWorkspace('gb-v3-int-native-recall-bootstrap-');
  const freshConfig = normalizeConfig(makeConfigObject(freshWs.workspace).plugins.entries.gigabrain.config);
  const freshDb = openDb(freshWs.dbPath);
  try {
    const freshRecall = recallForQuery({
      db: freshDb,
      config: freshConfig,
      query: 'What should I focus on today?',
      scope: 'shared',
    });
    assert.equal(freshRecall.results.length, 0, 'fresh recall fixture should have zero recalled rows');
    const freshInjection = String(freshRecall.injection || '');
    assert.equal(freshInjection.includes('<gigabrain-context>'), true, 'fresh recall should still include a Gigabrain context block');
    assert.equal(freshInjection.includes('bootstrap_mode: true'), true, 'fresh recall should mark bootstrap mode when no memories are available');
    assert.equal(freshInjection.includes('capture_instruction:'), true, 'fresh recall should still include capture instructions');
    assert.equal(freshInjection.includes('No recalled memories matched this query yet.'), true, 'fresh recall should state that no prior memories were found');
  } finally {
    freshDb.close();
  }
};

export { run };
