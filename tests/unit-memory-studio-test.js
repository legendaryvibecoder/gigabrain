import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  getMemoryStudioPreset,
  getAllowedCoreFiles,
  compareReportCards,
  canPromoteMain30,
  findUnexpectedMutations,
  extractReportCard,
} from '../bench/memorybench/memory-studio-lib.js';

const run = async () => {
  const dev12 = getMemoryStudioPreset('dev12');
  const main30 = getMemoryStudioPreset('main30');

  assert.equal(dev12.samplePerCategory, 2, 'dev12 should use 2 questions per category');
  assert.equal(dev12.expectedQuestionIds.length, 12, 'dev12 should pin 12 question ids');
  assert.equal(main30.samplePerCategory, 5, 'main30 should use 5 questions per category');
  assert.equal(main30.expectedQuestionIds.length, 30, 'main30 should pin 30 question ids');

  const allowed = getAllowedCoreFiles();
  assert.deepEqual(allowed, [
    'lib/core/capture-service.js',
    'lib/core/recall-service.js',
    'lib/core/world-model.js',
  ]);

  const betterAccuracy = compareReportCards(
    { accuracy: 0.3, mrr: 0.2, hitAtK: 0.1, latencyMs: 15000 },
    { accuracy: 0.2, mrr: 0.9, hitAtK: 0.9, latencyMs: 1 }
  );
  assert.equal(betterAccuracy.decision, 'better');
  assert.equal(betterAccuracy.decisiveMetric, 'accuracy');

  const betterLatency = compareReportCards(
    { accuracy: 0.2, mrr: 0.2, hitAtK: 0.1, latencyMs: 12000 },
    { accuracy: 0.2, mrr: 0.2, hitAtK: 0.1, latencyMs: 14000 }
  );
  assert.equal(betterLatency.decision, 'better');
  assert.equal(betterLatency.decisiveMetric, 'latencyMs');

  const promotion = canPromoteMain30(
    { accuracy: 0.2, singleSessionPreferenceAccuracy: 0.6 },
    { accuracy: 0.2, singleSessionPreferenceAccuracy: 0.6 }
  );
  assert.equal(promotion.accepted, true, 'matching main30 scores should be promotable');

  const blockedPromotion = canPromoteMain30(
    { accuracy: 0.25, singleSessionPreferenceAccuracy: 0.4 },
    { accuracy: 0.2, singleSessionPreferenceAccuracy: 0.6 }
  );
  assert.equal(blockedPromotion.accepted, false, 'preference regression should block promotion');

  const unexpected = findUnexpectedMutations(
    [
      'lib/core/capture-service.js',
      'bench/memorybench/data/memory-studio/ledger.jsonl',
      'README.md',
    ],
    allowed
  );
  assert.deepEqual(unexpected, ['README.md'], 'runtime files should be ignored, docs should not');

  const card = extractReportCard({
    summary: { accuracy: 0.2 },
    retrieval: { hitAtK: 0.4, mrr: 0.3 },
    latency: { total: { mean: 14000 } },
    byQuestionType: {
      'single-session-preference': { accuracy: 0.6 },
    },
  });
  assert.deepEqual(card, {
    accuracy: 0.2,
    hitAtK: 0.4,
    mrr: 0.3,
    latencyMs: 14000,
    singleSessionPreferenceAccuracy: 0.6,
  });

  const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  const championPath = path.join(repoRoot, 'bench', 'memorybench', 'data', 'memory-studio', 'champion.json');
  const unsafeDefaultRun = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts', 'memory-studio-autoloop.js'),
    '--dry-run',
    '--max-experiments', '1',
    '--max-minutes', '1',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.notEqual(unsafeDefaultRun.status, 0, 'autoloop should refuse the main repo by default');
  assert.match(
    unsafeDefaultRun.stderr || unsafeDefaultRun.stdout,
    /--force-clean|--allow-repo-workspace|disposable git clone/i,
    'autoloop failure should explain the new safety guardrails',
  );

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-autoloop-safe-'));
  const workspaceRoot = path.join(tempRoot, 'workspace');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(path.join(workspaceRoot, 'README.md'), '# temp workspace\n', 'utf8');
  let git = spawnSync('git', ['init'], { cwd: workspaceRoot, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr || git.stdout);
  git = spawnSync('git', ['config', 'user.name', 'Codex Test'], { cwd: workspaceRoot, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr || git.stdout);
  git = spawnSync('git', ['config', 'user.email', 'codex@example.com'], { cwd: workspaceRoot, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr || git.stdout);
  git = spawnSync('git', ['add', 'README.md'], { cwd: workspaceRoot, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr || git.stdout);
  git = spawnSync('git', ['commit', '-m', 'seed'], { cwd: workspaceRoot, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr || git.stdout);

  const hadChampion = fs.existsSync(championPath);
  const originalChampion = hadChampion ? fs.readFileSync(championPath, 'utf8') : '';
  fs.mkdirSync(path.dirname(championPath), { recursive: true });
  if (!hadChampion) {
    fs.writeFileSync(championPath, `${JSON.stringify({ provisional: true, entries: {} }, null, 2)}\n`, 'utf8');
  }

  try {
    const safeRun = spawnSync(process.execPath, [
      path.join(repoRoot, 'scripts', 'memory-studio-autoloop.js'),
      '--workspace', workspaceRoot,
      '--dry-run',
      '--force-clean',
      '--max-experiments', '1',
      '--max-minutes', '1',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    assert.equal(safeRun.status, 0, safeRun.stderr || safeRun.stdout);
    const jsonStart = safeRun.stdout.lastIndexOf('\n{');
    const safeJson = JSON.parse((jsonStart >= 0 ? safeRun.stdout.slice(jsonStart + 1) : safeRun.stdout).trim());
    assert.equal(safeJson.ok, true, 'autoloop should run in dry-run mode for a disposable git workspace');
  } finally {
    if (hadChampion) {
      fs.writeFileSync(championPath, originalChampion, 'utf8');
    } else {
      fs.rmSync(championPath, { force: true });
    }
  }
};

export { run };
