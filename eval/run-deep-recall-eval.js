import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import { normalizeConfig } from '../lib/core/config.js';
import { runMaintenance } from '../lib/core/maintenance-service.js';
import { rebuildEntityMentions } from '../lib/core/person-service.js';
import { recallForQuery, sanitizeRecallQuery } from '../lib/core/recall-service.js';
import { orchestrateRecall } from '../lib/core/orchestrator.js';
import { makeTempWorkspace, makeConfigObject, openDb } from '../tests/helpers.js';

const NOW = new Date().toISOString();
const RUNS = Math.max(3, Number(process.env.GB_DEEP_EVAL_RUNS || 7) || 7);
const RUN_STAMP = NOW.replace(/[:.]/g, '-');
const OUTPUT_JSON = path.join(process.cwd(), 'eval', `deep-recall-eval-${RUN_STAMP}.json`);
const OUTPUT_MD = path.join(process.cwd(), 'eval', `deep-recall-eval-${RUN_STAMP}.md`);

const median = (values = []) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
};

const percentile = (values = [], p = 95) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
};

const average = (values = []) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const clean = (value = '') => String(value || '').replace(/\s+/g, ' ').trim();
const lower = (value = '') => clean(value).toLowerCase();
const anyContains = (value = '', needles = []) => needles.some((needle) => lower(value).includes(lower(needle)));

