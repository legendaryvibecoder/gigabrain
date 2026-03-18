import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeConfig } from '../lib/core/config.js';
import { runMaintenance } from '../lib/core/maintenance-service.js';
import { runAudit, runAuditRestore } from '../lib/core/audit-service.js';
import { openDb, makeConfigObject, makeTempWorkspace, seedMemoryCurrent, getStatusCounts, assertFileExists, writeConfigFile } from './helpers.js';

const run = async () => {
  const ws = makeTempWorkspace('gb-v3-int-maintain-');
  const openclaw = makeConfigObject(ws.workspace);
  openclaw.plugins.entries.gigabrain.config.vault = {
    enabled: true,
    path: 'obsidian-vault',
    subdir: 'Gigabrain',
    clean: true,
  };
  openclaw.plugins.entries.gigabrain.config.dedupe.autoThreshold = 0.96;
  openclaw.plugins.entries.gigabrain.config.dedupe.reviewThreshold = 0.3;
  openclaw.plugins.entries.gigabrain.config.dedupe.thresholdsByType = {
    DECISION: {
      auto: 0.96,
      review: 0.3,
    },
  };
  openclaw.plugins.entries.gigabrain.config.dedupe.autoResolvePendingDays = 7;
  openclaw.plugins.entries.gigabrain.config.runtime.reviewQueueRetention = {
    enabled: true,
    keepPendingOnly: false,
    requireExcerptForPending: true,
    maxRows: 2000,
    maxPendingRows: 600,
    maxNonPendingRows: 600,
    maxPendingAgeDays: 60,
  };
  writeConfigFile(ws.configPath, openclaw);
  const config = normalizeConfig(openclaw.plugins.entries.gigabrain.config);
  fs.writeFileSync(
    path.join(ws.workspace, 'MEMORY.md'),
    '# MEMORY\n\n## Preferences\n\n- Jordan prefers pour-over coffee.\n',
    'utf8',
  );

  const db = openDb(ws.dbPath);
  try {
    seedMemoryCurrent(db, [
      { type: 'PREFERENCE', content: 'User likes Mozzarella', scope: 'shared', confidence: 0.72 },
      { type: 'AGENT_IDENTITY', content: 'I am Atlas and I evolve over time', scope: 'profile:main', confidence: 0.74 },
      {
        memory_id: 'native-dup-existing',
        type: 'PREFERENCE',
        content: 'Jordan prefers pour-over coffee.',
        scope: 'profile:main',
        confidence: 0.93,
        value_score: 0.82,
        value_label: 'core',
      },
      { type: 'CONTEXT', content: '<working_memory>tmp wrapper</working_memory>', scope: 'shared', confidence: 0.6 },
      { type: 'CONTEXT', content: 'run script deploy.sh every night', scope: 'shared', confidence: 0.45 },
      { memory_id: 'protected-ops', type: 'CONTEXT', content: 'run script deploy.sh every night', scope: 'shared', confidence: 0.41, tags: ['protected'] },
      { type: 'DECISION', content: 'Use markdown headings for weekly release notes', scope: 'shared', confidence: 0.63 },
      {
        memory_id: 'dup-keep',
        type: 'DECISION',
        content: 'Decision: release notes should include exact dates, exact commands, and next steps.',
        scope: 'shared',
        confidence: 0.92,
        value_score: 0.95,
        value_label: 'core',
        created_at: '2026-03-10T10:00:00.000Z',
        updated_at: '2026-03-10T10:00:00.000Z',
        tags: ['protected'],
      },
      {
        memory_id: 'dup-drop',
        type: 'DECISION',
        content: 'Decision: release notes should include exact dates, commands, and next steps.',
        scope: 'shared',
        confidence: 0.7,
        value_score: 0.91,
        value_label: 'core',
        created_at: '2026-03-09T10:00:00.000Z',
        updated_at: '2026-03-09T10:00:00.000Z',
      },
      {
        memory_id: 'timeout-keep',
        type: 'DECISION',
        content: 'Important decision: user prefers release notes with exact dates, exact commands, and concrete next steps.',
        scope: 'main',
        confidence: 0.96,
        value_score: 0.96,
        value_label: 'core',
        created_at: '2026-03-06T09:00:00.000Z',
        updated_at: '2026-03-06T09:00:00.000Z',
        tags: ['protected'],
      },
      {
        memory_id: 'timeout-drop',
        type: 'DECISION',
        content: 'Important decision: user prefers release notes with exact dates, exact commands, and clear next steps.',
        scope: 'main',
        confidence: 0.68,
        value_score: 0.9,
        value_label: 'core',
        created_at: '2026-03-05T09:00:00.000Z',
        updated_at: '2026-03-05T09:00:00.000Z',
      },
    ]);
  } finally {
    db.close();
  }
  fs.mkdirSync(path.dirname(config.runtime.paths.reviewQueuePath), { recursive: true });
  fs.writeFileSync(config.runtime.paths.reviewQueuePath, [
    {
      timestamp: '2026-02-20T09:00:00.000Z',
      queued_at: '2026-02-20T09:00:00.000Z',
      status: 'pending',
      reason: 'semantic_borderline',
      queued_reason: 'semantic_borderline',
      reason_code: 'duplicate_semantic',
      similarity: 0.78,
      memory_id: 'timeout-drop',
      matched_memory_id: 'timeout-keep',
      winner_memory_id: 'timeout-keep',
      loser_memory_id: 'timeout-drop',
      payload: {
        excerpt: 'Important decision: user prefers release notes with exact dates, exact commands, and clear next steps.',
        matched_excerpt: 'Important decision: user prefers release notes with exact dates, exact commands, and concrete next steps.',
      },
    },
    {
      timestamp: '2026-03-13T09:00:00.000Z',
      queued_at: '2026-03-13T09:00:00.000Z',
      status: 'pending',
      reason: 'semantic_borderline',
      queued_reason: 'semantic_borderline',
      reason_code: 'duplicate_semantic',
      similarity: 0.61,
      memory_id: 'dup-drop',
      matched_memory_id: 'dup-keep',
      winner_memory_id: 'dup-keep',
      loser_memory_id: 'dup-drop',
      payload: {
        excerpt: 'Decision: release notes should include exact dates, commands, and next steps.',
        matched_excerpt: 'Decision: release notes should include exact dates, exact commands, and next steps.',
      },
    },
  ].map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');

  const maintain = runMaintenance({
    dbPath: ws.dbPath,
    config,
    dryRun: false,
    reviewVersion: 'rv-maintain-int',
    runId: 'run-maintain-int',
    configPath: ws.configPath,
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
  const artifact = JSON.parse(fs.readFileSync(maintain.artifacts.executionArtifactPath, 'utf8'));
  assert.equal(Number(artifact?.eval?.aggregate?.case_count || 0) > 0, true, 'nightly artifact should include eval metrics');
  assert.equal(Number(artifact?.recall_latency?.count || 0) > 0, true, 'nightly artifact should include recall latency stats');
  assert.equal(typeof artifact?.counts?.graph_node_count, 'number', 'nightly artifact should include graph node counts');
  assert.equal(typeof artifact?.fts_rebuild?.ok, 'boolean', 'nightly artifact should report FTS rebuild status explicitly');
  assert.equal(Boolean(artifact?.artifacts?.eval_report_path), true, 'nightly artifact should reference the eval report');
  assertFileExists(artifact.artifacts.eval_report_path, 'eval nightly report');
  assertFileExists(maintain.artifacts.vaultBuildReportPath, 'vault build report');
  assertFileExists(maintain.artifacts.surfaceSummaryPath, 'surface summary');
  assertFileExists(path.join(ws.memoryRoot, 'graph.db'), 'graph db');
  assertFileExists(path.join(config.vault.path, config.vault.subdir, 'vault-index.md'), 'vault index');
  assertFileExists(path.join(config.vault.path, config.vault.subdir, '00 Home', 'Home.md'), 'vault home note');
  assertFileExists(path.join(config.vault.path, config.vault.subdir, '40 Reports', 'vault-manifest.json'), 'vault manifest');
  const protectedCheckDb = openDb(ws.dbPath);
  try {
    const protectedRow = protectedCheckDb.prepare('SELECT status FROM memory_current WHERE memory_id = ?').get('protected-ops');
    const timeoutArchived = protectedCheckDb.prepare('SELECT status FROM memory_current WHERE memory_id = ?').get('timeout-drop');
    const timeoutWinner = protectedCheckDb.prepare('SELECT status FROM memory_current WHERE memory_id = ?').get('timeout-keep');
    const nativeDuplicateCount = protectedCheckDb.prepare(`
      SELECT COUNT(*) AS c
      FROM memory_current
      WHERE scope = 'profile:main'
        AND status = 'active'
        AND normalized = 'jordan prefers pour over coffee'
    `).get();
    const linkedNativeDuplicateChunks = protectedCheckDb.prepare(`
      SELECT COUNT(*) AS c
      FROM memory_native_chunks
      WHERE linked_memory_id IS NOT NULL
        AND normalized = 'jordan prefers pour over coffee'
    `).get();
    const evalHistory = protectedCheckDb.prepare('SELECT case_count, precision_at_3, latency_p95_ms FROM memory_eval_history ORDER BY run_date DESC LIMIT 1').get();
    assert.equal(protectedRow?.status, 'active', 'protected memories should survive maintenance');
    assert.equal(timeoutArchived?.status, 'archived', 'timed-out semantic dedupe should archive the stored loser only');
    assert.equal(timeoutWinner?.status, 'active', 'timed-out semantic dedupe should keep the stored winner active');
    assert.equal(Number(nativeDuplicateCount?.c || 0), 1, 'nightly maintenance should leave exactly one active promoted/native duplicate in the profile scope');
    assert.equal(Number(linkedNativeDuplicateChunks?.c || 0) >= 1, true, 'nightly maintenance should still link the surviving native duplicate chunk');
    assert.equal(Number(evalHistory?.case_count || 0) > 0, true, 'nightly eval should persist a memory_eval_history row');
    assert.equal(Number(evalHistory?.precision_at_3 || 0) >= 0, true, 'nightly eval history should store precision_at_3');
    assert.equal(Number(evalHistory?.latency_p95_ms || 0) >= 0, true, 'nightly eval history should store latency p95');
  } finally {
    protectedCheckDb.close();
  }
  const queueRows = fs.readFileSync(config.runtime.paths.reviewQueuePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const queuedBorderline = queueRows.find((row) => row.loser_memory_id === 'dup-drop');
  const autoResolvedRow = queueRows.find((row) => row.loser_memory_id === 'timeout-drop');
  assert.equal(Boolean(queuedBorderline), true, 'borderline semantic duplicates should persist a pending review queue row');
  assert.equal(queuedBorderline.status, 'pending', 'new borderline rows should remain pending for review');
  assert.equal(queuedBorderline.winner_memory_id, 'dup-keep', 'pending queue rows should store the computed winner');
  assert.equal(queuedBorderline.loser_memory_id, 'dup-drop', 'pending queue rows should store the computed loser');
  assert.equal(Boolean(queuedBorderline?.payload?.excerpt), true, 'pending queue rows should keep an excerpt for retention and review');
  assert.equal(Boolean(autoResolvedRow), true, 'timed-out queue rows should remain auditable when retention keeps non-pending rows');
  assert.equal(autoResolvedRow.status, 'resolved_auto', 'timed-out queue rows should be marked resolved_auto');
  assert.equal(autoResolvedRow.auto_resolved, true, 'timed-out queue rows should record auto_resolved');
  assert.equal(autoResolvedRow.resolved_reason, 'pending_timeout_7d', 'timed-out queue rows should record the timeout reason');
  const usageLogAfterMaintain = fs.readFileSync(config.maintenance.usageLogPath, 'utf8');
  assert.equal(usageLogAfterMaintain.includes('recall_latency:'), true, 'usage log should include recall latency summaries');

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

  const dbBeforeLlmFallback = openDb(ws.dbPath);
  const llmCountsBefore = getStatusCounts(dbBeforeLlmFallback);
  dbBeforeLlmFallback.close();

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
  const dbAfterLlmFallback = openDb(ws.dbPath);
  const llmCountsAfter = getStatusCounts(dbAfterLlmFallback);
  const llmLedgerCount = Number(dbAfterLlmFallback.prepare(`
    SELECT COUNT(*) AS c
    FROM memory_quality_reviews
    WHERE review_version = ?
  `).get('rv-llm-fallback-int')?.c || 0);
  dbAfterLlmFallback.close();
  assert.deepEqual(llmCountsAfter, llmCountsBefore, 'shadow audit with LLM failures should not mutate live memory statuses');
  assert.equal(llmLedgerCount, llmFallback.rows, 'shadow audit should persist a complete review ledger for the finished run, not a partial intermediate state');

  const fingerprintConfig = normalizeConfig({
    ...config,
    policy: {
      ...(config.policy || {}),
      archiveThreshold: Number(config?.policy?.archiveThreshold ?? 0.25) + 0.05,
    },
  });
  const fingerprintRerun = await runAudit({
    dbPath: ws.dbPath,
    config: fingerprintConfig,
    mode: 'shadow',
    reviewVersion: auditVersion,
    runId: 'run-audit-fingerprint-int',
    llm: { enabled: false, provider: 'none' },
  });
  assert.equal(fingerprintRerun.ok, true, 'audit should still succeed when rerun with a changed config fingerprint');
  assert.equal(fingerprintRerun.rows >= 1, true, 'audit idempotency should not skip a reused review version when material thresholds changed');
};

export { run };
