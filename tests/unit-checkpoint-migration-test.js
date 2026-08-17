import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  migrateLegacyCheckpoints,
  parseLegacyCheckpointMarkdown,
} from '../lib/core/checkpoint-migration.js';
import {
  getCheckpointEpisode,
  listClaimProposals,
} from '../lib/core/control-plane.js';
import { openDb } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const run = async () => {
  const markdown = `# 2026-08-10

## Codex App Sessions

- Codex App session (migration fixture): Implemented a typed checkpoint ledger. <!-- gigabrain:scope=project:alpha -->

## Decisions

- Decision: Keep imported checkpoint text explicitly untyped. <!-- gigabrain:scope=project:alpha -->

## Open Loops

- Open loop: Verify the remote connector. <!-- gigabrain:scope=project:alpha -->

## Touched Files

- Touched file: lib/core/control-plane.js <!-- gigabrain:scope=project:alpha -->

## Durable Candidates

- The connector design is production-ready. <!-- gigabrain:scope=project:alpha -->
`;
  const parsed = parseLegacyCheckpointMarkdown(markdown, { defaultScope: 'project:fallback' });
  assert.equal(parsed.length, 1, 'one scoped legacy daily note should become one coarse episode');
  assert.equal(parsed[0].scope, 'project:alpha', 'scope comments should survive migration');
  assert.deepEqual(parsed[0].decisions, ['Keep imported checkpoint text explicitly untyped.']);
  assert.deepEqual(parsed[0].durable_candidates, ['The connector design is production-ready.']);

  const ordinaryNote = `# 2026-08-09\n\n## Decisions\n\n- This is an ordinary memory, not a checkpoint.\n`;
  assert.deepEqual(
    parseLegacyCheckpointMarkdown(ordinaryNote, { defaultScope: 'project:alpha' }),
    [],
    'ordinary daily-note sections must not be mistaken for checkpoints without a session marker',
  );

  const scratchBase = path.join(REPO_ROOT, '.tmp');
  fs.mkdirSync(scratchBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratchBase, 'checkpoint-migration-'));
  const memoryRoot = path.join(root, 'memory');
  fs.mkdirSync(memoryRoot, { recursive: true });
  fs.writeFileSync(path.join(memoryRoot, '2026-08-10.md'), markdown, 'utf8');
  fs.writeFileSync(path.join(memoryRoot, '2026-08-09.md'), ordinaryNote, 'utf8');
  fs.writeFileSync(path.join(memoryRoot, '2026-08-16.md'), markdown.replaceAll('2026-08-10', '2026-08-16'), 'utf8');

  const db = openDb(':memory:');
  try {
    const dryRun = migrateLegacyCheckpoints(db, {
      memoryRoot,
      defaultScope: 'project:fallback',
      dryRun: true,
      today: '2026-08-16',
    });
    assert.equal(dryRun.would_import, 1, 'dry run should identify one historical episode');
    assert.equal(dryRun.imported, 0, 'dry run must not write episodes');
    assert.equal(dryRun.skipped_current_day, 1, 'active daily notes should be skipped by default');
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='memory_checkpoints'").get().n,
      0,
      'dry run must not create control-plane tables',
    );

    const migrated = migrateLegacyCheckpoints(db, {
      memoryRoot,
      defaultScope: 'project:fallback',
      today: '2026-08-16',
    });
    assert.equal(migrated.imported, 1, 'real migration should import one episode');
    assert.equal(migrated.proposals_created, 0, 'migration should report zero promoted proposals');
    const checkpointId = migrated.episodes.find((entry) => entry.status === 'imported').checkpoint_id;
    const checkpoint = getCheckpointEpisode(db, checkpointId, { allowedScopes: ['project:alpha'] });
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const checkpointSchema = JSON.parse(fs.readFileSync(
      path.join(REPO_ROOT, 'docs', 'schemas', 'checkpoint.1.schema.json'),
      'utf8',
    ));
    const validateCheckpoint = ajv.compile(checkpointSchema);
    assert.equal(
      validateCheckpoint(checkpoint),
      true,
      `legacy checkpoint ids must satisfy the published schema: ${JSON.stringify(validateCheckpoint.errors)}`,
    );
    assert.equal(checkpoint.legacy_untyped, true, 'coarse legacy grouping must be labeled untyped');
    assert.equal(checkpoint.outcome_status, 'legacy_imported');
    assert.equal(checkpoint.repo.root, '', 'migration must not invent historical repository state');
    assert.equal(checkpoint.durable_candidates[0].content, 'The connector design is production-ready.');
    assert.deepEqual(checkpoint.proposal_ids, [], 'legacy durable candidates must never be auto-promoted to proposals');
    assert.deepEqual(listClaimProposals(db), [], 'migration must leave the proposal ledger empty');

    const repeated = migrateLegacyCheckpoints(db, {
      memoryRoot,
      defaultScope: 'project:fallback',
      today: '2026-08-16',
    });
    assert.equal(repeated.imported, 0, 'migration must be idempotent');
    assert.equal(repeated.already_imported, 1, 'idempotent reruns should report the prior import');

    fs.writeFileSync(
      path.join(memoryRoot, '2026-08-10.md'),
      markdown.replaceAll('project:alpha', 'project:beta'),
      'utf8',
    );
    const rescoped = migrateLegacyCheckpoints(db, {
      memoryRoot,
      defaultScope: 'project:fallback',
      today: '2026-08-16',
    });
    assert.equal(rescoped.imported, 0, 'correcting a legacy scope must not create a duplicate episode');
    assert.equal(rescoped.already_imported, 1, 'the source episode identity must survive a scope correction');
    assert.equal(rescoped.drifted_after_import, 1, 'a corrected legacy scope must be reported as immutable-source drift');
    assert.equal(
      getCheckpointEpisode(db, checkpointId, { allowedScopes: ['project:alpha'] }).scope,
      'project:alpha',
      'scope correction must not mutate the immutable imported episode',
    );

    fs.writeFileSync(path.join(memoryRoot, '2026-08-10.md'), markdown, 'utf8');

    fs.appendFileSync(
      path.join(memoryRoot, '2026-08-10.md'),
      '\n## Open Loops\n\n- Open loop: Added after the immutable import. <!-- gigabrain:scope=project:alpha -->\n',
      'utf8',
    );
    const drifted = migrateLegacyCheckpoints(db, {
      memoryRoot,
      defaultScope: 'project:fallback',
      today: '2026-08-16',
    });
    assert.equal(drifted.drifted_after_import, 1, 'source drift should be reported without mutating the imported episode');
    assert.equal(
      getCheckpointEpisode(db, checkpointId, { allowedScopes: ['project:alpha'] }).open_loops.length,
      1,
      'immutable imported episodes must not change when their legacy source later drifts',
    );
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
};

export { run };