const seedFixture = () => {
  const ws = makeTempWorkspace('gb-v3-deep-eval-');
  const memoryDir = path.join(ws.workspace, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(ws.workspace, 'MEMORY.md'), `
# MEMORY

## Relationship

- Riley is Jordan partner and they live together.
- Jordan prefers winter and treats it as the calmest season.

## Identity

- Atlas is the coding agent identity for this workspace.
`, 'utf8');
  fs.writeFileSync(path.join(memoryDir, '2026-01-15.md'), `
# 2026-01-15

## 08:00 UTC

### CONTEXT
- [m:abc12345-aaaa-bbbb-cccc-1234567890ab] In January 2026, Jordan and Atlas worked on gigabrain architecture.
- [m:def67890-aaaa-bbbb-cccc-1234567890ab] Jordan documented the January recall audit and entity cleanup.
`, 'utf8');
  fs.writeFileSync(path.join(memoryDir, '2026-02-01.md'), `
# 2026-02-01

## 09:00 UTC

### CONTEXT
- Today Jordan planned an intro interview with Tria.
- Today Jordan noted Tria is preparing an investor intro.
`, 'utf8');
  fs.writeFileSync(path.join(memoryDir, '2026-03-14.md'), `
# 2026-03-14

## 12:30 UTC

### CONTEXT
- In March 2026, Jordan completed the vault sync stabilization and memorybench cleanup.
`, 'utf8');
  fs.writeFileSync(path.join(memoryDir, 'whois.md'), `
# whois

- Riley is Jordan partner and has birthday on Nov 6.
- Sam is a close collaborator.
- Alex is part of the active project circle.
`, 'utf8');

  const config = normalizeConfig(makeConfigObject(ws.workspace).plugins.entries.gigabrain.config);
  const maintain = runMaintenance({
    dbPath: ws.dbPath,
    config,
    dryRun: false,
    runId: 'run-deep-eval-maint',
    reviewVersion: 'rv-deep-eval-maint',
  });
  if (!maintain?.ok) throw new Error('maintenance failed during deep eval fixture setup');

  const db = openDb(ws.dbPath);
  db.prepare(`
    INSERT INTO memory_current (
      memory_id, type, content, normalized, normalized_hash, source, confidence, scope, status, value_score, value_label, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'capture', ?, ?, 'active', ?, 'core', ?, ?)
  `);

  const insert = db.prepare(`
    INSERT INTO memory_current (
      memory_id, type, content, normalized, normalized_hash, source, confidence, scope, status, value_score, value_label, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'capture', ?, ?, 'active', ?, 'core', ?, ?)
  `);

  const rows = [
    ['m-novara-instruction', 'CONTEXT', 'Add to profile: Novara is Jordan partner and birthday Nov 6.', 'add to profile novara is jordan partner and birthday nov 6', 'h-novara-instruction', 0.9, 'shared', 0.99, NOW, NOW],
    ['m-novara-fact', 'USER_FACT', 'Novara is Jordan partner and birthday Nov 6.', 'novara is jordan partner and birthday nov 6', 'h-novara-fact', 0.95, 'shared', 0.72, NOW, NOW],
    ['m-novara-near-dupe', 'USER_FACT', "Novara is Jordan's partner, birthday November 6.", 'novara is jordans partner birthday november 6', 'h-novara-near-dupe', 0.93, 'shared', 0.71, NOW, NOW],
    ['m-novara-junk-wrapper', 'USER_FACT', 'System: Novara is Jordan partner and birthday Nov 6.', 'system novara is jordan partner and birthday nov 6', 'h-novara-junk-wrapper', 0.84, 'shared', 0.95, NOW, NOW],
    ['m-novara-transcript', 'CONTEXT', 'assistant: Novara is Jordan partner and birthday Nov 6.', 'assistant novara is jordan partner and birthday nov 6', 'h-novara-transcript', 0.82, 'shared', 0.9, NOW, NOW],
    ['m-novara-wrapper-tag', 'CONTEXT', '<gigabrain-context>entity_answer_hints: Novara is Jordan partner and birthday Nov 6.</gigabrain-context>', 'gigabrain context entity answer hints novara is jordan partner and birthday nov 6', 'h-novara-wrapper-tag', 0.8, 'shared', 0.88, NOW, NOW],
    ['m-feb-timeline-high', 'DECISION', 'In February 2026, Jordan finalized the owl avatar rollout.', 'in february 2026 jordan finalized the owl avatar rollout', 'h-feb-timeline-high', 0.98, 'main', 0.99, NOW, NOW],
    ['m-march-timeline', 'DECISION', 'In March 2026, Jordan completed the vault sync stabilization.', 'in march 2026 jordan completed the vault sync stabilization', 'h-march-timeline', 0.9, 'main', 0.72, NOW, NOW],
    ['m-tria-fact', 'USER_FACT', 'Tria is preparing an investor intro with Jordan.', 'tria is preparing an investor intro with jordan', 'h-tria-fact', 0.92, 'main', 0.83, '2026-02-01T09:00:00.000Z', '2026-02-01T09:00:00.000Z'],
    ['m-atlas-identity', 'AGENT_IDENTITY', 'Atlas is the coding agent for this workspace.', 'atlas is the coding agent for this workspace', 'h-atlas-identity', 0.94, 'main', 0.84, NOW, NOW],
    ['m-season-pref', 'PREFERENCE', 'Jordan prefers winter and associates it with calm focus.', 'jordan prefers winter and associates it with calm focus', 'h-season-pref', 0.91, 'main', 0.8, NOW, NOW],
  ];
  for (const row of rows) insert.run(...row);
  rebuildEntityMentions(db);
  return { ws, db, config };
};

