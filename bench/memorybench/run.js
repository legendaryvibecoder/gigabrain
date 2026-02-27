#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const argValue = (name, fallback) => {
  const idx = process.argv.indexOf(name);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  const withEq = process.argv.find((arg) => arg.startsWith(`${name}=`));
  if (withEq) return withEq.split('=').slice(1).join('=');
  return fallback;
};

const hasFlag = (name) => process.argv.includes(name);

const baseUrl = String(argValue('--base-url', process.env.GB_UI_BASE_URL || process.env.GB_MEMORY_API_BASE_URL || '')).replace(/\/$/, '');
const token = String(argValue('--token', process.env.GB_UI_TOKEN || process.env.GB_MEMORY_API_TOKEN || ''));
const casesPath = argValue('--cases', path.join(process.cwd(), 'eval', 'cases.jsonl'));
const topK = Math.max(1, Math.min(Number(argValue('--topk', '8')) || 8, 50));
const runs = Math.max(1, Math.min(Number(argValue('--runs', '1')) || 1, 10));
const outDir = argValue('--out-dir', path.join(process.cwd(), 'bench', 'memorybench', 'data', 'runs'));
const failBelow = Number(argValue('--fail-below', '0')) || 0;
const writeRaw = hasFlag('--write-raw');
const queryStrategyRaw = String(argValue('--query-strategy', 'first') || 'first').trim().toLowerCase();
const queryStrategy = queryStrategyRaw === 'best-of' ? 'best-of' : 'first';

if (!baseUrl) {
  console.error('Missing --base-url (or GB_UI_BASE_URL / GB_MEMORY_API_BASE_URL)');
  process.exit(1);
}
if (!token) {
  console.error('Missing --token (or GB_UI_TOKEN / GB_MEMORY_API_TOKEN)');
  process.exit(1);
}

const readCases = (p) => {
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && parsed.query) out.push(parsed);
    } catch {
      // ignore invalid jsonl line
    }
  }
  return out;
};

const normalizeRowText = (row) => {
  const text = String(row?.text || row?.content || row?.snippet || '');
  const pathValue = String(row?.path || row?.source || '');
  return `${text}\n${pathValue}`.toLowerCase();
};

const scoreCase = (rows, expected) => {
  const expectedList = Array.isArray(expected) ? expected.map((x) => String(x || '').toLowerCase()).filter(Boolean) : [];
  if (expectedList.length === 0) return { hit: 0, total: 0, top1Hit: 0, firstRelevantRank: null };

  const texts = rows.map((r) => normalizeRowText(r));
  const top1 = texts[0] || '';
  const hit = expectedList.reduce((n, needle) => n + (texts.some((t) => t.includes(needle)) ? 1 : 0), 0);
  const top1Hit = expectedList.some((needle) => top1.includes(needle)) ? 1 : 0;
  let firstRelevantRank = null;
  for (let i = 0; i < texts.length; i++) {
    if (expectedList.some((needle) => texts[i].includes(needle))) {
      firstRelevantRank = i + 1;
      break;
    }
  }
  return { hit, total: expectedList.length, top1Hit, firstRelevantRank };
};

const timedPost = async (url, body) => {
  const startedAt = Date.now();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-GB-Token': token,
    },
    body: JSON.stringify(body),
  });
  return { res, latencyMs: Date.now() - startedAt };
};

const BENCH_RECALL_ENDPOINTS = [
  '/gb/bench/recall',
  '/__gigabrain__/bench/recall',
];
const LEGACY_RECALL_ENDPOINTS = [
  '/gb/recall/explain',
  '/__gigabrain__/recall/explain',
];

const postRecallBench = async ({ query, agent }) => {
  const payload = {
    query,
    topK,
    agentId: agent || 'shared',
    sessionKey: `agent:${agent || 'shared'}:memorybench`,
  };
  let last = null;
  for (const endpoint of BENCH_RECALL_ENDPOINTS) {
    const req = await timedPost(`${baseUrl}${endpoint}`, payload);
    last = { ...req, endpoint };
    if (req.res.ok) return { ...req, endpoint };
    if (![404, 405].includes(req.res.status)) return { ...req, endpoint };
  }
  return last;
};

const postRecallLegacy = async ({ query, agent }) => {
  const payload = {
    query,
    agentId: agent || 'shared',
    limit: topK,
  };
  let last = null;
  for (const endpoint of LEGACY_RECALL_ENDPOINTS) {
    const req = await timedPost(`${baseUrl}${endpoint}`, payload);
    last = { ...req, endpoint };
    if (req.res.ok) return { ...req, endpoint };
    if (![404, 405].includes(req.res.status)) return { ...req, endpoint };
  }
  return last;
};

const normalizeRows = (json) => {
  if (Array.isArray(json?.results)) return json.results;
  if (Array.isArray(json?.candidates)) return json.candidates;
  if (Array.isArray(json)) return json;
  return [];
};

const percentile = (values, pct) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1));
  return sorted[idx];
};

