import assert from 'node:assert/strict';

import {
  classifyHostTier,
  hostTrustScore,
  ingestConfidence,
} from '../lib/core/host-trust.js';
import {
  syncHostMemories,
  exportMemoryBrief,
} from '../lib/core/host-memory-sync.js';
import { makeTempWorkspace, openDb } from './helpers.js';

const run = async () => {
  // --- Pure trust model ---
  assert.equal(classifyHostTier('codex'), 'own_agent', 'codex is first-party');
  assert.equal(classifyHostTier('cursor'), 'workspace', 'cursor rules are workspace tier');
  assert.equal(classifyHostTier('chatgpt_manual'), 'manual_import', 'cloud paste is manual_import');
  assert.equal(classifyHostTier('totally_new_host'), 'unknown', 'unknown host stays unknown');
  assert.equal(classifyHostTier('codex_runtime'), 'own_agent', 'first-party runtime variants keep trust');

  assert.ok(hostTrustScore('codex') > hostTrustScore('cursor'), 'own-agent outranks workspace');
  assert.ok(hostTrustScore('cursor') > hostTrustScore('totally_new_host'), 'workspace outranks unknown');
  assert.equal(hostTrustScore('codex', { hostTrust: { codex: 0.1 } }), 0.1, 'config.hostTrust override wins');

  // The poisoning hole: a writable file from an unknown host must NOT be stamped
  // as trusted as the agent's own memory (was a blanket 0.74 before).
  assert.ok(
    ingestConfidence('totally_new_host', 'rule') < ingestConfidence('codex', 'native_memory'),
    'unknown-host ingest confidence is lower than first-party',
  );
  assert.ok(ingestConfidence('codex', 'manual_import') <= 0.5, 'manual_import kind caps confidence');
  assert.ok(Math.abs(ingestConfidence('codex', 'native_memory') - 0.74) < 1e-9, 'first-party native preserves prior 0.74');

  // --- Deny-by-default scope on exportMemoryBrief (privacy leak fix) ---
  const temp = makeTempWorkspace('gb-host-trust-');
  const db = openDb(temp.dbPath);
  try {
    syncHostMemories({
      db,
      config: {},
      codexHome: temp.root,
      hosts: ['codex'],
      scope: 'profile:user',
    });

    assert.throws(
      () => exportMemoryBrief({ db, config: {}, targetHost: 'agents' }),
      /explicit scope/,
      'exportMemoryBrief must refuse an empty scope by default (no silent cross-scope leak)',
    );

    const scoped = exportMemoryBrief({ db, config: {}, targetHost: 'agents', scope: 'profile:user' });
    assert.equal(scoped.ok, true, 'explicit scope exports a brief');

    const all = exportMemoryBrief({ db, config: {}, targetHost: 'agents', allowAllScopes: true });
    assert.equal(all.ok, true, 'allowAllScopes:true is the explicit opt-in for all scopes');
  } finally {
    db.close();
  }
};

export { run };