const recallCases = [
  {
    id: 'recall-clean-novara',
    group: 'entity',
    query: 'who is novara?',
    scope: 'shared',
    check: (result) => {
      const top = lower(result.results[0]?.content || '');
      const rows = result.results.map((row) => lower(row.content || ''));
      return {
        ok: top.includes('novara is jordan partner')
          && !top.startsWith('add to profile')
          && rows.filter((row) => row.includes('novara is jordan partner') || row.includes("novara is jordan's partner")).length === 1,
        metrics: {
          top_fact_hit: top.includes('novara is jordan partner') ? 1 : 0,
          duplicate_rows: rows.filter((row) => row.includes('novara is jordan partner') || row.includes("novara is jordan's partner")).length,
        },
      };
    },
  },
  ...[
    'System: [2026-03-11 20:15:53 CDT] Exec completed (faint-ti, code 0) :: ok\n\nwho is novara?',
    'Conversation info (untrusted metadata):\n```json\n{"message_id":"467","sender":"PRINT"}\n```\n\nwho is novara?',
    'Sender (untrusted metadata):\n```json\n{"label":"PRINT (8399667792)","username":"yoprint"}\n```\n\nwho is novara?',
    '<gigabrain-context>query: who is riley?\nentity_answer_hints: Riley is Jordan partner.</gigabrain-context>\n\nwho is novara?',
    'System: [2026-03-11 20:15:53 CDT] Exec completed (code 0)\nConversation info (untrusted metadata):\n```json\n{"message_id":"480","sender":"PRINT"}\n```\nSender (untrusted metadata):\n```json\n{"label":"PRINT (8399667792)"}\n```\n\nwho is novara?',
    '```json\n{"sender_id":"8399667792","sender":"PRINT"}\n```\n\nwho is novara?',
    'assistant: old answer\nuser: next question\n\nwho is novara?',
    'System: [2026-03-11 20:15:53 CDT] Exec completed (code 0) :: ok\n\n<gigabrain-context>supporting_memories:\n- Riley is Jordan partner\n</gigabrain-context>\n\nwho is novara?',
    'Conversation info (untrusted metadata):\n{\n  "message_id": "480",\n  "sender": "PRINT"\n}\n\nwho is novara?',
    'Sender (untrusted metadata):\n{\n  "label": "PRINT (8399667792)"\n}\n\nwho is novara?',
    'System: [2026-03-11] Exec completed\n\nSender (untrusted metadata):\n```json\n{"label":"PRINT"}\n```\n\nConversation info (untrusted metadata):\n```json\n{"message_id":"480"}\n```\n\nwho is novara?',
  ].map((query, index) => ({
    id: `recall-noisy-novara-${index + 1}`,
    group: 'sanitization',
    query,
    scope: 'shared',
    check: (result) => {
      const top = lower(result.results[0]?.content || '');
      const sanitized = clean(result.query || '');
      return {
        ok: sanitized === 'who is novara?'
          && top.includes('novara is jordan partner')
          && !top.startsWith('add to profile'),
        metrics: {
          sanitized_exact: sanitized === 'who is novara?' ? 1 : 0,
          top_fact_hit: top.includes('novara is jordan partner') ? 1 : 0,
        },
      };
    },
  })),
  {
    id: 'recall-shared-riley-privacy',
    group: 'privacy',
    query: 'wer ist riley?',
    scope: 'shared',
    check: (result) => ({
      ok: result.results.every((row) => String(row.source_kind || '') !== 'memory_md'),
      metrics: {
        memory_md_leaks: result.results.some((row) => String(row.source_kind || '') === 'memory_md') ? 1 : 0,
      },
    }),
  },
  {
    id: 'recall-january-native',
    group: 'temporal',
    query: 'What happened in January 2026 with gigabrain?',
    scope: 'main',
    check: (result) => ({
      ok: result.results.some((row) => String(row._source || '') === 'native' && String(row.source_date || '').startsWith('2026-01')),
      metrics: {
        january_native_hit: result.results.some((row) => String(row._source || '') === 'native' && String(row.source_date || '').startsWith('2026-01')) ? 1 : 0,
      },
    }),
  },
  {
    id: 'recall-march-specificity',
    group: 'temporal',
    query: 'What happened in March 2026?',
    scope: 'main',
    check: (result) => ({
      ok: lower(result.results[0]?.content || '').includes('march 2026')
        && !result.results.some((row) => lower(row.content || '').includes('february 2026')),
      metrics: {
        top_march_hit: lower(result.results[0]?.content || '').includes('march 2026') ? 1 : 0,
        february_leak: result.results.some((row) => lower(row.content || '').includes('february 2026')) ? 1 : 0,
      },
    }),
  },
  {
    id: 'recall-tria-provenance-hidden',
    group: 'provenance',
    query: 'what do we know about tria?',
    scope: 'main',
    check: (result) => {
      const injection = String(result.injection || '');
      return {
        ok: !injection.includes('src=')
          && injection.includes('Recorded on 2026-02-01; any relative dates in this memory refer to that date.'),
        metrics: {
          provenance_leak: injection.includes('src=') ? 1 : 0,
          stale_relative_marker: injection.includes('Recorded on 2026-02-01; any relative dates in this memory refer to that date.') ? 1 : 0,
        },
      };
    },
  },
  {
    id: 'recall-atlas-identity',
    group: 'identity',
    query: 'what do you know about yourself atlas',
    scope: 'main',
    check: (result) => ({
      ok: result.results.some((row) => lower(row.content || '').includes('atlas is the coding agent')),
      metrics: {
        atlas_identity_hit: result.results.some((row) => lower(row.content || '').includes('atlas is the coding agent')) ? 1 : 0,
      },
    }),
  },
  {
    id: 'recall-season-preference',
    group: 'preference',
    query: 'welche jahreszeit magst du',
    scope: 'main',
    check: (result) => ({
      ok: result.results.some((row) => anyContains(row.content || '', ['winter', 'calm focus'])),
      metrics: {
        season_hit: result.results.some((row) => anyContains(row.content || '', ['winter', 'calm focus'])) ? 1 : 0,
      },
    }),
  },
  {
    id: 'recall-novara-injection-clean',
    group: 'dedupe_quality',
    query: 'wer ist novara?',
    scope: 'shared',
    check: (result) => {
      const injection = lower(result.injection || '');
      const hints = injection.split('entity_answer_hints:')[1]?.split('\nmemories:')[0] || '';
      return {
        ok: hints.includes('novara is jordan partner and birthday nov 6.')
          && !hints.includes('add to profile: novara is jordan partner and birthday nov 6.')
          && !hints.includes('system: novara is jordan partner and birthday nov 6.')
          && !hints.includes('assistant: novara is jordan partner and birthday nov 6.'),
        metrics: {
          instruction_leak: hints.includes('add to profile: novara is jordan partner and birthday nov 6.') ? 1 : 0,
          junk_wrapper_leak: hints.includes('system: novara is jordan partner and birthday nov 6.') ? 1 : 0,
          transcript_leak: hints.includes('assistant: novara is jordan partner and birthday nov 6.') ? 1 : 0,
        },
      };
    },
  },
];

