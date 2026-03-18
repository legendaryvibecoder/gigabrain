import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

import { orchestrateRecall } from './orchestrator.js';
import { estimateTokens } from './recall-service.js';
import { recordRecallLatency } from './metrics.js';

/**
 * Compute precision at K: fraction of top-K results matching any expected substring.
 * @param {Array<{content: string}>} results
 * @param {string[]} expected
 * @param {number} k
 * @returns {number}
 */
const precisionAtK = (results, expected, k) => {
  const topK = results.slice(0, k);
  if (topK.length === 0) return 0;
  const hits = topK.filter((row) => {
    const content = String(row.content || '').toLowerCase();
    return expected.some((sub) => content.includes(String(sub || '').toLowerCase()));
  });
  return hits.length / topK.length;
};

/**
 * Mean Reciprocal Rank: 1/rank of first matching result (0 if none in top 10).
 * @param {Array<{content: string}>} results
 * @param {string[]} expected
 * @returns {number}
 */
const computeMRR = (results, expected) => {
  const limit = Math.min(results.length, 10);
  for (let i = 0; i < limit; i += 1) {
    const content = String(results[i].content || '').toLowerCase();
    if (expected.some((sub) => content.includes(String(sub || '').toLowerCase()))) {
      return 1 / (i + 1);
    }
  }
  return 0;
};

/**
 * NDCG@5 with binary relevance (1 if matches expected, 0 otherwise).
 * @param {Array<{content: string}>} results
 * @param {string[]} expected
 * @returns {number}
 */
const computeNDCG5 = (results, expected) => {
  const k = 5;
  const topK = results.slice(0, k);
  if (topK.length === 0) return 0;

  const relevance = topK.map((row) => {
    const content = String(row.content || '').toLowerCase();
    return expected.some((sub) => content.includes(String(sub || '').toLowerCase())) ? 1 : 0;
  });

  const dcg = relevance.reduce(
    (sum, rel, i) => sum + (rel / Math.log2(i + 2)),
    0,
  );

  const totalRelevant = Math.min(
    relevance.filter((r) => r === 1).length || expected.length,
    k,
  );
  const idealRelevance = Array.from({ length: k }, (_, i) => (i < totalRelevant ? 1 : 0));
  const idcg = idealRelevance.reduce(
    (sum, rel, i) => sum + (rel / Math.log2(i + 2)),
    0,
  );

  return idcg > 0 ? dcg / idcg : 0;
};

/**
 * Check hit rate: 1 if any result matches any expected substring, else 0.
 * @param {Array<{content: string}>} results
 * @param {string[]} expected
 * @returns {number}
 */
const computeHitRate = (results, expected) => {
  for (const row of results) {
    const content = String(row.content || '').toLowerCase();
    if (expected.some((sub) => content.includes(String(sub || '').toLowerCase()))) {
      return 1;
    }
  }
  return 0;
};

const round3 = (value) => Math.round(Number(value || 0) * 1000) / 1000;
const round2 = (value) => Math.round(Number(value || 0) * 100) / 100;

const computeMedian = (values = []) => {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].map((value) => Number(value) || 0).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
};

const computePercentile = (values = [], percentile = 95) => {
  if (!Array.isArray(values) || values.length === 0) return 0;
  const sorted = [...values].map((value) => Number(value) || 0).sort((a, b) => a - b);
  const rank = Math.max(0, Math.min(sorted.length - 1, (Number(percentile || 0) / 100) * (sorted.length - 1)));
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  const weight = rank - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
};

const loadEvalCases = (casesPath) => {
  const raw = fs.readFileSync(casesPath, 'utf8');
  const lines = raw.split('\n').filter((line) => line.trim());
  const cases = [];
  for (const line of lines) {
    try {
      cases.push(JSON.parse(line));
    } catch {
      // Skip malformed rows so one bad fixture line does not fail the whole eval.
    }
  }
  return cases;
};

/**
 * Run the eval harness over a list of cases.
 *
 * @param {object} params
 * @param {import('node:sqlite').DatabaseSync} params.db
 * @param {object} params.config - Normalized gigabrain config
 * @param {Array<object>} params.cases - Eval cases from cases.jsonl
 * @param {'golden'|'live'} [params.mode='live']
 * @param {(params: { db: import('node:sqlite').DatabaseSync, config: object, query: string, scope: string }) => object} [params.runRecall]
 * @returns {{ per_case: object[], aggregate: object, metadata: object }}
 */
