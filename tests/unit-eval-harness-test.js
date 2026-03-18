import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  computeHitRate,
  computeMRR,
  computeMedian,
  computeNDCG5,
  computePercentile,
  evalRecall,
  loadEvalCases,
  precisionAtK,
} from '../lib/core/eval-harness.js';

const run = async () => {
  const rankedRows = [
    { content: 'Jordan leads the graph rollout.' },
    { content: 'A weaker unrelated note.' },
    { content: 'The rollout owner is Riley.' },
  ];
  assert.equal(precisionAtK(rankedRows, ['graph'], 1), 1, 'precision@1 should count direct hits in the first slot');
  assert.equal(precisionAtK(rankedRows, ['rollout'], 2), 0.5, 'precision@k should divide by inspected rows');
  assert.equal(computeMRR(rankedRows, ['riley']), 1 / 3, 'MRR should return the reciprocal rank of the first hit');
  assert.equal(computeHitRate(rankedRows, ['missing']), 0, 'hit rate should be zero when nothing matches');
  const ndcg = computeNDCG5(rankedRows, ['graph', 'riley']);
  assert.equal(
    Math.abs(ndcg - 0.9197207891481876) < 0.000001,
    true,
    'NDCG@5 should match the expected binary-relevance value',
  );

  assert.equal(computeMedian([1, 2, 3, 4]), 2.5, 'median should average the middle pair for even-length arrays');
  assert.equal(computeMedian([1, 2, 3]), 2, 'median should return the middle value for odd-length arrays');
  assert.equal(computePercentile([10], 95), 10, 'percentile should return the lone value for single-item arrays');
  assert.equal(
    Math.abs(computePercentile([10, 20], 95) - 19.5) < 0.000001,
    true,
    'percentile should interpolate even for small arrays',
  );
  assert.equal(
    Math.abs(computePercentile([1, 2, 3, 4], 95) - 3.85) < 0.000001,
    true,
    'percentile should interpolate instead of stepping to the next bucket',
  );
  assert.equal(computePercentile([], 95), 0, 'percentile should return zero for empty input');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-eval-harness-'));
  const casesPath = path.join(root, 'cases.jsonl');
  fs.writeFileSync(casesPath, [
    JSON.stringify({ query: 'who is riley?', expected: ['partner'] }),
    '{not valid json',
    JSON.stringify({ query: 'what happened in january?', expected: ['january'] }),
  ].join('\n') + '\n', 'utf8');

  const cases = loadEvalCases(casesPath);
  assert.equal(cases.length, 2, 'eval harness should skip malformed case rows instead of failing the whole load');

  const db = new DatabaseSync(':memory:');
  try {
    const report = evalRecall({
      db,
      config: {},
      mode: 'golden',
      cases: [
        {
          query: 'who owns rollout',
          scope: 'shared',
          expected: ['riley'],
          expected_strategy: 'entity_brief',
          category: 'entity',
        },
        {
          query: 'what changed',
          scope: 'shared',
          expected: ['missing'],
          expected_strategy: 'entity_brief',
          category: 'context',
        },
        {
          query: 'explode',
          scope: 'shared',
          expected: ['never'],
          category: 'errors',
        },
      ],
      runRecall: ({ query }) => {
        if (query === 'explode') throw new Error('boom');
        if (query === 'who owns rollout') {
          return {
            strategy: 'entity_brief',
            injection: '<gigabrain-context>\n- Riley owns the rollout.\n</gigabrain-context>\n',
            results: [
              { memory_id: 'm1', content: 'Riley owns the rollout.', _score: 0.94 },
              { memory_id: 'm2', content: 'Jordan reviews the nightly graph.', _score: 0.4 },
            ],
          };
        }
        return {
          strategy: 'quick_context',
          injection: '<gigabrain-context>\n- No recall hit.\n</gigabrain-context>\n',
          results: [
            { memory_id: 'm3', content: 'A generic note.', _score: 0.18 },
          ],
        };
      },
    });

    assert.deepEqual(
      Object.keys(report.aggregate).sort(),
      [
        'avg_injection_tokens',
        'case_count',
        'error_case_count',
        'evaluated_case_count',
        'hit_rate',
        'latency_median_ms',
        'latency_p95_ms',
        'mrr',
        'ndcg_at_5',
        'precision_at_1',
        'precision_at_3',
        'precision_at_5',
        'strategy_accuracy',
        'total_duration_ms',
      ],
      'eval harness should emit the canonical aggregate schema',
    );
    assert.equal(report.aggregate.case_count, 3, 'aggregate should report total cases');
    assert.equal(report.aggregate.evaluated_case_count, 2, 'aggregate should count successful eval cases');
    assert.equal(report.aggregate.error_case_count, 1, 'aggregate should count runner failures separately');
    assert.equal(report.aggregate.strategy_accuracy, 0.5, 'aggregate should average only strategy-checked cases');
    assert.equal(report.per_case[2].error, 'boom', 'per-case output should retain thrown runner errors');
  } finally {
    db.close();
  }
};

export { run };
