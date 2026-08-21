import assert from 'node:assert/strict';

import { mergeAnnotatedResults } from '../lib/core/codex-service.js';

const row = (origin, id, score, content, denseCosine = null) => ({
  origin,
  memory_id: `${origin}:${id}`,
  content,
  score,
  relevance: { dense_cosine: denseCosine, entity_match: false },
});

const run = () => {
  {
    const query = 'service migration API deadline September 2026';
    const merged = mergeAnnotatedResults([
      {
        origin: 'project',
        results: [
          row('project', 'migration', -1.2003, 'The service migration deadline is September 2026; use the replacement API.', 0.69),
          row('project', 'heartbeat', -1.2175, 'Agent status: HEARTBEAT_OK', 0.43),
        ],
      },
      {
        origin: 'user',
        results: [
          row('user', 'guardrail', 2.1203, 'Local agents may read workspace files; destructive deletion is blocked.'),
        ],
      },
    ], 8, query);
    assert.equal(merged[0].memory_id, 'project:migration');
  }

  {
    const query = 'concise release notes';
    const merged = mergeAnnotatedResults([
      { origin: 'project', results: [row('project', 'weak', 0.04, 'Release engineering uses a rollback checklist.')] },
      { origin: 'user', results: [row('user', 'strong', 2.4, 'The user prefers concise release notes with a short summary line.')] },
    ], 8, query);
    assert.equal(merged[0].memory_id, 'user:strong');
  }

  {
    const query = 'deploy rollback checklist';
    const shared = 'Every deploy pairs a rollback checklist with a signed-off owner.';
    const merged = mergeAnnotatedResults([
      {
        origin: 'project',
        results: [
          row('project', 'solo', 0.04, 'Deploy rollback checklist lives in the release runbook.'),
          row('project', 'shared', 0.03, shared),
        ],
      },
      {
        origin: 'user',
        results: [
          row('user', 'other', 2.4, 'Deploy rollback checklist review happens weekly.'),
          row('user', 'shared', 2.3, shared),
        ],
      },
    ], 8, query);
    assert.equal(merged[0].content, shared);
  }

  {
    const merged = mergeAnnotatedResults([
      { origin: 'project', results: [row('project', 'p1', -50, 'project row')] },
      { origin: 'user', results: [row('user', 'u1', 9000, 'user row')] },
    ], 8);
    assert.equal(merged[0].memory_id, 'project:p1');
  }

  {
    const merged = mergeAnnotatedResults([
      { origin: 'project', results: [] },
      { origin: 'user', results: [row('user', 'u1', 2.4, 'user row about deploys')] },
      { origin: 'remote', results: [row('remote', 'r1', 0, 'remote row about deploys')] },
    ], 8, 'deploys');
    assert.equal(merged.length, 2);
    assert.equal(merged[0].memory_id, 'user:u1');
  }

  {
    const merged = mergeAnnotatedResults([
      { origin: 'project', results: [row('project', 'p1', 1, 'alpha'), row('project', 'p2', 1, 'beta'), row('project', 'p3', 1, 'gamma')] },
      { origin: 'user', results: [row('user', 'u1', 1, 'delta'), row('user', 'u2', 1, 'epsilon')] },
    ], 3, 'alpha beta gamma');
    assert.equal(merged.length, 3);
  }
};

export { run };