const evalRecall = ({ db, config, cases, mode = 'live', runRecall = orchestrateRecall }) => {
  const perCase = [];
  const startAll = performance.now();

  for (const evalCase of cases) {
    const query = String(evalCase.query || '').trim();
    const scope = String(evalCase.agent || evalCase.scope || 'shared').trim();
    const expected = Array.isArray(evalCase.expected) ? evalCase.expected : [];
    const expectedStrategy = String(evalCase.expected_strategy || '').trim();
    const category = String(evalCase.category || '').trim();

    const startCase = performance.now();
    let result;
    let error = null;
    try {
      result = runRecall({ db, config, query, scope });
    } catch (err) {
      error = String(err.message || err);
      result = { results: [], injection: '', strategy: '' };
    }
    const latencyMs = performance.now() - startCase;

    const results = Array.isArray(result.results) ? result.results : [];
    const injection = String(result.injection || '');
    recordRecallLatency({
      ms: latencyMs,
      strategy: String(result.strategy || ''),
      chars: injection.length,
      resultCount: results.length,
    });

    const p1 = precisionAtK(results, expected, 1);
    const p3 = precisionAtK(results, expected, 3);
    const p5 = precisionAtK(results, expected, 5);
    const mrr = computeMRR(results, expected);
    const ndcg5 = computeNDCG5(results, expected);
    const hitRate = computeHitRate(results, expected);
    const injectionTokens = estimateTokens(injection);
    const strategyCorrect = expectedStrategy
      ? (String(result.strategy || '') === expectedStrategy ? 1 : 0)
      : null;

    perCase.push({
      query,
      scope,
      category,
      expected,
      expected_strategy: expectedStrategy || null,
      actual_strategy: String(result.strategy || ''),
      error,
      latency_ms: Math.round(latencyMs * 100) / 100,
      result_count: results.length,
      metrics: {
        precision_at_1: round3(p1),
        precision_at_3: round3(p3),
        precision_at_5: round3(p5),
        mrr: round3(mrr),
        ndcg_at_5: round3(ndcg5),
        hit_rate: hitRate,
        injection_tokens: injectionTokens,
        strategy_correct: strategyCorrect,
      },
      top_results: results.slice(0, 3).map((row) => ({
        memory_id: String(row.memory_id || row.id || ''),
        content: String(row.content || '').slice(0, 200),
        score: Number(row._score || row.score || row.score_total || 0),
      })),
    });
  }

  const totalMs = performance.now() - startAll;

  const validCases = perCase.filter((c) => !c.error);
  const validCount = validCases.length;
  const count = validCount || 1;
  const sum = (key) => validCases.reduce((s, c) => s + Number(c.metrics[key] || 0), 0);
  const avg = (key) => sum(key) / count;

  const strategyCases = validCases.filter((c) => c.metrics.strategy_correct !== null);
  const strategyAccuracy = strategyCases.length > 0
    ? strategyCases.reduce((s, c) => s + Number(c.metrics.strategy_correct || 0), 0) / strategyCases.length
    : null;

  const latencies = validCases.map((c) => c.latency_ms).sort((a, b) => a - b);
  const medianLatency = computeMedian(latencies);
  const p95Latency = computePercentile(latencies, 95);

  const aggregate = {
    case_count: cases.length,
    evaluated_case_count: validCount,
    error_case_count: perCase.filter((c) => c.error).length,
    precision_at_1: round3(avg('precision_at_1')),
    precision_at_3: round3(avg('precision_at_3')),
    precision_at_5: round3(avg('precision_at_5')),
    mrr: round3(avg('mrr')),
    ndcg_at_5: round3(avg('ndcg_at_5')),
    hit_rate: round3(avg('hit_rate')),
    avg_injection_tokens: Math.round(avg('injection_tokens')),
    strategy_accuracy: strategyAccuracy !== null
      ? round3(strategyAccuracy)
      : null,
    latency_median_ms: round2(medianLatency),
    latency_p95_ms: round2(p95Latency),
    total_duration_ms: round2(totalMs),
  };

  const categoryBreakdown = {};
  for (const c of validCases) {
    const cat = c.category || 'uncategorized';
    if (!categoryBreakdown[cat]) {
      categoryBreakdown[cat] = { count: 0, hit_rate_sum: 0, mrr_sum: 0, precision1_sum: 0 };
    }
    categoryBreakdown[cat].count += 1;
    categoryBreakdown[cat].hit_rate_sum += c.metrics.hit_rate;
    categoryBreakdown[cat].mrr_sum += c.metrics.mrr;
    categoryBreakdown[cat].precision1_sum += c.metrics.precision_at_1;
  }
  for (const cat of Object.keys(categoryBreakdown)) {
    const entry = categoryBreakdown[cat];
    entry.hit_rate = round3(entry.hit_rate_sum / entry.count);
    entry.mrr = round3(entry.mrr_sum / entry.count);
    entry.precision_at_1 = round3(entry.precision1_sum / entry.count);
    delete entry.hit_rate_sum;
    delete entry.mrr_sum;
    delete entry.precision1_sum;
  }

  const metadata = {
    mode,
    generated_at: new Date().toISOString(),
    node_version: process.version,
    platform: process.platform,
    category_breakdown: categoryBreakdown,
  };

  return {
    per_case: perCase,
    aggregate,
    metadata,
  };
};

export {
  evalRecall,
  precisionAtK,
  computeMRR,
  computeNDCG5,
  computeHitRate,
  computeMedian,
  computePercentile,
  loadEvalCases,
};
