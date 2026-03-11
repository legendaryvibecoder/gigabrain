import assert from 'node:assert/strict';
import path from 'node:path';

import { normalizeConfig } from '../lib/core/config.js';
import { runMaintenance } from '../lib/core/maintenance-service.js';
import { runAudit, runAuditRestore } from '../lib/core/audit-service.js';
import { openDb, makeConfigObject, makeTempWorkspace, seedMemoryCurrent, getStatusCounts, assertFileExists } from './helpers.js';

const run = async () => {
  const ws = makeTempWorkspace('gb-v3-int-maintain-');
  const openclaw = makeConfigObject(ws.workspace);
  openclaw.plugins.entries.gigabrain.config.vault = {
    enabled: true,
    path: 'obsidian-vault',
    subdir: 'Gigabrain',
    clean: true,
  };
  const config = normalizeConfig(openclaw.plugins.entries.gigabrain.config);

  const db = openDb(ws.dbPath);
  try {
    seedMemoryCurrent(db, [
      { type: 'PREFERENCE', content: 'User likes Mozzarella', scope: 'shared', confidence: 0.72 },
      { type: 'AGENT_IDENTITY', content: 'I am Atlas and I evolve over time', scope: 'profile:main', confidence: 0.74 },
      { type: 'CONTEXT', content: '<working_memory>tmp wrapper</working_memory>', scope: 'shared', confidence: 0.6 },
      { type: 'CONTEXT', content: 'run script deploy.sh every night', scope: 'shared', confidence: 0.45 },
      { memory_id: 'protected-ops', type: 'CONTEXT', content: 'run script deploy.sh every night', scope: 'shared', confidence: 0.41, tags: ['protected'] },
      { type: 'DECISION', content: 'Use markdown headings for weekly release notes', scope: 'shared', confidence: 0.63 },
    ]);
  } finally {
    db.close();
  }

  const maintain = runMaintenance({
    dbPath: ws.dbPath,
    config,
    dryRun: false,
    reviewVersion: 'rv-maintain-int',
    runId: 'run-maintain-int',
  });
  assert.equal(maintain.ok, true);
  assertFileExists(config.maintenance.eventsPath, 'maintenance events');
  assertFileExists(config.maintenance.usageLogPath, 'usage log');
  assertFileExists(path.join(ws.memoryRoot, 'backups'), 'backup dir');
  assertFileExists(maintain.artifacts.nativeSyncReportPath, 'native sync report');
  assertFileExists(maintain.artifacts.archivedOrKilledMdPath, 'archived/killed md');
  assertFileExists(maintain.artifacts.archivedOrKilledJsonlPath, 'archived/killed jsonl');
  assertFileExists(maintain.artifacts.archivedOrKilledCsvPath, 'archived/killed csv');
  assertFileExists(maintain.artifacts.keptMdPath, 'kept md');
  assertFileExists(maintain.artifacts.executionArtifactPath, 'nightly execution artifact');
  assertFileExists(maintain.artifacts.vaultBuildReportPath, 'vault build report');
  assertFileExists(maintain.artifacts.surfaceSummaryPath, 'surface summary');
  assertFileExists(path.join(config.vault.path, config.vault.subdir, 'vault-index.md'), 'vault index');
  assertFileExists(path.join(config.vault.path, config.vault.subdir, '00 Home', 'Home.md'), 'vault home note');
  assertFileExists(path.join(config.vault.path, config.vault.subdir, '40 Reports', 'vault-manifest.json'), 'vault manifest');
  const protectedCheckDb = openDb(ws.dbPath);
  try {
    const protectedRow = protectedCheckDb.prepare('SELECT status FROM memory_current WHERE memory_id = ?').get('protected-ops');
    assert.equal(protectedRow?.status, 'active', 'protected memories should survive maintenance');
  } finally {
    protectedCheckDb.close();
  }

  const maintainDryRun = runMaintenance({
    dbPath: ws.dbPath,
    config,
    dryRun: true,
    reviewVersion: 'rv-maintain-int-dry-run',
    runId: 'run-maintain-int-dry-run',
  });
  assert.equal(maintainDryRun.ok, true);
  assert.equal(maintainDryRun.artifacts.executionArtifactPath.includes(`${path.sep}output${path.sep}previews${path.sep}`), true, 'dry-run execution artifact should live under output/previews');
  assert.equal(maintainDryRun.artifacts.nativeSyncReportPath.includes(`${path.sep}output${path.sep}previews${path.sep}`), true, 'dry-run native sync report should live under output/previews');
  assert.equal(maintainDryRun.artifacts.archivedOrKilledJsonlPath.includes(`${path.sep}output${path.sep}previews${path.sep}`), true, 'dry-run archive artifact should live under output/previews');
  assert.equal(maintainDryRun.artifacts.keptMdPath.includes(`${path.sep}output${path.sep}previews${path.sep}`), true, 'dry-run kept artifact should live under output/previews');
  assert.equal(maintainDryRun.artifacts.vaultBuildReportPath.includes(`${path.sep}output${path.sep}previews${path.sep}`), true, 'dry-run vault build report should live under output/previews');
  assert.equal(maintainDryRun.artifacts.surfaceSummaryPath, '', 'dry-run should not publish a shared surface summary artifact');

  const auditVersion = 'rv-audit-apply-int';
  const dbBeforeApply = openDb(ws.dbPath);
  const countsBeforeApply = getStatusCounts(dbBeforeApply);
  dbBeforeApply.close();

  const apply = await runAudit({
    dbPath: ws.dbPath,
    config,
    mode: 'apply',
    reviewVersion: auditVersion,
    runId: 'run-audit-apply-int',
    llm: { enabled: false, provider: 'none' },
  });
  assert.equal(apply.ok, true);
  assert.equal(apply.mode, 'apply');
  assert.equal(apply.rows >= 1, true);

  const dbAfterApply = openDb(ws.dbPath);
  const countsAfterApply = getStatusCounts(dbAfterApply);
  dbAfterApply.close();
  assert.equal((countsAfterApply.archived || 0) + (countsAfterApply.rejected || 0) >= 1, true, 'apply should mutate some statuses');

  const restored = runAuditRestore({
    dbPath: ws.dbPath,
    reviewVersion: auditVersion,
    runId: 'run-audit-restore-int',
    cleanupVersion: config.runtime.cleanupVersion,
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.restored >= 1, true);

  const dbAfterRestore = openDb(ws.dbPath);
  const countsAfterRestore = getStatusCounts(dbAfterRestore);
  dbAfterRestore.close();
  assert.equal(
    Number(countsAfterRestore.active || 0),
    Number(countsBeforeApply.active || 0),
    'restore should recover pre-apply active count',
  );

  const llmFallback = await runAudit({
    dbPath: ws.dbPath,
    config,
    mode: 'shadow',
    reviewVersion: 'rv-llm-fallback-int',
    runId: 'run-llm-fallback-int',
    llm: {
      enabled: true,
      provider: 'openai_compatible',
      baseUrl: 'http://127.0.0.1:9',
      model: 'mock',
      timeoutMs: 800,
      limit: 10,
      minScore: 0,
      maxScore: 1,
      minConfidence: 0,
    },
  });
  assert.equal(llmFallback.ok, true);
  assert.equal(llmFallback.llmReview.enabled, true);
  assert.equal((llmFallback.llmReview.attempted || 0) >= 1, true, 'LLM fallback run must attempt review');
  assert.equal((llmFallback.llmReview.failed || 0) >= 1, true, 'LLM fallback run should record failed attempts');
};

export { run };