const orchestratorCases = [
  {
    id: 'orch-entity-brief',
    group: 'orchestrator',
    query: 'wer ist riley?',
    scope: 'shared',
    check: (result) => ({
      ok: result.strategy === 'entity_brief' && result.deepLookupAllowed === false && String(result.rankingMode || '').includes('entity_brief'),
      metrics: {
        strategy_ok: result.strategy === 'entity_brief' ? 1 : 0,
        deep_lookup_ok: result.deepLookupAllowed === false ? 1 : 0,
      },
    }),
  },
  {
    id: 'orch-timeline-brief',
    group: 'orchestrator',
    query: 'What happened in March 2026?',
    scope: 'main',
    check: (result) => ({
      ok: result.strategy === 'timeline_brief' && Boolean(result.temporalWindow),
      metrics: {
        strategy_ok: result.strategy === 'timeline_brief' ? 1 : 0,
        temporal_window_ok: result.temporalWindow ? 1 : 0,
      },
    }),
  },
  {
    id: 'orch-verification-lookup',
    group: 'orchestrator',
    query: 'Show me the exact source for Tria',
    scope: 'main',
    check: (result) => ({
      ok: result.strategy === 'verification_lookup' && result.deepLookupAllowed === true && result.deepLookupReason === 'source_request',
      metrics: {
        strategy_ok: result.strategy === 'verification_lookup' ? 1 : 0,
        deep_lookup_ok: result.deepLookupAllowed === true ? 1 : 0,
        reason_ok: result.deepLookupReason === 'source_request' ? 1 : 0,
      },
    }),
  },
  {
    id: 'orch-sanitized-noisy-query',
    group: 'orchestrator',
    query: 'Conversation info (untrusted metadata):\n```json\n{"message_id":"480","sender":"PRINT"}\n```\n\nwho is novara?',
    scope: 'shared',
    check: (result) => ({
      ok: clean(result.query || '') === 'who is novara?' && result.strategy === 'entity_brief',
      metrics: {
        sanitized_exact: clean(result.query || '') === 'who is novara?' ? 1 : 0,
        strategy_ok: result.strategy === 'entity_brief' ? 1 : 0,
      },
    }),
  },
];