const postRecall = async ({ query, agent }) => {
  const benchReq = await postRecallBench({ query, agent });
  const benchRes = benchReq?.res;
  if (benchRes?.ok) {
    const json = await benchRes.json();
    return {
      rows: normalizeRows(json),
      debug: json?.debug || null,
      latencyMs: benchReq.latencyMs,
      endpoint: `bench:${benchReq.endpoint}`,
    };
  }
  if (benchRes && ![404, 405].includes(benchRes.status)) {
    const body = await benchRes.text().catch(() => '');
    throw new Error(`bench recall failed (${benchRes.status} @ ${benchReq?.endpoint || 'unknown'}): ${body.slice(0, 300)}`);
  }

  // Backward-compatible fallback for older Gigabrain builds.
  const legacyReq = await postRecallLegacy({ query, agent });
  const legacyRes = legacyReq?.res;
  if (!legacyRes?.ok) {
    const status = legacyRes?.status || 'no-response';
    const body = legacyRes ? await legacyRes.text().catch(() => '') : '';
    throw new Error(`legacy recall failed (${status} @ ${legacyReq?.endpoint || 'unknown'}): ${body.slice(0, 300)}`);
  }
  const json = await legacyRes.json();
  return {
    rows: normalizeRows(json),
    debug: null,
    latencyMs: legacyReq.latencyMs,
    endpoint: `legacy:${legacyReq.endpoint}`,
  };
};

const median = (values) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const main = async () => {
  const cases = readCases(casesPath);
  if (cases.length === 0) {
    console.log(JSON.stringify({ ok: false, error: 'no cases found', casesPath }, null, 2));
    process.exit(1);
  }

  const runId = `gb-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  const runPath = path.join(outDir, runId);
  fs.mkdirSync(runPath, { recursive: true });

  const allRunScores = [];
  const allRunTop1 = [];
  const allRunLatencyP50 = [];
  const allRunLatencyP95 = [];
  const detailsByRun = [];

  for (let run = 1; run <= runs; run++) {
    let totalExpected = 0;
    let totalHit = 0;
    let totalTop1 = 0;
    const selectedLatencies = [];
    const details = [];

    for (const c of cases) {
      const queries = Array.isArray(c.queries) && c.queries.length > 0 ? c.queries : [c.query];
      let bestRows = [];
      let bestScore = null;
      let bestLatencyMs = null;
      let bestDebug = null;
      let bestEndpoint = null;

      if (queryStrategy === 'best-of') {
        for (const q of queries) {
          const recall = await postRecall({ query: q, agent: c.agent });
          const rows = recall.rows;
          const score = scoreCase(rows, c.expected);
          if (!bestScore || score.hit > bestScore.hit || (score.hit === bestScore.hit && score.top1Hit > bestScore.top1Hit)) {
            bestScore = score;
            bestRows = rows;
            bestLatencyMs = recall.latencyMs;
            bestDebug = recall.debug;
            bestEndpoint = recall.endpoint;
          }
        }
      } else {
        const q = queries[0];
        const recall = await postRecall({ query: q, agent: c.agent });
        const rows = recall.rows;
        bestScore = scoreCase(rows, c.expected);
        bestRows = rows;
        bestLatencyMs = recall.latencyMs;
        bestDebug = recall.debug;
        bestEndpoint = recall.endpoint;
      }

      if (!bestScore) {
        bestScore = { hit: 0, total: 0, top1Hit: 0, firstRelevantRank: null };
      }

      totalExpected += bestScore.total;
      totalHit += bestScore.hit;
      totalTop1 += bestScore.top1Hit;
      if (Number.isFinite(bestLatencyMs)) selectedLatencies.push(bestLatencyMs);
      details.push({
        query: c.query,
        agent: c.agent || 'shared',
        expected: c.expected || [],
        hit: bestScore.hit,
        total: bestScore.total,
        top1_hit: bestScore.top1Hit,
        first_relevant_rank: bestScore.firstRelevantRank,
        latency_ms: bestLatencyMs,
        recall_endpoint: bestEndpoint,
        debug: bestDebug || undefined,
        sample_result: writeRaw ? bestRows.slice(0, Math.min(3, bestRows.length)) : undefined,
        query_strategy: queryStrategy,
      });
    }

    const recallAtK = totalExpected > 0 ? totalHit / totalExpected : 1;
    const top1HitRate = cases.length > 0 ? totalTop1 / cases.length : 1;
    const latencyP50 = percentile(selectedLatencies, 50);
    const latencyP95 = percentile(selectedLatencies, 95);
    allRunScores.push(recallAtK);
    allRunTop1.push(top1HitRate);
    allRunLatencyP50.push(latencyP50);
    allRunLatencyP95.push(latencyP95);
    detailsByRun.push({
      run,
      recall_at_k: recallAtK,
      top1_hit_rate: top1HitRate,
      latency_p50_ms: latencyP50,
      latency_p95_ms: latencyP95,
      details,
    });
  }

  const report = {
    ok: true,
    generated_at: new Date().toISOString(),
    run_id: runId,
    base_url: baseUrl,
    cases_path: casesPath,
    top_k: topK,
    runs,
    query_strategy: queryStrategy,
    metrics: {
      recall_at_k_runs: allRunScores,
      top1_hit_rate_runs: allRunTop1,
      latency_p50_ms_runs: allRunLatencyP50,
      latency_p95_ms_runs: allRunLatencyP95,
      recall_at_k_median: median(allRunScores),
      top1_hit_rate_median: median(allRunTop1),
      latency_p50_ms_median: median(allRunLatencyP50),
      latency_p95_ms_median: median(allRunLatencyP95),
    },
    runs_detail: detailsByRun,
  };

  const reportPath = path.join(runPath, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));

  if (failBelow > 0 && report.metrics.recall_at_k_median < failBelow) {
    process.exit(2);
  }
};

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
