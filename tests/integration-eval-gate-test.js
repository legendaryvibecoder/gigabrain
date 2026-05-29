import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDeepRecallEval, loadEvalBaseline } from '../eval/run-deep-recall-eval.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Hard CI gate over the existing deep-recall harness. It rides the required
// `test` job (npm test → tests/run-all.js), so a recall-quality regression or a
// memory leak fails CI like any other test. The harness is deterministic
// (lexical recall + orchestrator over an in-fixture corpus, no embeddings /
// Ollama / network), so it behaves identically in CI and locally.
const run = async () => {
  const baselinePath = path.join(ROOT, 'eval', 'baseline.json');
  assert.ok(fs.existsSync(baselinePath), 'eval/baseline.json is committed');

  const baseline = loadEvalBaseline();
  assert.ok(Number.isFinite(baseline.minCasePassRate), 'baseline provides a numeric minCasePassRate');
  assert.ok(baseline.minCasePassRate > 0 && baseline.minCasePassRate <= 1, 'minCasePassRate is a sane rate in (0,1]');

  const report = await runDeepRecallEval({ writeFiles: false, log: false });
  assert.ok(report.summary.totalCases > 0, 'eval ran at least one case');

  // Quality floor.
  assert.ok(
    report.summary.casePassRate >= baseline.minCasePassRate,
    `deep-recall case pass rate ${report.summary.casePassRate.toFixed(4)} dropped below baseline ${baseline.minCasePassRate} `
      + `(${report.summary.passedCases}/${report.summary.totalCases})`,
  );

  // Hard security/quality ceilings: leak counts must not exceed the committed max.
  for (const [key, value] of Object.entries(baseline)) {
    if (!key.startsWith('max_')) continue;
    const metric = key.slice(4);
    const actual = Number(report.scoreboard[metric] || 0);
    assert.ok(
      actual <= value,
      `deep-recall scoreboard.${metric} = ${actual} exceeds baseline ceiling ${value}`,
    );
  }

  console.log(
    `eval-gate: casePassRate ${report.summary.casePassRate.toFixed(4)} >= ${baseline.minCasePassRate} `
    + `(${report.summary.passedCases}/${report.summary.totalCases}); leak ceilings ok`,
  );
};

export { run };
