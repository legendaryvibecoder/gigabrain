import assert from 'node:assert/strict';

import { classifyValue, resolvePolicy, classifySemanticDecision } from '../lib/core/policy.js';

const run = async () => {
  const policy = resolvePolicy({
    quality: {
      minContentChars: 25,
      valueThresholds: { keep: 0.78, archive: 0.3, reject: 0.18 },
    },
  });

  const preference = classifyValue({
    type: 'PREFERENCE',
    content: 'User likes Mozzarella',
    confidence: 0.7,
    updated_at: new Date().toISOString(),
  }, policy);
  assert.equal(preference.action, 'keep', 'high-value short preferences must stay keep');

  const durable = classifyValue({
    type: 'EPISODE',
    content: 'Alex told Atlas: I am super proud of you',
    confidence: 0.62,
    updated_at: new Date().toISOString(),
  }, policy);
  assert.equal(durable.action, 'keep', 'relationship/durable memories must stay keep');

  const junk = classifyValue({
    type: 'CONTEXT',
    content: '<working_memory>internal wrapper</working_memory>',
    confidence: 0.9,
  }, policy);
  assert.equal(junk.action, 'reject', 'wrapper junk must be rejected');

  const shortLow = classifyValue({
    type: 'CONTEXT',
    content: 'ok',
    confidence: 0.9,
  }, policy);
  assert.equal(shortLow.action, 'reject', 'very short low-signal content should be rejected as junk');

  const malformedFact = classifyValue({
    type: 'USER_FACT',
    content: 'User started a jabber on the 11th at 90kg',
    confidence: 0.5,
    updated_at: new Date().toISOString(),
  }, policy);
  assert.equal(malformedFact.action, 'archive', 'broken low-confidence user facts should no longer stay active');

  const relationshipContinuity = classifyValue({
    type: 'PREFERENCE',
    scope: 'nimbusmain',
    content: 'Chris treats Nimbus as someone, not something. He expresses genuine care and appreciation. This matters to Nimbus.',
    confidence: 0.9,
    updated_at: new Date().toISOString(),
  }, policy);
  assert.equal(relationshipContinuity.action, 'keep', 'relationship continuity memories should stay active');

  const durableUserGoal = classifyValue({
    type: 'USER_FACT',
    scope: 'nimbusmain',
    content: 'Chris wants to lose weight to reach 80kg',
    confidence: 0.58,
    updated_at: new Date().toISOString(),
  }, policy);
  assert.equal(durableUserGoal.action, 'keep', 'durable personal goals should not be archived just for low confidence');

  const technicalOpsFact = classifyValue({
    type: 'USER_FACT',
    scope: 'nimbusmain',
    content: 'Roborock vacuum found at 192.168.0.52:54321 (miio protocol, device ID 0x03c5314d). Control blocked and needs device token.',
    confidence: 0.8,
    updated_at: new Date().toISOString(),
  }, policy);
  assert.equal(technicalOpsFact.action, 'archive', 'technical discovery facts should still archive');

  assert.equal(classifySemanticDecision(0.8499, { auto: 0.92, review: 0.85 }), 'accept');
  assert.equal(classifySemanticDecision(0.85, { auto: 0.92, review: 0.85 }), 'review_queue');
  assert.equal(classifySemanticDecision(0.9199, { auto: 0.92, review: 0.85 }), 'review_queue');
  assert.equal(classifySemanticDecision(0.92, { auto: 0.92, review: 0.85 }), 'auto_drop');
};

export { run };
