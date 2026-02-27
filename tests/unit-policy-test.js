import assert from 'node:assert/strict';

import { classifyValue, resolvePolicy, classifySemanticDecision } from '../lib/core/policy.js';

const run = async () => {
  const policy = resolvePolicy({
    quality: {
      minContentChars: 25,
      valueThresholds: { keep: 0.75, archive: 0.45, reject: 0.45 },
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

  assert.equal(classifySemanticDecision(0.8499, { auto: 0.92, review: 0.85 }), 'accept');
  assert.equal(classifySemanticDecision(0.85, { auto: 0.92, review: 0.85 }), 'review_queue');
  assert.equal(classifySemanticDecision(0.9199, { auto: 0.92, review: 0.85 }), 'review_queue');
  assert.equal(classifySemanticDecision(0.92, { auto: 0.92, review: 0.85 }), 'auto_drop');
};

export { run };
