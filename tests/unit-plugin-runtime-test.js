import assert from 'node:assert/strict';

import { deriveScopeFromWorkspaceDir, hasSessionPrelude, markSessionBriefed } from '../index.ts';

const run = async () => {
  const workspaceScope = deriveScopeFromWorkspaceDir('/tmp/Agent Workspace/CPTO Ops');
  assert.equal(workspaceScope.startsWith('project:cpto-ops:'), true, 'workspace-derived scope should be stable and slugged');

  const cache = new Map();
  markSessionBriefed(cache, 'session-a');
  markSessionBriefed(cache, 'session-b');
  assert.equal(hasSessionPrelude(cache, 'session-a'), true, 'marked sessions should be detected');
  assert.equal(hasSessionPrelude(cache, 'missing-session'), false, 'missing sessions should not appear briefed');

  for (let index = 0; index < 2105; index += 1) {
    markSessionBriefed(cache, `session-${index}`);
  }
  assert.equal(cache.size <= 2048, true, 'session cache pruning should stay below the hard session limit');
  assert.equal(cache.has('session-2104'), true, 'most recent session keys should survive pruning');
};

export { run };
