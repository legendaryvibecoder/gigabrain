import assert from 'node:assert/strict';

import { openDb, makeTempWorkspace } from './helpers.js';
import { ensureProjectionStore, upsertCurrentMemory, listCurrentMemories } from '../lib/core/projection-store.js';
import { ensureHostMemoryStore, linkMemorySource } from '../lib/core/host-memory-sync.js';
import { ensureEventStore, listTimeline } from '../lib/core/event-store.js';
import {
  exportPassportBundle,
  importPassportBundle,
  computeContentHash,
  validateBundleShape,
  BUNDLE_KIND,
  SCHEMA_VERSION,
} from '../lib/core/passport-bundle.js';

const seed = (db) => {
  ensureProjectionStore(db);
  ensureHostMemoryStore(db);
  ensureEventStore(db);
  upsertCurrentMemory(db, {
    memory_id: 'm-1',
    type: 'USER_FACT',
    content: 'User prefers tabs over spaces.',
    scope: 'profile:user',
    confidence: 0.74,
    source_host: 'codex',
    source_kind: 'native_memory',
    content_time: '2026-01-01T00:00:00.000Z',
    valid_until: '2027-01-01T00:00:00.000Z',
    tags: ['preference', 'editor'],
  });
  upsertCurrentMemory(db, {
    memory_id: 'm-2',
    type: 'DECISION',
    content: 'Project Apollo ships v2 in Q3.',
    scope: 'project:apollo',
    confidence: 0.8,
    source_host: 'claude_code',
    source_kind: 'instruction',
    status: 'active',
  });
  // A superseded row, to prove all statuses round-trip (not just active).
  upsertCurrentMemory(db, {
    memory_id: 'm-3',
    type: 'USER_FACT',
    content: 'User lived in Berlin.',
    scope: 'profile:user',
    confidence: 0.5,
    status: 'superseded',
    source_host: 'codex',
    source_kind: 'native_memory',
  });
  linkMemorySource(db, {
    memory_id: 'm-1',
    source_host: 'codex',
    source_kind: 'native_memory',
    source_path: '/home/u/.codex/memories/prefs.md',
    source_line: 3,
    sync_policy: 'read_only',
    content_hash: 'abc123',
  });
};

const run = async () => {
  const tmpA = makeTempWorkspace('gb-passport-bundle-src-');
  const tmpB = makeTempWorkspace('gb-passport-bundle-dst-');
  const src = openDb(tmpA.dbPath);
  const dst = openDb(tmpB.dbPath);
  try {
    seed(src);

    // --- Export shape + manifest ---
    const bundle = exportPassportBundle({ db: src, includeEvents: true, generatedAt: '2026-05-29T00:00:00.000Z' });
    assert.equal(bundle.kind, BUNDLE_KIND, 'bundle carries a stable kind');
    assert.equal(bundle.schema_version, SCHEMA_VERSION, 'bundle carries schema_version');
    assert.equal(bundle.manifest.memory_count, 3, 'all 3 memories (incl superseded) are carried');
    assert.equal(bundle.manifest.embeddings_included, false, 'embeddings are not carried (re-embed contract)');
    assert.equal(bundle.manifest.embedding_contract, 're-embed-on-import');
    assert.equal(bundle.manifest.world_model_included, false, 'derived world model is not carried');
    assert.ok(bundle.manifest.content_hash && bundle.manifest.content_hash.length === 64, 'content hash is a sha256');
    assert.equal(bundle.manifest.source_link_count, 1, 'provenance links are carried');
    assert.ok(bundle.manifest.event_count >= 0, 'event count present');

    // bi-temporal fidelity preserved on the wire
    const m1 = bundle.memories.find((m) => m.memory_id === 'm-1');
    assert.equal(m1.content_time, '2026-01-01T00:00:00.000Z', 'content_time preserved');
    assert.equal(m1.valid_until, '2027-01-01T00:00:00.000Z', 'valid_until preserved');
    assert.deepEqual(m1.tags, ['preference', 'editor'], 'tags preserved as array');

    // --- Round-trip into a fresh, empty DB ---
    const before = listCurrentMemories(dst, { limit: 100 });
    assert.equal(before.length, 0, 'destination starts empty');

    const result = importPassportBundle({ db: dst, bundle, runId: 'test-run' });
    assert.equal(result.ok, true);
    assert.equal(result.integrity_ok, true, 'integrity verified on import');
    assert.equal(result.imported_memories, 3, 'all memories imported');
    assert.equal(result.imported_source_links, 1, 'provenance re-linked');
    assert.equal(result.world_model_rebuild_required, true, 'import flags world-model rebuild');

    const after = listCurrentMemories(dst, { limit: 100 });
    assert.equal(after.length, 3, 'destination has all memories after import');
    const dstM1 = after.find((m) => m.memory_id === 'm-1');
    assert.equal(dstM1.content, 'User prefers tabs over spaces.', 'content survived round trip');
    assert.equal(dstM1.scope, 'profile:user', 'scope survived');
    assert.equal(Number(dstM1.confidence), 0.74, 'confidence survived');
    assert.equal(dstM1.content_time, '2026-01-01T00:00:00.000Z', 'bi-temporal content_time survived round trip');
    assert.equal(dstM1.valid_until, '2027-01-01T00:00:00.000Z', 'bi-temporal valid_until survived round trip');

    // re-export from destination → identical content hash (true round trip)
    const reexport = exportPassportBundle({ db: dst, generatedAt: '2026-05-29T00:00:00.000Z' });
    assert.equal(
      reexport.manifest.content_hash,
      bundle.manifest.content_hash,
      'round-trip is lossless: re-exported content hash matches the original',
    );

    // import provenance event was stamped
    const timeline = listTimeline(dst, 'm-1', { limit: 50 });
    assert.ok(timeline.some((e) => e.action === 'import' && e.component === 'passport_import'), 'import event recorded');

    // --- Tamper detection ---
    const tampered = JSON.parse(JSON.stringify(bundle));
    tampered.memories[0].content = 'User prefers SPACES (injected).';
    const tmpC = makeTempWorkspace('gb-passport-bundle-tamper-');
    const dst2 = openDb(tmpC.dbPath);
    try {
      assert.throws(
        () => importPassportBundle({ db: dst2, bundle: tampered }),
        /integrity check failed/,
        'tampered bundle is rejected by the integrity check',
      );
      assert.equal(listCurrentMemories(dst2, { limit: 100 }).length, 0, 'nothing written when integrity fails');

      // explicit override still allows import (e.g. intentional edit), and reports it
      const forced = importPassportBundle({ db: dst2, bundle: tampered, skipIntegrityCheck: true });
      assert.equal(forced.integrity_ok, false, 'override surfaces that integrity did not match');
      assert.equal(forced.integrity_skipped, true, 'override is recorded');
      assert.equal(listCurrentMemories(dst2, { limit: 100 }).length, 3, 'override imports anyway');
    } finally {
      dst2.close();
    }

    // --- Shape validation ---
    assert.throws(() => validateBundleShape({ kind: 'nope' }), /unsupported bundle kind/);
    assert.throws(() => validateBundleShape({ kind: BUNDLE_KIND, schema_version: '9.0', memories: [], manifest: {} }), /schema_version/);
    assert.doesNotThrow(() => validateBundleShape(bundle));

    // computeContentHash is order-independent
    const reordered = [...bundle.memories].reverse();
    assert.equal(computeContentHash(reordered), computeContentHash(bundle.memories), 'hash is independent of memory order');

    console.log('passport-bundle: all assertions passed');
  } finally {
    src.close();
    dst.close();
  }
};

export { run };
