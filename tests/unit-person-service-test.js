import assert from 'node:assert/strict';

import { ensureNativeStore } from '../lib/core/native-sync.js';
import { containsEntity, ensurePersonStore, rebuildEntityMentions, resolveEntityKeysForQuery, scorePersonContent } from '../lib/core/person-service.js';
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
    rebuildEntityMentions(db);
    const count = db.prepare(`
      SELECT COUNT(*) AS c
      FROM memory_entity_mentions
      WHERE entity_key = 'riley'
    `).get()?.c || 0;
    assert.equal(Number(count) >= 3, true, 'entity mention rebuild should index active + native person mentions');

    const keys = resolveEntityKeysForQuery(db, 'wer ist riley?');
    assert.equal(keys.includes('riley'), true, 'query resolver should detect person key');
  } finally {
    db.close();
  }
};

export { run };
