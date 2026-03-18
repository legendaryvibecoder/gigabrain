import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { makeConfigObject, makeTempWorkspace, writeConfigFile } from './helpers.js';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const runNode = (args) => {
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`command failed: ${args.join(' ')}\n${result.stderr || result.stdout}`);
  }
  return result;
};

const run = async () => {
  const ws = makeTempWorkspace('gb-v6-eval-tools-');
  writeConfigFile(ws.configPath, makeConfigObject(ws.workspace));

  const casesPath = path.join(ws.root, 'cases.jsonl');
  fs.writeFileSync(casesPath, [
    JSON.stringify({
      query: 'who is riley?',
      scope: 'shared',
      category: 'entity',
      expected: ['Riley is Jordan partner'],
    }),
    JSON.stringify({
      query: 'what happened in january 2026?',
      scope: 'main',
      category: 'temporal',
      expected: ['January 2026'],
    }),
  ].join('\n') + '\n', 'utf8');

  const baselinePath = path.join(ws.root, 'baseline.json');
  const candidatePath = path.join(ws.root, 'candidate.json');

  runNode(['scripts/eval-runner.js', '--config', ws.configPath, '--mode', 'golden', '--cases', casesPath, '--out', baselinePath]);
  runNode(['scripts/eval-runner.js', '--config', ws.configPath, '--mode', 'golden', '--cases', casesPath, '--out', candidatePath]);

  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  assert.equal(baseline.aggregate.case_count, 2, 'eval-runner should emit the canonical case_count aggregate');
  assert.equal(Object.prototype.hasOwnProperty.call(baseline.aggregate, 'precision_at_3'), true, 'eval-runner should emit machine-safe aggregate precision keys');
  assert.equal(Object.prototype.hasOwnProperty.call(baseline.aggregate, 'mrr'), true, 'eval-runner should emit canonical aggregate MRR');
  assert.equal(Object.prototype.hasOwnProperty.call(baseline.aggregate, 'latency_p95_ms'), true, 'eval-runner should emit latency percentiles');

  const compareResult = runNode(['scripts/eval-compare.js', '--baseline', baselinePath, '--candidate', candidatePath]);
  const compareJson = JSON.parse(String(compareResult.stdout || '{}'));
  assert.equal(compareJson.summary.verdict, 'neutral', 'identical eval reports should compare as neutral');
  assert.equal(Object.prototype.hasOwnProperty.call(compareJson.aggregate_deltas, 'precision_at_3'), true, 'eval-compare should consume the same canonical aggregate keys');
  assert.equal(Object.prototype.hasOwnProperty.call(compareJson.aggregate_deltas, 'hit_rate'), true, 'eval-compare should compare canonical hit_rate values');
};

export { run };
