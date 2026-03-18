import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeConfig } from '../lib/core/config.js';
import { ensureNativeStore, queryNativeChunks, syncNativeMemory } from '../lib/core/native-sync.js';
import { makeConfigObject, makeTempWorkspace, openDb } from './helpers.js';

const run = async () => {
  const ws = makeTempWorkspace('gb-v3-unit-native-query-');
  const config = normalizeConfig(makeConfigObject(ws.workspace).plugins.entries.gigabrain.config);
  const db = openDb(ws.dbPath);
  try {
    const legacyDbPath = path.join(ws.workspace, 'legacy-native.sqlite');
    const legacyDb = openDb(legacyDbPath);
    try {
      legacyDb.exec(`
        CREATE TABLE memory_native_chunks (
          chunk_id TEXT PRIMARY KEY,
          source_path TEXT NOT NULL,
          source_kind TEXT NOT NULL,
          source_date TEXT,
          section TEXT,
          line_start INTEGER,
          line_end INTEGER,
          content TEXT NOT NULL,
          normalized TEXT NOT NULL,
          hash TEXT NOT NULL,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active'
        );
      `);
      ensureNativeStore(legacyDb);
      const legacyColumns = legacyDb.prepare('PRAGMA table_info(memory_native_chunks)').all().map((row) => String(row.name || ''));
      assert.equal(legacyColumns.includes('scope'), true, 'native store bootstrap should upgrade legacy chunk tables before adding scope indexes');
      assert.equal(legacyColumns.includes('linked_memory_id'), true, 'native store bootstrap should add linked_memory_id for legacy chunk tables');
      const scopeIndex = legacyDb.prepare("PRAGMA index_list('memory_native_chunks')").all().find((row) => String(row.name || '') === 'idx_memory_native_chunks_scope');
      assert.equal(Boolean(scopeIndex), true, 'native store bootstrap should recreate the scope index after upgrading the schema');
    } finally {
      legacyDb.close();
    }

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

    insert.run(
      'artifact-source-hit',
      '/tmp/memory/2026-03-03-session-start.md',
      'daily_note',
      '2026-03-03',
      'Conversation Summary',
      1004,
      1004,
      'Source: memory/whois.md#L1-L8, memory/gigabrain-harmonized.md#L208-L218',
      'source memory whois md l1 l8 memory gigabrain harmonized md l208 l218',
      randomUUID(),
      null,
      nowIso,
      nowIso,
      'active',
    );

    insert.run(
      'artifact-context-hit',
      '/tmp/memory/2026-03-03-session-start.md',
      'daily_note',
      '2026-03-03',
      'Conversation Summary',
      1005,
      1005,
      'query: wer ist liz?',
      'query wer ist liz',
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

    const artifactRows = queryNativeChunks({
      db,
      config,
      query: 'liz',
      scope: 'main',
      limit: 24,
      entityKeys: ['liz'],
    });
    const hasArtifact = artifactRows.some((row) => /source:|query:/i.test(String(row.content || '')));
    assert.equal(hasArtifact, false, 'native recall should filter persisted recall/transcript artifacts');

    fs.mkdirSync(path.join(ws.workspace, 'memory'), { recursive: true });
    fs.writeFileSync(path.join(ws.workspace, 'memory', '2026-03-08-session-start.md'), `
# 2026-03-08 session start

## Conversation Summary

<gigabrain-context>
query: wer ist liz?
fallback: active_or_native
- [USER_FACT] Liz is Alex partner.
</gigabrain-context>

- user: Wer ist Liz?
- assistant: Liz ist Alex Partnerin.
- Durable fact about Liz and Alex.
`, 'utf8');

    const syncSummary = syncNativeMemory({ db, config, dryRun: false });
    assert.equal(syncSummary.changed_files >= 1, true, 'native sync should process new session file');

    const syncedRows = db.prepare(`
      SELECT content
      FROM memory_native_chunks
      WHERE source_path = ?
      ORDER BY line_start ASC
    `).all(path.join(ws.workspace, 'memory', '2026-03-08-session-start.md'));
    const syncedContents = syncedRows.map((row) => String(row.content || ''));
    assert.equal(syncedContents.some((content) => /query:|fallback:|user:|assistant:/i.test(content)), false, 'native sync should not index recall or transcript control lines');
    assert.equal(syncedContents.some((content) => content.includes('Durable fact about Liz and Alex.')), true, 'native sync should keep human-readable durable notes from the same file');
  } finally {
    db.close();
  }
};

export { run };
