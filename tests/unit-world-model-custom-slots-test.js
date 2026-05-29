import assert from 'node:assert/strict';

import {
  configureWorldModelRules,
  matchCustomSlotRule,
  normalizeClaimSlotFromBelief,
} from '../lib/core/world-model.js';

const run = async () => {
  // --- De-overfit: with no config, deployment-specific phrases that used to be
  // hardcoded (a previous user's project/people) no longer trigger any slot. ---
  configureWorldModelRules({});
  assert.equal(
    matchCustomSlotRule('treats nimbus as someone, not something'),
    null,
    'previously hardcoded user phrase produces no custom slot on a fresh install',
  );
  assert.equal(matchCustomSlotRule('beef tartare cross-model comparison'), null, 'no baked-in food-image slot');
  assert.equal(matchCustomSlotRule('@flintfoxbot response behavior'), null, 'no baked-in flint slot');

  // Generic detectors still work without any config (engine is general, not empty).
  const birthday = normalizeClaimSlotFromBelief({ content: 'My birthday is in March.' });
  assert.equal(birthday && birthday.slot, 'identity.birthday', 'generic birthday detector still fires');

  // --- Config-driven: any user can define their OWN durable slots. ---
  configureWorldModelRules({
    worldModel: {
      customSlotRules: [
        { pattern: 'acme rocket project', slot: 'project.acme.status', topic: 'project', subtopic: 'status' },
        { pattern: 'prefers oxford commas', slot: 'preference.style.oxford', topic: 'preference', subtopic: 'style', value: 'oxford_comma:true' },
        { pattern: '(', slot: 'should.not.compile.bad.regex' }, // invalid regex is skipped, not thrown
      ],
    },
  });

  const acme = matchCustomSlotRule('Notes on the acme rocket project timeline.');
  assert.ok(acme, 'a configured rule matches');
  assert.equal(acme.slot, 'project.acme.status', 'configured slot is used');
  assert.equal(acme.topic, 'project');
  assert.equal(acme.subtopic, 'status');

  const oxford = matchCustomSlotRule('The user prefers oxford commas everywhere.');
  assert.equal(oxford.slot, 'preference.style.oxford');
  assert.equal(oxford.normalizedValue, 'oxford_comma:true', 'configured value overrides the summary');

  // Config rules take priority inside normalizeClaimSlotFromBelief.
  const viaNormalize = normalizeClaimSlotFromBelief({ content: 'Status update: acme rocket project is on track.' });
  assert.equal(viaNormalize && viaNormalize.slot, 'project.acme.status', 'custom rules are applied first in slot resolution');

  // Reconfiguring with empty config clears prior rules (no leakage between deployments).
  configureWorldModelRules({});
  assert.equal(matchCustomSlotRule('acme rocket project'), null, 'rules reset when reconfigured empty');

  console.log('world-model custom slots: all assertions passed');
};

export { run };