const executeCase = ({ id, group, query, scope, check, kind }, runner) => {
  const latencies = [];
  const failures = [];
  const aggregateMetrics = {};
  for (let runIndex = 0; runIndex < RUNS; runIndex += 1) {
    const started = performance.now();
    const result = runner(query, scope);
    const latencyMs = performance.now() - started;
    latencies.push(latencyMs);
    const outcome = check(result);
    for (const [key, value] of Object.entries(outcome.metrics || {})) {
      aggregateMetrics[key] = (aggregateMetrics[key] || 0) + Number(value || 0);
    }
    if (!outcome.ok) {
      failures.push({ run: runIndex + 1, query: clean(result.query || query), preview: clean(result.results?.[0]?.content || result.injection || '').slice(0, 220), strategy: result.strategy || null, deepLookupAllowed: result.deepLookupAllowed ?? null });
    }
  }
  return {
    id,
    kind,
    group,
    runs: RUNS,
    passed: failures.length === 0,
    failedRuns: failures.length,
    passRate: (RUNS - failures.length) / RUNS,
    latencies,
    latency: {
      min: Math.min(...latencies),
      max: Math.max(...latencies),
      mean: average(latencies),
      median: median(latencies),
      p95: percentile(latencies, 95),
    },
    metrics: aggregateMetrics,
    failures,
  };
};

const summarizeGroup = (results = []) => {
  const latencies = results.flatMap((item) => item.latencies);
  const totalRuns = results.reduce((sum, item) => sum + item.runs, 0);
  const failedRuns = results.reduce((sum, item) => sum + item.failedRuns, 0);
  return {
    cases: results.length,
    totalRuns,
    passedCases: results.filter((item) => item.passed).length,
    failedRuns,
    runPassRate: totalRuns ? (totalRuns - failedRuns) / totalRuns : 1,
    casePassRate: results.length ? results.filter((item) => item.passed).length / results.length : 1,
    latency: {
      mean: average(latencies),
      median: median(latencies),
      p95: percentile(latencies, 95),
      max: latencies.length ? Math.max(...latencies) : 0,
    },
  };
};

const toMarkdown = (report) => {
  const lines = [];
  lines.push('# Gigabrain deep recall eval — 2026-03-11');
  lines.push('');
  lines.push('## Summary');
  lines.push(`- runs per case: ${report.runsPerCase}`);
  lines.push(`- total cases: ${report.summary.totalCases}`);
  lines.push(`- total invocations: ${report.summary.totalRuns}`);
  lines.push(`- passed cases: ${report.summary.passedCases}/${report.summary.totalCases}`);
  lines.push(`- case pass rate: ${(report.summary.casePassRate * 100).toFixed(1)}%`);
  lines.push(`- invocation pass rate: ${(report.summary.runPassRate * 100).toFixed(1)}%`);
  lines.push(`- recall latency median/p95: ${report.summary.latency.median.toFixed(2)}ms / ${report.summary.latency.p95.toFixed(2)}ms`);
  lines.push(`- orchestrator latency median/p95: ${report.summary.orchestratorLatency.median.toFixed(2)}ms / ${report.summary.orchestratorLatency.p95.toFixed(2)}ms`);
  lines.push('');
  lines.push('## Key metrics');
  for (const [key, value] of Object.entries(report.scoreboard)) {
    lines.push(`- ${key}: ${value}`);
  }
  lines.push('');
  lines.push('## By group');
  for (const [group, info] of Object.entries(report.groups)) {
    lines.push(`- ${group}: ${info.passedCases}/${info.cases} cases, ${(info.casePassRate * 100).toFixed(1)}% case pass, ${(info.runPassRate * 100).toFixed(1)}% invocation pass, p95 ${info.latency.p95.toFixed(2)}ms`);
  }
  const failing = report.results.filter((item) => !item.passed);
  lines.push('');
  lines.push('## Failures');
  if (!failing.length) {
    lines.push('- none');
  } else {
    for (const item of failing) {
      lines.push(`- ${item.id}: ${item.failedRuns}/${item.runs} failed runs`);
      for (const failure of item.failures.slice(0, 3)) {
        lines.push(`  - run ${failure.run}: ${failure.preview}`);
      }
    }
  }
  return `${lines.join('\n')}\n`;
};

