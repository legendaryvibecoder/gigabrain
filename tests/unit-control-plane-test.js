import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import {
  appendCheckpointEpisode,
  appendClaimDecision,
  appendClaimProposal,
  appendMemoryReceipt,
  ensureControlPlaneStore,
  getCheckpointEpisode,
  getClaimProposal,
  getMemoryReceipt,
  listCheckpointEpisodes,
  listClaimProposals,
} from '../lib/core/control-plane.js';
import { openDb } from './helpers.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const loadSchema = (name) => JSON.parse(fs.readFileSync(
  path.resolve(HERE, '..', 'docs', 'schemas', name),
  'utf8',
));

const run = async () => {
  const db = openDb(':memory:');
  try {
    ensureControlPlaneStore(db);
    const first = appendCheckpointEpisode(db, {
      timestamp: '2026-08-16T10:00:00.000Z',
      sessionId: 'ses_fixture',
      scope: 'project:alpha',
      sourceAgent: 'codex',
      sourceClient: 'codex',
      sourceHost: 'fixture-host',
      repo: {
        root: '/private/repo',
        branch: 'main',
        commit: 'abc123',
        dirty: true,
      },
      summary: 'Implemented the checkpoint ledger.',
      decisions: ['Keep checkpoint episodes immutable.'],
      openLoops: ['Run the hosted connector conformance suite.'],
      touchedFiles: ['lib/core/control-plane.js'],
      durableCandidates: ['The connector uses Streamable HTTP.'],
      evidence: ['test:unit-control-plane'],
    });

    assert.match(first.checkpoint.checkpoint_id, /^cp_/, 'checkpoint should receive a stable id');
    assert.equal(first.checkpoint.session_id, 'ses_fixture', 'provided session lineage should be preserved');
    assert.equal(first.checkpoint.source.agent, 'codex', 'checkpoint source identity must be non-null');
    assert.equal(first.checkpoint.decisions.length, 1, 'checkpoint should retain typed items');
    assert.equal(first.checkpoint.proposal_ids.length, 1, 'durable candidates should become proposals');
    assert.match(first.receipt_id, /^rcpt_/, 'checkpoint write should create a receipt');

    const proposal = getClaimProposal(db, first.checkpoint.proposal_ids[0]);
    assert.equal(proposal.status, 'proposed', 'durable candidates must not be auto-promoted');
    assert.equal(proposal.evidence_class, 'agent_inference', 'untyped checkpoint candidates should remain defeasible');
    assert.equal(proposal.memory_id, null, 'a proposal should not point to committed memory before review');

    const second = appendCheckpointEpisode(db, {
      timestamp: '2026-08-16T11:00:00.000Z',
      sessionId: 'ses_fixture',
      parentCheckpointId: first.checkpoint.checkpoint_id,
      scope: 'project:alpha',
      sourceAgent: 'claude_code',
      sourceClient: 'claude',
      sourceHost: 'fixture-host',
      repo: { root: '/private/repo', branch: 'main', commit: 'def456', dirty: false },
      summary: 'Reviewed the checkpoint ledger.',
    });
    appendCheckpointEpisode(db, {
      timestamp: '2026-08-16T12:00:00.000Z',
      scope: 'project:beta',
      sourceAgent: 'hermes',
      sourceClient: 'hermes',
      sourceHost: 'fixture-host',
      summary: 'This checkpoint belongs to another project.',
    });

    const pageOne = listCheckpointEpisodes(db, {
      scope: 'project:alpha',
      allowedScopes: ['project:alpha'],
      limit: 1,
    });
    assert.equal(pageOne.results.length, 1, 'checkpoint list should paginate exactly');
    assert.equal(pageOne.results[0].checkpoint_id, second.checkpoint.checkpoint_id, 'checkpoint list should be newest-first');
    assert.equal(Boolean(pageOne.next_cursor), true, 'checkpoint list should return an opaque cursor');
    const pageTwo = listCheckpointEpisodes(db, {
      scope: 'project:alpha',
      allowedScopes: ['project:alpha'],
      limit: 1,
      cursor: pageOne.next_cursor,
    });
    assert.equal(pageTwo.results[0].checkpoint_id, first.checkpoint.checkpoint_id, 'checkpoint cursor should continue without overlap');

    assert.equal(
      getCheckpointEpisode(db, first.checkpoint.checkpoint_id, { allowedScopes: ['project:beta'] }),
      null,
      'direct checkpoint reads must not bypass scope authorization',
    );
    const redacted = getCheckpointEpisode(db, first.checkpoint.checkpoint_id, {
      allowedScopes: ['project:alpha'],
      includeLocalPaths: false,
    });
    assert.equal(redacted.repo.root, '', 'remote checkpoint projections must hide local paths');
    assert.equal(redacted.source_ref.path, '', 'remote checkpoint projections must hide source paths');

    assert.throws(
      () => db.prepare('UPDATE memory_checkpoints SET summary = ? WHERE checkpoint_id = ?').run('mutated', first.checkpoint.checkpoint_id),
      /append-only/,
      'checkpoint rows must be immutable at the database boundary',
    );
    assert.throws(
      () => db.prepare('DELETE FROM memory_checkpoint_items WHERE checkpoint_id = ?').run(first.checkpoint.checkpoint_id),
      /append-only/,
      'checkpoint item rows must be immutable at the database boundary',
    );

    const explicit = appendClaimProposal(db, {
      checkpointId: first.checkpoint.checkpoint_id,
      scope: 'project:alpha',
      claimType: 'DECISION',
      content: 'Use one policy contract for stdio and HTTP.',
      evidenceClass: 'project_decision',
      evidenceRefs: ['cp:' + first.checkpoint.checkpoint_id],
      sourceAgent: 'codex',
      sourceHost: 'fixture-host',
    });
    const decision = appendClaimDecision(db, {
      proposalId: explicit.proposal_id,
      action: 'accepted',
      reason: 'Manually reviewed against the connector design.',
      memoryId: 'memory_committed_fixture',
      actorId: 'owner',
      actorHost: 'fixture-host',
      allowedScopes: ['project:alpha'],
    });
    assert.equal(decision.action, 'accepted', 'manual decisions should append a proposal event');
    assert.equal(getClaimProposal(db, explicit.proposal_id).status, 'accepted', 'latest proposal state should derive from the append-only event log');
    assert.equal(listClaimProposals(db, { status: 'accepted' }).length, 1, 'claim review should support exact status filtering');

    const answerReceipt = appendMemoryReceipt(db, {
      receiptType: 'answer',
      status: 'supported',
      scope: 'project:alpha',
      actorId: 'codex',
      actorHost: 'fixture-host',
      inputRefs: ['query:sha256:fixture'],
      outputRefs: ['answer:fixture'],
      evidenceRefs: ['memory_committed_fixture'],
      summary: 'Fixture answer receipt.',
    });
    const hydratedReceipt = getMemoryReceipt(db, answerReceipt.receipt_id, { allowedScopes: ['project:alpha'] });
    assert.match(hydratedReceipt.ledger_snapshot, /^sha256:[0-9a-f]{64}$/, 'receipts should bind a ledger snapshot');
    assert.equal(
      getMemoryReceipt(db, answerReceipt.receipt_id, { allowedScopes: ['project:beta'] }),
      null,
      'direct receipt reads must enforce the same scope boundary',
    );

    const ajv = new Ajv2020({ allErrors: true, strict: false });
    addFormats(ajv);
    const fixtures = [
      ['checkpoint.1.schema.json', first.checkpoint],
      ['claim.1.schema.json', getClaimProposal(db, explicit.proposal_id)],
      ['receipt.1.schema.json', hydratedReceipt],
    ];
    for (const [schemaName, fixture] of fixtures) {
      const validate = ajv.compile(loadSchema(schemaName));
      assert.equal(validate(fixture), true, `${schemaName} should validate its fixture: ${JSON.stringify(validate.errors)}`);
    }
  } finally {
    db.close();
  }
};

export { run };
