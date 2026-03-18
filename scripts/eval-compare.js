#!/usr/bin/env node

/**
 * eval-compare.js -- Compare two eval report JSONs and detect regressions.
 *
 * Usage:
 *   node scripts/eval-compare.js --baseline report-a.json --candidate report-b.json
 *
 * Outputs JSON to stdout with delta metrics and regression detection.
 */

import fs from 'node:fs';
import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    baseline: { type: 'string', short: 'b' },
    candidate: { type: 'string', short: 'c' },
    threshold: { type: 'string', short: 't', default: '0.05' },
  },
  strict: false,
});

if (!args.baseline || !args.candidate) {
  console.error('Usage: node scripts/eval-compare.js --baseline report-a.json --candidate report-b.json [--threshold 0.05]');
  process.exit(1);
}

const readReport = (filePath) => {
  const raw = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(raw);
};

const baseline = readReport(args.baseline);
const candidate = readReport(args.candidate);
const threshold = Math.max(0, Number(args.threshold) || 0.05);

const AGGREGATE_KEYS = [
  'precision_at_1',
  'precision_at_3',
  'precision_at_5',
  'mrr',
  'ndcg_at_5',
  'hit_rate',
  'avg_injection_tokens',
  'strategy_accuracy',
  'latency_median_ms',
  'latency_p95_ms',
];

const HIGHER_IS_BETTER = new Set([
  'precision_at_1',
  'precision_at_3',
  'precision_at_5',
  'mrr',
  'ndcg_at_5',
  'hit_rate',
  'strategy_accuracy',
]);

const LOWER_IS_BETTER = new Set([
  'avg_injection_tokens',
  'latency_median_ms',
  'latency_p95_ms',
]);

const METRIC_TOLERANCES = {
  latency_median_ms: 5,
  latency_p95_ms: 5,
};

const deltas = {};
let improvements = 0;
let regressions = 0;
let neutral = 0;

for (const key of AGGREGATE_KEYS) {
  const bVal = baseline.aggregate?.[key];
  const cVal = candidate.aggregate?.[key];
  if (bVal == null || cVal == null) {
    deltas[key] = { baseline: bVal ?? null, candidate: cVal ?? null, delta: null, verdict: 'missing' };
    continue;
  }
  const delta = cVal - bVal;
  const absDelta = Math.abs(delta);
  const effectiveThreshold = Math.max(threshold, Number(METRIC_TOLERANCES[key] || 0));
  let verdict = 'neutral';

  if (HIGHER_IS_BETTER.has(key)) {
    if (delta > effectiveThreshold) { verdict = 'improved'; improvements += 1; }
    else if (delta < -effectiveThreshold) { verdict = 'regressed'; regressions += 1; }
    else { neutral += 1; }
  } else if (LOWER_IS_BETTER.has(key)) {
    if (delta < -effectiveThreshold) { verdict = 'improved'; improvements += 1; }
    else if (delta > effectiveThreshold) { verdict = 'regressed'; regressions += 1; }
    else { neutral += 1; }
  } else {
    neutral += 1;
  }

  deltas[key] = {
    baseline: Math.round(bVal * 1000) / 1000,
    candidate: Math.round(cVal * 1000) / 1000,
    delta: Math.round(delta * 1000) / 1000,
    abs_delta: Math.round(absDelta * 1000) / 1000,
    verdict,
  };
}

const baselineCases = new Map();
if (Array.isArray(baseline.per_case)) {
  for (const c of baseline.per_case) {
    const key = `${c.query}||${c.scope || ''}`;
    baselineCases.set(key, c);
  }
}

const perCaseRegressions = [];
if (Array.isArray(candidate.per_case)) {
  for (const c of candidate.per_case) {
    const key = `${c.query}||${c.scope || ''}`;
    const b = baselineCases.get(key);
    if (!b) continue;

    const bHit = Number(b.metrics?.hit_rate || 0);
    const cHit = Number(c.metrics?.hit_rate || 0);
    if (bHit > 0 && cHit === 0) {
      perCaseRegressions.push({
        query: c.query,
        scope: c.scope || '',
        category: c.category || '',
        baseline_hit_rate: bHit,
        candidate_hit_rate: cHit,
        baseline_mrr: Number(b.metrics?.mrr || 0),
        candidate_mrr: Number(c.metrics?.mrr || 0),
      });
    }
  }
}

let summaryVerdict = 'neutral';
if (regressions > improvements && regressions > 0) {
  summaryVerdict = 'regressed';
} else if (improvements > regressions && improvements > 0) {
  summaryVerdict = 'improved';
} else if (perCaseRegressions.length > 0) {
  summaryVerdict = 'regressed';
}

const output = {
  compared_at: new Date().toISOString(),
  baseline_generated_at: baseline.metadata?.generated_at || null,
  candidate_generated_at: candidate.metadata?.generated_at || null,
  threshold,
  summary: {
    verdict: summaryVerdict,
    aggregate_improvements: improvements,
    aggregate_regressions: regressions,
    aggregate_neutral: neutral,
    per_case_regressions: perCaseRegressions.length,
  },
  aggregate_deltas: deltas,
  per_case_regressions: perCaseRegressions,
};

console.log(JSON.stringify(output, null, 2));

if (summaryVerdict === 'regressed') {
  process.exit(1);
}
