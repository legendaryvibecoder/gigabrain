import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { normalizeConfig } from '../lib/core/config.js';
import { ensureNativeStore, queryNativeChunks } from '../lib/core/native-sync.js';
import { makeConfigObject, makeTempWorkspace, openDb } from './helpers.js';

const run = async () => {
  const ws = makeTempWorkspace('gb-v3-unit-native-query-');
  const config = normalizeConfig(makeConfigObject(ws.workspace).plugins.entries.gigabrain.config);
  const db = openDb(ws.dbPath);
  try {
    ensureNativeStore(db);
    const insert = db.prepare(`
      INSERT INTO memory_native_chunks (
        chunk_id, source_path, source_kind, source_date, section, line_start, line_end,
        content, normalized, hash, linked_memory_id, first_seen_at, last_seen_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const nowIso = new Date().toISOString();

    for (let index = 0; index < 900; index += 1) {
      insert.run(
        `noise-${index}`,
        '/tmp/memory/latest.md',
        'curated',
        '2026-02-24',
        'CONTEXT',
        index + 1,
        index + 1,
        `Fresh noise chunk ${index}`,
        `fresh noise chunk ${index}`,
        randomUUID(),
        null,
        nowIso,
        nowIso,
        'active',
      );
    }

    insert.run(
      'older-tria-hit',
      '/tmp/memory/latest.md',
      'curated',
      '2026-02-23',
      'ENTITY',
      1001,
      1001,
      'Tria is a neobank where Alex invested.',
      'tria is a neobank where alex invested',
      randomUUID(),
      null,
      nowIso,
      nowIso,
      'active',
    );

    insert.run(
      'noise-initialization',
      '/tmp/memory/latest.md',
      'curated',
      '2026-02-24',
      'CONTEXT',
      1002,
      1002,
      'Initialization checklist completed for gateway startup.',
      'initialization checklist completed for gateway startup',
      randomUUID(),
      null,
      nowIso,
      nowIso,
      'active',
    );

    insert.run(
      'sam-actual-hit',
      '/tmp/memory/latest.md',
      'curated',
      '2026-02-24',
      'ENTITY',
      1003,
      1003,
      'Sam is Alex partner.',
      'sam is alex partner',
      randomUUID(),
      null,
      nowIso,
      nowIso,
      'active',
    );

    const rows = queryNativeChunks({
      db,
      config,
      query: 'wer ist tria?',
      scope: 'default',
      limit: 24,
      entityKeys: ['tria'],
    });
    const hasTria = rows.some((row) => String(row.content || '').toLowerCase().includes('tria'));
    assert.equal(hasTria, true, 'native query must keep entity matches even when many newer chunks exist');

    const samRows = queryNativeChunks({
      db,
      config,
      query: 'sam',
      scope: 'default',
      limit: 24,
      entityKeys: ['sam'],
    });
    const hasSam = samRows.some((row) => String(row.content || '').toLowerCase().includes('sam'));
    assert.equal(hasSam, true, 'native query should return real entity hits');
    const hasInitSubstring = samRows.some((row) => String(row.content || '').toLowerCase().includes('initialization'));
    assert.equal(hasInitSubstring, false, 'native entity match must not trigger on substrings inside other words');
  } finally {
    db.close();
  }
};

export { run };