const main = async () => {
  const { db, config } = seedFixture();
  try {
    const recallResults = recallCases.map((testCase) => executeCase({ ...testCase, kind: 'recall' }, (query, scope) => recallForQuery({ db, config, query, scope })));
    const orchestratorResults = orchestratorCases.map((testCase) => executeCase({ ...testCase, kind: 'orchestrator' }, (query, scope) => orchestrateRecall({ db, config, query, scope })));
    const results = [...recallResults, ...orchestratorResults];
    const recallOnly = results.filter((item) => item.kind === 'recall');
    const orchestratorOnly = results.filter((item) => item.kind === 'orchestrator');
    const latencies = results.flatMap((item) => item.latencies);
    const recallLatencies = recallOnly.flatMap((item) => item.latencies);
    const orchestratorLatencies = orchestratorOnly.flatMap((item) => item.latencies);
    const groups = Object.fromEntries(
      [...new Set(results.map((item) => item.group))]
        .sort()
        .map((group) => [group, summarizeGroup(results.filter((item) => item.group === group))]),
    );

    const metricSum = (key) => results.reduce((sum, item) => sum + Number(item.metrics[key] || 0), 0);
    const countRecallNoisy = recallCases.filter((item) => item.group === 'sanitization').length * RUNS;
    const countRecallDedupe = recallCases.filter((item) => item.group === 'dedupe_quality').length * RUNS;
    const countOrch = orchestratorCases.length * RUNS;
    const report = {
      generatedAt: new Date().toISOString(),
      runsPerCase: RUNS,
      summary: {
        totalCases: results.length,
        totalRuns: results.reduce((sum, item) => sum + item.runs, 0),
        passedCases: results.filter((item) => item.passed).length,
        casePassRate: results.filter((item) => item.passed).length / results.length,
        runPassRate: (results.reduce((sum, item) => sum + item.runs, 0) - results.reduce((sum, item) => sum + item.failedRuns, 0)) / results.reduce((sum, item) => sum + item.runs, 0),
        latency: {
          mean: average(recallLatencies),
          median: median(recallLatencies),
          p95: percentile(recallLatencies, 95),
          max: recallLatencies.length ? Math.max(...recallLatencies) : 0,
        },
        orchestratorLatency: {
          mean: average(orchestratorLatencies),
          median: median(orchestratorLatencies),
          p95: percentile(orchestratorLatencies, 95),
          max: orchestratorLatencies.length ? Math.max(...orchestratorLatencies) : 0,
        },
        allLatency: {
          mean: average(latencies),
          median: median(latencies),
          p95: percentile(latencies, 95),
          max: latencies.length ? Math.max(...latencies) : 0,
        },
      },
      scoreboard: {
        sanitization_exact_rate: `${metricSum('sanitized_exact')}/${countRecallNoisy + RUNS} (${(((metricSum('sanitized_exact')) / (countRecallNoisy + RUNS)) || 0) * 100}% )`,
        top_fact_hit_rate: `${metricSum('top_fact_hit')}/${(1 + recallCases.filter((item) => item.group === 'sanitization').length) * RUNS}`,
        duplicate_leak_rows_total: metricSum('duplicate_rows') - RUNS,
        instruction_leaks: metricSum('instruction_leak'),
        junk_wrapper_leaks: metricSum('junk_wrapper_leak'),
        transcript_leaks: metricSum('transcript_leak'),
        memory_md_privacy_leaks: metricSum('memory_md_leaks'),
        provenance_leaks: metricSum('provenance_leak'),
        temporal_january_hits: metricSum('january_native_hit'),
        temporal_march_top_hits: metricSum('top_march_hit'),
        temporal_february_leaks: metricSum('february_leak'),
        stale_relative_markers: metricSum('stale_relative_marker'),
        orchestrator_strategy_checks: `${metricSum('strategy_ok')}/${countOrch}`,
        orchestrator_deep_lookup_checks: `${metricSum('deep_lookup_ok')}/${countOrch}`,
      },
      groups,
      results,
    };

    fs.writeFileSync(OUTPUT_JSON, JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(OUTPUT_MD, toMarkdown(report), 'utf8');
    console.log(JSON.stringify({ ok: true, json: OUTPUT_JSON, md: OUTPUT_MD, summary: report.summary, scoreboard: report.scoreboard }, null, 2));
  } finally {
    db.close();
  }
};

await main();
