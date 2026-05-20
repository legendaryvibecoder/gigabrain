import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

import { importOpenClawRegistry } from '../lib/core/openclaw-import.js';
import { makeTempWorkspace, openDb } from './helpers.js';

const createLegacyRegistry = (registryPath) => {
  const db = new DatabaseSync(registryPath);
  db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      normalized TEXT NOT NULL,
      source TEXT NOT NULL,
      source_agent TEXT,
      source_session TEXT,
      source_message_id TEXT,
      confidence REAL,
      status TEXT,
      scope TEXT,
      tags TEXT,
      created_at TEXT,
      updated_at TEXT,
      last_confirmed_at TEXT,
      ttl_days INTEGER,
      pinned INTEGER DEFAULT 0,
      superseded_by TEXT,
      concept TEXT,
      value_score REAL,
      value_label TEXT,
      review_version TEXT,
      review_reason TEXT,
      archived_at TEXT,
      last_reviewed_at TEXT
    );
    CREATE TABLE evidence (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      memory_id TEXT,
      text_snippet TEXT,
      created_at TEXT
    );
  `);
  const insert = db.prepare(`
    INSERT INTO memories (
      id, type, content, normalized, source, source_agent, source_session, confidence,
      status, scope, tags, created_at, updated_at, pinned, superseded_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    'legacy-1',
    'USER_FACT',
    'Nimbus remembers the Telegram chat id is 779443319.',
    'nimbus remembers the telegram chat id is 779443319',
    'capture',
    'nimbus',
    'session-a',
    0.91,
    'active',
    'profile:nimbus',
    '["telegram","nimbus"]',
    '2026-02-12T08:00:00.000Z',
    '2026-02-12T08:05:00.000Z',
    1,
    null,
  );
  insert.run(
    'legacy-2',
    'DECISION',
    'The old gateway must be stopped before reusing the Telegram bot token.',
    'the old gateway must be stopped before reusing the telegram bot token',
    'capture',
    'nimbus',
    'session-b',
    0.82,
    'active',
    'shared',
    '[]',
    '2026-02-12T09:00:00.000Z',
    '2026-02-12T09:05:00.000Z',
    0,
    null,
  );
  insert.run(
    'legacy-3',
    'CONTEXT',
    'A rejected transient note should keep its rejected status.',
    'a rejected transient note should keep its rejected status',
    'capture',
    'nimbus',
    'session-c',
    0.4,
    'rejected',
    'shared',
    '[]',
    '2026-02-12T10:00:00.000Z',
    '2026-02-12T10:05:00.000Z',
    0,
    null,
  );
  db.prepare('INSERT INTO evidence (memory_id, text_snippet, created_at) VALUES (?, ?, ?)').run(
    'legacy-1',
    'Observed in the Nimbus Telegram setup note.',
    '2026-02-12T08:06:00.000Z',
  );
  db.close();
};

const run = async () => {
  const temp = makeTempWorkspace('gb-openclaw-import-');
  const targetDb = openDb(temp.dbPath);
  const legacyRegistry = path.join(temp.root, 'legacy-registry.sqlite');
  createLegacyRegistry(legacyRegistry);
  try {
    const dryRun = importOpenClawRegistry({
      db: targetDb,
      registryPath: legacyRegistry,
      sourceHost: 'openclaw',
      sourceLabel: 'unit-fixture',
      dryRun: true,
    });
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.dry_run, true);
    assert.equal(dryRun.source_count, 3);
    assert.equal(dryRun.evidence_count, 1);
    assert.deepEqual(dryRun.status_counts, { active: 2, rejected: 1 });
    assert.equal(targetDb.prepare('SELECT COUNT(*) AS c FROM memory_current').get().c, 0, 'dry-run should not mutate target');

    const applied = importOpenClawRegistry({
      db: targetDb,
      registryPath: legacyRegistry,
      memoryRoot: path.dirname(legacyRegistry),
      sourceHost: 'openclaw',
      sourceLabel: 'unit-fixture',
    });
    assert.equal(applied.ok, true);
    assert.equal(applied.imported_count, 3);
    assert.equal(applied.linked_count, 3);
    assert.equal(applied.evidence_imported_count, 1);

    const imported = targetDb.prepare(`
      SELECT memory_id, source_host, source_kind, sync_policy, status, scope, tags
      FROM memory_current
      WHERE memory_id = 'legacy-1'
    `).get();
    assert.equal(imported.source_host, 'openclaw');
    assert.equal(imported.source_kind, 'native_memory');
    assert.equal(imported.sync_policy, 'read_only');
    assert.equal(imported.status, 'active');
    assert.equal(imported.scope, 'profile:nimbus');
    assert.equal(String(imported.tags).includes('source_label:unit-fixture'), true);
    assert.equal(String(imported.tags).includes('pinned'), true);

    const rejected = targetDb.prepare("SELECT status FROM memory_current WHERE memory_id = 'legacy-3'").get();
    assert.equal(rejected.status, 'rejected', 'legacy status should be preserved');

    const links = targetDb.prepare('SELECT COUNT(*) AS c FROM memory_source_links WHERE source_host = ?').get('openclaw');
    assert.equal(Number(links.c), 3, 'import should retain source provenance links');
    const evidence = targetDb.prepare('SELECT COUNT(*) AS c FROM memory_import_evidence WHERE memory_id = ?').get('legacy-1');
    assert.equal(Number(evidence.c), 1, 'import should preserve legacy evidence snippets');

    const rerun = importOpenClawRegistry({
      db: targetDb,
      registryPath: legacyRegistry,
      sourceHost: 'openclaw',
      sourceLabel: 'unit-fixture',
    });
    assert.equal(rerun.imported_count, 0, 'rerun should be idempotent for already-imported ids');
    assert.equal(rerun.updated_count, 3, 'rerun should refresh existing imported ids');
  } finally {
    targetDb.close();
  }
};

export { run };
