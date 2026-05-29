import assert from 'node:assert/strict';

import {
  configureBeliefTrust,
  beliefPriorityScore,
  beliefHostTrustBonus,
} from '../lib/core/world-model.js';

const run = async () => {
  const nowIso = new Date().toISOString();
  const dayMs = 24 * 60 * 60 * 1000;
  const old = new Date(Date.now() - 200 * dayMs).toISOString(); // > 90d, recency boost ~0.01

  // --- Backward compatible: no config → trust term is inert ---
  configureBeliefTrust({});
  assert.equal(beliefHostTrustBonus({ source_host: 'codex' }), 0, 'no trust config → zero bonus');
  const base = beliefPriorityScore({ confidence: 0.7, source_host: 'codex', updated_at: nowIso });
  // identical to the pre-change formula (confidence + recency + registry-layer)
  assert.ok(Math.abs(base - (0.7 + 0.08)) < 1e-9, 'score unchanged when no trust configured');

  // --- Trust term is bounded and centered at 0.5 (range [-0.1, +0.1]) ---
  configureBeliefTrust({ worldModel: { hostTrust: { trusted_host: 1, shady_host: 0, neutral_host: 0.5 } } });
  assert.ok(Math.abs(beliefHostTrustBonus({ source_host: 'trusted_host' }) - 0.1) < 1e-9, 'max trust → +0.1');
  assert.ok(Math.abs(beliefHostTrustBonus({ source_host: 'shady_host' }) + 0.1) < 1e-9, 'min trust → -0.1');
  assert.equal(beliefHostTrustBonus({ source_host: 'neutral_host' }), 0, 'neutral trust → 0');
  assert.equal(beliefHostTrustBonus({ source_host: 'unknown_host' }), 0, 'unlisted host → 0 (neutral)');
  assert.equal(beliefHostTrustBonus({ source_agent: 'trusted_host' }), beliefHostTrustBonus({ source_host: 'trusted_host' }), 'falls back to source_agent');

  // --- The core drift fix: a high-trust belief beats a FRESHER low-trust one ---
  // Same claim, equal confidence. Low-trust belief is brand new (recency +0.08);
  // high-trust belief is 200 days old (recency ~0.01). Without trust the fresher
  // one wins; with trust the trusted one must win.
  const freshShady = { confidence: 0.7, source_host: 'shady_host', updated_at: nowIso };
  const oldTrusted = { confidence: 0.7, source_host: 'trusted_host', updated_at: old };

  configureBeliefTrust({}); // trust OFF → recency decides → fresher (shady) wins
  assert.ok(
    beliefPriorityScore(freshShady) > beliefPriorityScore(oldTrusted),
    'without trust, the fresher (low-trust) belief outranks the older trusted one',
  );

  configureBeliefTrust({ worldModel: { hostTrust: { trusted_host: 1, shady_host: 0 } } });
  assert.ok(
    beliefPriorityScore(oldTrusted) > beliefPriorityScore(freshShady),
    'WITH trust, the high-trust belief wins even though it is older — drift fix',
  );

  // --- Confidence still dominates: a clearly better-supported low-trust belief
  // is not overridden by trust alone (trust is a tie-breaker, not a veto). ---
  const strongShady = { confidence: 0.95, source_host: 'shady_host', updated_at: nowIso };
  const weakTrusted = { confidence: 0.55, source_host: 'trusted_host', updated_at: nowIso };
  assert.ok(
    beliefPriorityScore(strongShady) > beliefPriorityScore(weakTrusted),
    'a much-higher-confidence belief still wins regardless of host trust (trust ≠ veto)',
  );

  // --- Reconfigure resets (no leakage across deployments) ---
  configureBeliefTrust({ worldModel: { hostTrust: { trusted_host: 1 } } });
  assert.ok(beliefHostTrustBonus({ source_host: 'trusted_host' }) > 0, 'configured');
  configureBeliefTrust({});
  assert.equal(beliefHostTrustBonus({ source_host: 'trusted_host' }), 0, 'reset on empty reconfigure');

  console.log('belief-trust: all assertions passed');
};

export { run };
