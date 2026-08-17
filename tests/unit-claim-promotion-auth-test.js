import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStandaloneCodexConfig } from '../lib/core/codex-project.js';
import {
  bootstrapStandaloneStore,
  runCheckpoint,
  runClaimDecide,
  runClaimPropose,
} from '../lib/core/codex-service.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');

const writeJsonPretty = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

const run = async () => {
  const scratchBase = path.join(REPO_ROOT, '.tmp');
  fs.mkdirSync(scratchBase, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratchBase, 'claim-auth-'));
  const projectRoot = path.join(root, 'project');
  const storeRoot = path.join(root, 'store');
  const configPath = path.join(storeRoot, 'config.json');
  fs.mkdirSync(projectRoot, { recursive: true });
  const config = createStandaloneCodexConfig({
    projectRoot,
    projectStorePath: storeRoot,
    userProfilePath: path.join(root, 'profile'),
  });
  writeJsonPretty(configPath, config);
  bootstrapStandaloneStore({ configPath });

  const alphaScope = 'project:alpha';
  const betaScope = 'project:beta';
  const reviewerAuthorization = {
    subject: 'reviewer-fixture',
    authority: 'reviewer',
    memoryScopes: [alphaScope],
    permissions: ['gigabrain:read', 'gigabrain:commit'],
  };

  try {
    const ownerAssertion = runClaimPropose({
      configPath,
      scope: alphaScope,
      allowedScopes: [alphaScope],
      content: 'The owner prefers a copper interface.',
      claimType: 'PREFERENCE',
      evidenceClass: 'owner_assertion',
    });
    assert.throws(
      () => runClaimDecide({
        configPath,
        scope: alphaScope,
        allowedScopes: [alphaScope],
        authorization: reviewerAuthorization,
        authority: 'owner',
        proposalId: ownerAssertion.proposal.proposal_id,
        action: 'accepted',
        reason: 'Attempt to spoof owner authority in tool arguments.',
      }),
      /requires owner authority/,
      'tool arguments must not override authenticated reviewer authority',
    );

    const inference = runClaimPropose({
      configPath,
      scope: alphaScope,
      allowedScopes: [alphaScope],
      content: 'The next release should use a speculative codename.',
      claimType: 'CONTEXT',
      evidenceClass: 'agent_inference',
    });
    assert.throws(
      () => runClaimDecide({
        configPath,
        scope: alphaScope,
        allowedScopes: [alphaScope],
        authorization: reviewerAuthorization,
        proposalId: inference.proposal.proposal_id,
        action: 'accepted',
        reason: 'Reviewer attempts to promote an unevidenced inference.',
      }),
      /requires owner authority/,
      'unevidenced agent inferences must not be promotable by reviewer authority',
    );

    const reviewedDecision = runClaimPropose({
      configPath,
      scope: alphaScope,
      allowedScopes: [alphaScope],
      content: 'Use the checkpoint ledger for release handoffs.',
      claimType: 'DECISION',
      evidenceClass: 'project_decision',
      evidenceRefs: ['fixture:reviewed-decision'],
    });
    const accepted = runClaimDecide({
      configPath,
      scope: alphaScope,
      allowedScopes: [alphaScope],
      authorization: reviewerAuthorization,
      proposalId: reviewedDecision.proposal.proposal_id,
      action: 'accepted',
      reason: 'Reviewer verified the project decision evidence.',
      includeLocalPaths: false,
    });
    assert.equal(accepted.action, 'accepted', 'reviewer with commit permission may accept a typed project decision');
    assert.equal(accepted.memory.recallable, true, 'accepted project decision should enter the explicit memory path');
    assert.equal(accepted.memory.source_path, '', 'remote-style decisions should redact local paths');
    assert.throws(
      () => runClaimDecide({
        configPath,
        scope: alphaScope,
        allowedScopes: [alphaScope],
        authorization: reviewerAuthorization,
        proposalId: reviewedDecision.proposal.proposal_id,
        action: 'rejected',
        reason: 'Attempt a second terminal decision.',
      }),
      /already accepted/,
      'a proposal should permit exactly one terminal decision',
    );

    const duplicateDecision = runClaimPropose({
      configPath,
      scope: alphaScope,
      allowedScopes: [alphaScope],
      content: 'Use the checkpoint ledger for release handoffs.',
      claimType: 'DECISION',
      evidenceClass: 'project_decision',
      evidenceRefs: ['fixture:reviewed-decision-duplicate'],
    });
    const acceptedDuplicate = runClaimDecide({
      configPath,
      scope: alphaScope,
      allowedScopes: [alphaScope],
      authorization: reviewerAuthorization,
      proposalId: duplicateDecision.proposal.proposal_id,
      action: 'accepted',
      reason: 'The reviewed claim resolves to an existing durable memory.',
    });
    assert.equal(acceptedDuplicate.memory.recallable, true, 'duplicate promotion should remain recallable');
    assert.equal(
      acceptedDuplicate.memory.memory_id,
      accepted.memory.memory_id,
      'deduplicated promotion should bind its terminal event to the existing memory id',
    );

    const betaCheckpoint = runCheckpoint({
      configPath,
      scope: betaScope,
      summary: 'Beta-only checkpoint fixture.',
    });
    assert.throws(
      () => runClaimPropose({
        configPath,
        scope: alphaScope,
        allowedScopes: [alphaScope],
        checkpointId: betaCheckpoint.checkpoint_id,
        content: 'Cross-scope checkpoint reference.',
        claimType: 'CONTEXT',
        evidenceClass: 'agent_inference',
      }),
      /not found or not authorized/,
      'claim proposals must not reference checkpoints outside their authorized scope',
    );
    assert.throws(
      () => runCheckpoint({
        configPath,
        scope: alphaScope,
        allowedScopes: [alphaScope],
        parentCheckpointId: betaCheckpoint.checkpoint_id,
        summary: 'Cross-scope parent attempt.',
      }),
      /not found or not authorized/,
      'checkpoint lineage must not cross scope boundaries',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

export { run };
