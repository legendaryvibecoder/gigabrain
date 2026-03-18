import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { ensureNativeStore } from '../lib/core/native-sync.js';
import { buildEntityMentionScopeFilter, containsEntity, ensurePersonStore, rebuildEntityMentions, resolveEntityKeysForQuery, scorePersonContent } from '../lib/core/person-service.js';
import { openDb, makeTempWorkspace, seedMemoryCurrent } from './helpers.js';

const run = async () => {
  assert.equal(containsEntity('realizes quickly', 'riley', true), false, 'word-boundary mode must block false positives');
  assert.equal(containsEntity('Riley is here', 'riley', true), true, 'exact person token should match');

  const rel = scorePersonContent({
    content: 'Jordan and Riley live together in a relationship.',
    entityKeys: ['riley'],
    config: { person: { relationshipPriorityBoost: 0.35, publicProfileBoost: 0.1, keepPublicFacts: true, requireWordBoundaryMatch: true } },
  });
  const pub = scorePersonContent({
    content: 'Riley gave a conference talk in Berlin.',
    entityKeys: ['riley'],
    config: { person: { relationshipPriorityBoost: 0.35, publicProfileBoost: 0.1, keepPublicFacts: true, requireWordBoundaryMatch: true } },
  });
  assert.equal(Number(rel?.score || 0) > Number(pub?.score || 0), true, 'relationship facts should outrank public profile facts');

  const ws = makeTempWorkspace('gb-v3-unit-person-');
  const db = openDb(ws.dbPath);
  try {
    ensurePersonStore(db);
    ensureNativeStore(db);
    seedMemoryCurrent(db, [
      { memory_id: 'p1', type: 'USER_FACT', content: 'Jordan and Riley live together', scope: 'shared', confidence: 0.7 },
      { memory_id: 'p2', type: 'USER_FACT', content: 'Riley gave conference talks about relationships', scope: 'shared', confidence: 0.7 },
      { memory_id: 'p-alpha', type: 'USER_FACT', content: 'Mira coordinates the alpha launch.', scope: 'project:alpha', confidence: 0.76 },
      { memory_id: 'p-beta', type: 'USER_FACT', content: 'Soren coordinates the beta launch.', scope: 'project:beta', confidence: 0.76 },
      { memory_id: 'p4', type: 'CONTEXT', content: 'Archive Contact Content Date are section labels, not people.', scope: 'shared', confidence: 0.8 },
    ]);
    db.prepare(`
      INSERT INTO memory_native_chunks (
        chunk_id, source_path, source_kind, source_date, section, line_start, line_end,
        content, normalized, hash, linked_memory_id, first_seen_at, last_seen_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'n1',
      '/tmp/memory/2026-02-21.md',
      'daily_note',
      '2026-02-21',
      'USER_FACT',
      12,
      12,
      'Riley is active in the writing community in Berlin.',
      'riley is active in the writing community in berlin',
      'h1',
      null,
      new Date().toISOString(),
      new Date().toISOString(),
      'active',
    );
    seedMemoryCurrent(db, [
      {
        memory_id: 'p3',
        type: 'CONTEXT',
        content: 'Chrome mit remote debugging starten, Email eintippen, Verify code klicken und Cookies extrahieren in Wien.',
        scope: 'shared',
        confidence: 0.8,
      },
    ]);
    rebuildEntityMentions(db);
    const count = db.prepare(`
      SELECT COUNT(*) AS c
      FROM memory_entity_mentions
      WHERE entity_key = 'riley'
    `).get()?.c || 0;
    assert.equal(Number(count) >= 3, true, 'entity mention rebuild should index active + native person mentions');

    const keys = resolveEntityKeysForQuery(db, 'wer ist riley?');
    assert.equal(keys.includes('riley'), true, 'query resolver should detect person key');
    assert.equal(resolveEntityKeysForQuery(db, 'wer ist partnerin?').includes('partnerin'), false, 'query resolver should reject generic relationship nouns as entities');
    const alphaFilter = buildEntityMentionScopeFilter('project:alpha');
    const alphaKeys = db.prepare(`
      SELECT DISTINCT entity_key
      FROM memory_entity_mentions
      WHERE ${alphaFilter.sql}
      ORDER BY entity_key ASC
    `).all(...alphaFilter.params).map((row) => String(row.entity_key || ''));
    assert.equal(alphaKeys.includes('mira'), true, 'project scope filters should retain same-scope entity mentions');
    assert.equal(alphaKeys.includes('soren'), false, 'project scope filters should not leak foreign project entity mentions');
    const sharedFilter = buildEntityMentionScopeFilter('shared');
    const sharedKeys = db.prepare(`
      SELECT DISTINCT entity_key
      FROM memory_entity_mentions
      WHERE ${sharedFilter.sql}
      ORDER BY entity_key ASC
    `).all(...sharedFilter.params).map((row) => String(row.entity_key || ''));
    assert.equal(sharedKeys.includes('riley'), true, 'shared scope filters should retain shared entity mentions');
    assert.equal(sharedKeys.includes('mira'), false, 'shared scope filters should not see project-local entity mentions');
    const noisyMentions = db.prepare(`
      SELECT COUNT(*) AS c
      FROM memory_entity_mentions
      WHERE entity_key IN ('partnerin', 'beziehung', 'add', 'are')
    `).get()?.c || 0;
    assert.equal(Number(noisyMentions), 0, 'entity mention rebuild should ignore junk alias tokens');
    const operationalNoiseMentions = db.prepare(`
      SELECT COUNT(*) AS c
      FROM memory_entity_mentions
      WHERE entity_key IN ('email', 'chrome', 'cookies', 'verify', 'wien', 'vienna', 'brigittaplatz', 'archive', 'contact', 'content', 'date')
    `).get()?.c || 0;
    assert.equal(Number(operationalNoiseMentions), 0, 'entity mention rebuild should ignore operational and address-like tokens');
  } finally {
    db.close();
  }

  const freshWs = makeTempWorkspace('gb-v3-unit-person-fresh-');
  const freshDb = new DatabaseSync(freshWs.dbPath);
  try {
    assert.doesNotThrow(() => rebuildEntityMentions(freshDb), 'entity mention rebuild should bootstrap missing projection/native tables on fresh DBs');
  } finally {
    freshDb.close();
  }

  const legacyWs = makeTempWorkspace('gb-v3-unit-person-legacy-');
  const legacyDb = new DatabaseSync(legacyWs.dbPath);
  try {
    legacyDb.exec(`
      CREATE TABLE memory_entity_mentions (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        entity_key TEXT NOT NULL,
        entity_display TEXT NOT NULL,
        role TEXT NOT NULL,
        confidence REAL NOT NULL,
        source TEXT NOT NULL
      )
    `);
    assert.doesNotThrow(
      () => ensurePersonStore(legacyDb),
      'person store bootstrap should upgrade legacy mention tables before adding scope indexes',
    );
    const columns = legacyDb.prepare('PRAGMA table_info(memory_entity_mentions)').all().map((row) => String(row.name || ''));
    assert.equal(columns.includes('scope'), true, 'legacy mention table upgrade should add the scope column');
  } finally {
    legacyDb.close();
  }
};

export { run };
