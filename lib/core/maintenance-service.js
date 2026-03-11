import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

import { appendEvent } from './event-store.js';
import {
  ensureProjectionStore,
  listCurrentMemories,
  materializeProjectionFromMemories,
  rebuildFTS5,
  updateCurrentStatus,
} from './projection-store.js';
import {
  classifyValue,
  jaccardSimilarity,
  normalizeContent,
  resolvePolicy,
  resolveSemanticThresholds,
} from './policy.js';
import { ensureNativeStore, syncNativeMemory, renderNativeSyncMarkdown } from './native-sync.js';
import { promoteNativeChunks } from './native-promotion.js';
import { ensurePersonStore, rebuildEntityMentions } from './person-service.js';
import { appendQueueRow, applyQueueRetention } from './review-queue.js';
import { buildVaultSurface, renderVaultBuildMarkdown } from './vault-mirror.js';
import { ensureWorldModelStore, rebuildWorldModel } from './world-model.js';
import {
  captureSnapshotMetrics,
  renderUsageLogEntry,
} from './metrics.js';
import { openDatabase } from './sqlite.js';

const DAILY_SEQUENCE = Object.freeze([
  'snapshot',
  'native_sync',
  'native_promotion',
  'quality_sweep',
  'exact_dedupe',
  'semantic_dedupe',
  'entity_refresh',
  'belief_refresh',
  'episode_refresh',
  'open_loop_refresh',
  'contradiction_detection',
  'synthesis_build',
  'briefing_build',
  'audit_delta',
  'archive_compression',
  'vacuum',
  'metrics_report',
  'vault_build',
  'graph_build',
]);

const nowStamp = () => new Date().toISOString().replace(/[:.]/g, '-');
const resolveArtifactOutputDir = (outputDir, dryRun) => (
  dryRun ? path.join(outputDir, 'previews') : outputDir
);

const ensureDir = (dirPath) => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const ensureFileDir = (filePath) => {
  ensureDir(path.dirname(filePath));
};

const appendJsonl = (filePath, row) => {
  if (!filePath) return;
  ensureFileDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
};

const appendUsageLog = (filePath, text) => {
  if (!filePath) return;
  ensureFileDir(filePath);
  fs.appendFileSync(filePath, text, 'utf8');
};

const copyIfExists = (source, target) => {
  if (!source || !target) return false;
  if (!fs.existsSync(source)) return false;
  ensureFileDir(target);
  fs.copyFileSync(source, target);
  return true;
};

const scorePriority = (row) => {
  const confidence = Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0;
  const updated = Date.parse(String(row.updated_at || row.created_at || '')) || 0;
  return confidence + (updated / 1e14);
};

const parseTags = (value) => {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean);
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    if (Array.isArray(parsed)) return parsed.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean);
  } catch {
    // ignore malformed tags and fall back to empty
  }
  return [];
};

const isProtectedMemory = (row = {}) => parseTags(row.tags).includes('protected');

const protectionAwarePriority = (row) => scorePriority(row) + (isProtectedMemory(row) ? 100 : 0);

const pruneBackups = ({
  snapshotDir,
  compactDays,
  emergencyDays,
  maxEmergencyFiles,
}) => {
  ensureDir(snapshotDir);
  const entries = fs.readdirSync(snapshotDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const filePath = path.join(snapshotDir, entry.name);
      const stat = fs.statSync(filePath);
      return {
        name: entry.name,
        path: filePath,
        mtime: stat.mtimeMs,
      };
    });
  const nowMs = Date.now();
  const compactCutoff = nowMs - (Math.max(1, compactDays) * 24 * 60 * 60 * 1000);
  const emergencyCutoff = nowMs - (Math.max(1, emergencyDays) * 24 * 60 * 60 * 1000);

  const compact = entries.filter((entry) => entry.name.includes('compact'));
  const emergency = entries.filter((entry) => entry.name.includes('emergency'));
  let pruned = 0;

  for (const entry of compact) {
    if (entry.mtime < compactCutoff) {
      fs.unlinkSync(entry.path);
      pruned += 1;
    }
  }
  const emergencySorted = [...emergency].sort((a, b) => b.mtime - a.mtime);
  let keptEmergency = 0;
  for (const entry of emergencySorted) {
    const tooOld = entry.mtime < emergencyCutoff;
    const overLimit = keptEmergency >= Math.max(1, maxEmergencyFiles);
    if (tooOld || overLimit) {
      fs.unlinkSync(entry.path);
      pruned += 1;
      continue;
    }
    keptEmergency += 1;
  }
  return { pruned };
};

const writeArchiveCompression = ({
  workspaceRoot,
  rows,
  runId,
  dryRun = false,
}) => {
  const prefix = dryRun ? 'archive-summary-dry-run' : 'archive-summary';
  const filePath = path.join(workspaceRoot, 'memory', `${prefix}-${new Date().toISOString().slice(0, 10)}.md`);
  ensureFileDir(filePath);
  const lines = [];
  lines.push('# Archive Summary');
  lines.push('');
  lines.push(`- run_id: \`${runId}\``);
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- entries: ${rows.length}`);
  lines.push('');
  for (const row of rows.slice(0, 200)) {
    lines.push(`- [${row.memory_id}] (${row.type}/${row.scope}) ${String(row.content || '').trim()}`);
  }
  lines.push('');
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
};

const writeExecutionArtifact = ({
  outputDir,
  dateKey,
  payload,
}) => {
  ensureDir(outputDir);
  const filePath = path.join(outputDir, `nightly-execution-${dateKey}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return filePath;
};

const csvCell = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;

const writeArchivedOrKilledArtifacts = ({
  outputDir,
  dateKey,
  rows,
}) => {
  ensureDir(outputDir);
  const mdPath = path.join(outputDir, `memory-archived-or-killed-${dateKey}.md`);
  const jsonlPath = path.join(outputDir, `memory-archived-or-killed-${dateKey}.jsonl`);
  const csvPath = path.join(outputDir, `memory-archived-or-killed-${dateKey}.csv`);

  const byKey = new Map();
  if (fs.existsSync(jsonlPath)) {
    const existing = fs.readFileSync(jsonlPath, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of existing) {
      try {
        const row = JSON.parse(line);
        const key = `${String(row?.memory_id || '')}|${String(row?.after_status || '')}`;
        if (key !== '|') byKey.set(key, row);
      } catch {
        // Ignore malformed historical lines and continue forward.
      }
    }
  }
  for (const row of (Array.isArray(rows) ? rows : [])) {
    const key = `${String(row?.memory_id || '')}|${String(row?.after_status || '')}`;
    if (key !== '|') byKey.set(key, row);
  }
  const list = Array.from(byKey.values());
  const md = [];
  md.push('# Archived Or Killed Memories');
  md.push('');
  md.push(`- generated_at: ${new Date().toISOString()}`);
  md.push(`- rows: ${list.length}`);
  md.push('');
  for (const row of list) {
    md.push(`## ${String(row.after_status || 'unknown').toUpperCase()} - ${row.memory_id}`);
    md.push(`- type: ${row.type}`);
    md.push(`- scope: ${row.scope}`);
    md.push(`- reason_codes: ${(row.reason_codes || []).join(', ') || '(none)'}`);
    if (Number.isFinite(Number(row.similarity))) md.push(`- similarity: ${Number(row.similarity).toFixed(4)}`);
    if (row.matched_memory_id) md.push(`- matched_memory_id: ${row.matched_memory_id}`);
    md.push(`- content: ${String(row.content || '').trim()}`);
    md.push('');
  }
  fs.writeFileSync(mdPath, `${md.join('\n')}\n`, 'utf8');

  const jsonl = list.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(jsonlPath, jsonl ? `${jsonl}\n` : '', 'utf8');

  const csv = [];
  csv.push([
    'memory_id',
    'type',
    'scope',
    'before_status',
    'after_status',
    'reason_codes',
    'similarity',
    'matched_memory_id',
    'content',
  ].map(csvCell).join(','));
  for (const row of list) {
    csv.push([
      row.memory_id,
      row.type,
      row.scope,
      row.before_status,
      row.after_status,
      Array.isArray(row.reason_codes) ? row.reason_codes.join('|') : '',
      Number.isFinite(Number(row.similarity)) ? Number(row.similarity).toFixed(4) : '',
      row.matched_memory_id || '',
      row.content || '',
    ].map(csvCell).join(','));
  }
  fs.writeFileSync(csvPath, `${csv.join('\n')}\n`, 'utf8');

  return {
    mdPath,
    jsonlPath,
    csvPath,
  };
};

const writeKeptArtifact = ({
  outputDir,
  dateKey,
  rows,
}) => {
  ensureDir(outputDir);
  const filePath = path.join(outputDir, `memory-kept-${dateKey}.md`);
  const list = Array.isArray(rows) ? rows : [];
  const lines = [];
  lines.push('# Kept Memories');
  lines.push('');
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- rows: ${list.length}`);
  lines.push('');
  for (const row of list) {
    lines.push(`- [${row.memory_id}] (${row.type}/${row.scope}) ${String(row.content || '').trim()}`);
  }
  lines.push('');
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');
  return filePath;
};

const queueReview = (queuePath, row, options = {}) => {
  if (!queuePath) return;
  if (options?.dryRun === true) return;
  appendQueueRow(queuePath, row, {
    applyRetention: false,
  });
};

const withTransaction = (db, fn) => {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
};

const runMaintenance = ({
  dbPath,
  config,
  configPath = '',
  dryRun = false,
  runId = '',
  reviewVersion = '',
}) => {
  const resolvedRunId = String(runId || `maintain-${nowStamp()}`);
  const cleanupVersion = String(config?.runtime?.cleanupVersion || 'v3.0.0');
  const workspaceRoot = String(config?.runtime?.paths?.workspaceRoot || process.cwd());
  const outputDir = String(config?.runtime?.paths?.outputDir || path.join(workspaceRoot, 'output'));
  const artifactOutputDir = resolveArtifactOutputDir(outputDir, dryRun);
  const snapshotDir = String(config?.maintenance?.snapshotDir || path.join(workspaceRoot, 'memory', 'backups'));
  const eventsPath = String(config?.maintenance?.eventsPath || path.join(workspaceRoot, 'output', 'memory-events.jsonl'));
  const usageLogPath = String(config?.maintenance?.usageLogPath || path.join(workspaceRoot, 'memory', 'usage-log.md'));
  const queuePath = String(config?.runtime?.paths?.reviewQueuePath || path.join(workspaceRoot, 'output', 'memory-review-queue.jsonl'));

  ensureDir(outputDir);
  ensureDir(artifactOutputDir);
  ensureDir(snapshotDir);
  ensureFileDir(eventsPath);
  ensureFileDir(usageLogPath);
  ensureFileDir(queuePath);

  const db = openDatabase(dbPath);
  const eventCounts = {
    quality_archived: 0,
    quality_rejected: 0,
    dedupe_exact_archived: 0,
    dedupe_semantic_archived: 0,
    dedupe_semantic_review_queue: 0,
    queue_rows_pruned: 0,
    queue_malformed_rows: 0,
    native_sync_changed_files: 0,
    native_sync_inserted_chunks: 0,
    native_promoted_inserted: 0,
    native_promoted_linked_existing: 0,
    vault_build_copied_files: 0,
    vault_build_removed_files: 0,
    entity_mentions_rebuilt: 0,
    world_model_entities: 0,
    world_model_beliefs: 0,
    world_model_episodes: 0,
    world_model_open_loops: 0,
    world_model_contradictions: 0,
    world_model_syntheses: 0,
    snapshots_created: 0,
    backups_pruned: 0,
  };

  try {
    ensureProjectionStore(db);
    ensureNativeStore(db);
    ensurePersonStore(db);
    ensureWorldModelStore(db);
    const projectionCount = db.prepare('SELECT COUNT(*) AS c FROM memory_current').get()?.c || 0;
    if (Number(projectionCount) === 0) {
      materializeProjectionFromMemories(db);
    }
    const policy = resolvePolicy(config);
    const startedAt = new Date().toISOString();

    const emit = (event) => {
      const row = appendEvent(db, {
        ...event,
        cleanup_version: cleanupVersion,
        run_id: resolvedRunId,
        review_version: String(reviewVersion || ''),
      });
      appendJsonl(eventsPath, row);
      return row;
    };

    emit({
      timestamp: startedAt,
      component: 'maintenance',
      action: 'maintenance_start',
      reason_codes: ['scheduled'],
      memory_id: `run:${resolvedRunId}`,
      payload: {
        sequence: DAILY_SEQUENCE,
        dryRun,
      },
    });

    const preMetrics = captureSnapshotMetrics(db, dbPath);

    const emergencySnapshot = path.join(snapshotDir, `registry-emergency-${nowStamp()}.sqlite`);
    if (!dryRun && copyIfExists(dbPath, emergencySnapshot)) {
      eventCounts.snapshots_created += 1;
    }

    const changedForArchiveSummary = [];
    const archivedOrKilledRows = [];
    const nowIso = new Date().toISOString();
    const dateKey = nowIso.slice(0, 10);

    const nativeSyncSummary = syncNativeMemory({
      db,
      config,
      dryRun,
    });
    eventCounts.native_sync_changed_files = Number(nativeSyncSummary.changed_files || 0);
    eventCounts.native_sync_inserted_chunks = Number(nativeSyncSummary.inserted_chunks || 0);
    emit({
      timestamp: nowIso,
      component: 'maintenance',
      action: 'native_sync',
      reason_codes: ['complete'],
      memory_id: `run:${resolvedRunId}`,
      payload: nativeSyncSummary,
    });

    const nativePromotionSummary = promoteNativeChunks({
      db,
      config,
      sourcePaths: nativeSyncSummary.changed_sources || [],
      dryRun,
    });
    eventCounts.native_promoted_inserted = Number(nativePromotionSummary.promoted_inserted || 0);
    eventCounts.native_promoted_linked_existing = Number(nativePromotionSummary.linked_existing || 0);
    emit({
      timestamp: nowIso,
      component: 'maintenance',
      action: 'native_promotion',
      reason_codes: [eventCounts.native_promoted_inserted > 0 || eventCounts.native_promoted_linked_existing > 0 ? 'complete' : 'noop'],
      memory_id: `run:${resolvedRunId}`,
      payload: nativePromotionSummary,
    });

    withTransaction(db, () => {
      const activeRows = listCurrentMemories(db, { statuses: ['active'], limit: 200000 });
      for (const row of activeRows) {
        if (isProtectedMemory(row)) {
          continue;
        }
        const result = classifyValue(row, policy);
        if (result.action === 'archive') {
          if (!dryRun) {
            updateCurrentStatus(db, row.memory_id, 'archived', {
              value_score: result.value_score,
              value_label: result.value_label,
              timestamp: nowIso,
              last_reviewed_at: nowIso,
            });
          }
          changedForArchiveSummary.push(row);
          archivedOrKilledRows.push({
            memory_id: String(row.memory_id),
            type: String(row.type || ''),
            scope: String(row.scope || ''),
            before_status: String(row.status || 'active'),
            after_status: 'archived',
            reason_codes: result.reason_codes || [],
            similarity: null,
            matched_memory_id: null,
            content: String(row.content || ''),
          });
          eventCounts.quality_archived += 1;
          emit({
            timestamp: nowIso,
            component: 'maintenance',
            action: 'quality_archive',
            reason_codes: result.reason_codes,
            memory_id: String(row.memory_id),
            payload: {
              score: result.value_score,
              label: result.value_label,
            },
          });
        } else if (result.action === 'reject') {
          if (!dryRun) {
            updateCurrentStatus(db, row.memory_id, 'rejected', {
              value_score: result.value_score,
              value_label: result.value_label,
              timestamp: nowIso,
              last_reviewed_at: nowIso,
            });
          }
          archivedOrKilledRows.push({
            memory_id: String(row.memory_id),
            type: String(row.type || ''),
            scope: String(row.scope || ''),
            before_status: String(row.status || 'active'),
            after_status: 'rejected',
            reason_codes: result.reason_codes || [],
            similarity: null,
            matched_memory_id: null,
            content: String(row.content || ''),
          });
          eventCounts.quality_rejected += 1;
          emit({
            timestamp: nowIso,
            component: 'maintenance',
            action: 'quality_reject',
            reason_codes: result.reason_codes,
            memory_id: String(row.memory_id),
            payload: {
              score: result.value_score,
              label: result.value_label,
            },
          });
        }
      }
    });

    withTransaction(db, () => {
      const rows = listCurrentMemories(db, { statuses: ['active'], limit: 200000 });
      const groups = new Map();
      for (const row of rows) {
        const key = `${String(row.scope || 'shared')}|${normalizeContent(row.normalized || row.content || '')}`;
        if (!key.endsWith('|')) {
          const list = groups.get(key) || [];
          list.push(row);
          groups.set(key, list);
        }
      }
      for (const list of groups.values()) {
        if (!list || list.length <= 1) continue;
        const sorted = [...list].sort((a, b) => protectionAwarePriority(b) - protectionAwarePriority(a));
        const winner = sorted[0];
        for (const loser of sorted.slice(1)) {
          if (isProtectedMemory(loser)) continue;
          if (!dryRun) {
            updateCurrentStatus(db, loser.memory_id, 'archived', {
              value_label: 'archive_candidate',
              timestamp: nowIso,
            });
          }
          archivedOrKilledRows.push({
            memory_id: String(loser.memory_id),
            type: String(loser.type || ''),
            scope: String(loser.scope || ''),
            before_status: String(loser.status || 'active'),
            after_status: 'archived',
            reason_codes: ['duplicate_exact'],
            similarity: 1,
            matched_memory_id: String(winner.memory_id),
            content: String(loser.content || ''),
          });
          eventCounts.dedupe_exact_archived += 1;
          emit({
            timestamp: nowIso,
            component: 'maintenance',
            action: 'dedupe_exact_archive',
            reason_codes: ['duplicate_exact'],
            memory_id: String(loser.memory_id),
            matched_memory_id: String(winner.memory_id),
            payload: {
              winner_id: String(winner.memory_id),
            },
          });
        }
      }
    });

    withTransaction(db, () => {
      const rows = listCurrentMemories(db, { statuses: ['active'], limit: 200000 });
      const archivedInRun = new Set();
      for (let i = 0; i < rows.length; i += 1) {
        const a = rows[i];
        if (archivedInRun.has(String(a.memory_id))) continue;
        for (let j = i + 1; j < rows.length; j += 1) {
          const b = rows[j];
          if (String(a.scope || 'shared') !== String(b.scope || 'shared')) continue;
          if (String(a.type || 'CONTEXT') !== String(b.type || 'CONTEXT')) continue;
          if (archivedInRun.has(String(b.memory_id))) continue;
          const similarity = jaccardSimilarity(a.content || a.normalized || '', b.content || b.normalized || '');
          const semanticThresholds = resolveSemanticThresholds(a.type, config);
          if (similarity >= Number(semanticThresholds.auto)) {
            const loser = protectionAwarePriority(a) >= protectionAwarePriority(b) ? b : a;
            const winner = loser.memory_id === a.memory_id ? b : a;
            if (isProtectedMemory(loser)) continue;
            archivedInRun.add(String(loser.memory_id));
            if (!dryRun) {
              updateCurrentStatus(db, loser.memory_id, 'archived', {
                value_label: 'archive_candidate',
                timestamp: nowIso,
              });
            }
            archivedOrKilledRows.push({
              memory_id: String(loser.memory_id),
              type: String(loser.type || ''),
              scope: String(loser.scope || ''),
              before_status: String(loser.status || 'active'),
              after_status: 'archived',
              reason_codes: ['duplicate_semantic'],
              similarity,
              matched_memory_id: String(winner.memory_id),
              content: String(loser.content || ''),
            });
            eventCounts.dedupe_semantic_archived += 1;
            emit({
              timestamp: nowIso,
              component: 'maintenance',
              action: 'dedupe_semantic_archive',
              reason_codes: ['duplicate_semantic'],
              memory_id: String(loser.memory_id),
              matched_memory_id: String(winner.memory_id),
              similarity,
              payload: {
                winner_id: String(winner.memory_id),
              },
            });
          } else if (similarity >= Number(semanticThresholds.review)) {
            eventCounts.dedupe_semantic_review_queue += 1;
            queueReview(queuePath, {
              timestamp: nowIso,
              status: 'auto_rejected',
              reason: 'semantic_borderline',
              reason_code: 'duplicate_semantic',
              similarity,
              memory_id: String(a.memory_id),
              matched_memory_id: String(b.memory_id),
            }, {
              dryRun,
            });
            emit({
              timestamp: nowIso,
              component: 'maintenance',
              action: 'dedupe_semantic_review_queue',
              reason_codes: ['duplicate_semantic'],
              memory_id: String(a.memory_id),
              matched_memory_id: String(b.memory_id),
              similarity,
            });
          }
        }
      }
    });

    const queueRetention = applyQueueRetention(
      queuePath,
      config?.runtime?.reviewQueueRetention,
      { dryRun },
    );
    eventCounts.queue_rows_pruned = Number(queueRetention?.dropped_rows || 0);
    eventCounts.queue_malformed_rows = Number(queueRetention?.malformed_rows || 0);
    emit({
      timestamp: nowIso,
      component: 'maintenance',
      action: 'review_queue_retention',
      reason_codes: ['queue_retention'],
      memory_id: `run:${resolvedRunId}`,
      payload: queueRetention,
    });

    rebuildEntityMentions(db);
    eventCounts.entity_mentions_rebuilt = 1;

    if (config?.worldModel?.enabled !== false) {
      const worldModelSummary = rebuildWorldModel({ db, config, now: nowIso });
      eventCounts.world_model_entities = Number(worldModelSummary?.counts?.entities || 0);
      eventCounts.world_model_beliefs = Number(worldModelSummary?.counts?.beliefs || 0);
      eventCounts.world_model_episodes = Number(worldModelSummary?.counts?.episodes || 0);
      eventCounts.world_model_open_loops = Number(worldModelSummary?.counts?.open_loops || 0);
      eventCounts.world_model_contradictions = Number(worldModelSummary?.counts?.contradictions || 0);
      eventCounts.world_model_syntheses = Number(worldModelSummary?.counts?.syntheses || 0);
      emit({
        timestamp: nowIso,
        component: 'maintenance',
        action: 'world_model_refresh',
        reason_codes: ['complete'],
        memory_id: `run:${resolvedRunId}`,
        payload: worldModelSummary,
      });
    }

    const archiveSummaryPath = writeArchiveCompression({
      workspaceRoot,
      rows: changedForArchiveSummary,
      runId: resolvedRunId,
      dryRun,
    });
    const nativeSyncReportPath = path.join(artifactOutputDir, `memory-native-sync-${dateKey}.md`);
    fs.writeFileSync(nativeSyncReportPath, renderNativeSyncMarkdown({
      timestamp: nowIso,
      runId: resolvedRunId,
      summary: nativeSyncSummary,
    }), 'utf8');
    const archivedArtifacts = writeArchivedOrKilledArtifacts({
      outputDir: artifactOutputDir,
      dateKey,
      rows: archivedOrKilledRows,
    });
    const keptRows = listCurrentMemories(db, { statuses: ['active'], limit: 300000 });
    const keptArtifactPath = writeKeptArtifact({
      outputDir: artifactOutputDir,
      dateKey,
      rows: keptRows,
    });

    if (!dryRun && config?.maintenance?.vacuum !== false) {
      db.exec('VACUUM');
    }
    try { rebuildFTS5(db); } catch { /* FTS5 optional */ }

    const compactSnapshot = path.join(snapshotDir, `registry-compact-${nowStamp()}.sqlite`);
    if (!dryRun && copyIfExists(dbPath, compactSnapshot)) {
      eventCounts.snapshots_created += 1;
    }

    const pruned = pruneBackups({
      snapshotDir,
      compactDays: Number(config?.maintenance?.compactDays ?? 30),
      emergencyDays: Number(config?.maintenance?.emergencyUnvacuumedDays ?? 7),
      maxEmergencyFiles: Number(config?.maintenance?.maxEmergencyFiles ?? 1),
    });
    eventCounts.backups_pruned = Number(pruned.pruned || 0);

    const postMetrics = captureSnapshotMetrics(db, dbPath);
    const finishedAt = new Date().toISOString();
    let executionArtifactPath = writeExecutionArtifact({
      outputDir: artifactOutputDir,
      dateKey,
      payload: {
        triggered_at: startedAt,
        started_at: startedAt,
        finished_at: finishedAt,
        run_id: resolvedRunId,
        trigger_source: 'gigabrainctl-nightly',
        sequence: DAILY_SEQUENCE,
        cleanup_version: cleanupVersion,
        dry_run: dryRun,
        counts: eventCounts,
        artifacts: {
          archive_summary_path: archiveSummaryPath,
          native_sync_report_path: nativeSyncReportPath,
          archived_or_killed_md: archivedArtifacts.mdPath,
          archived_or_killed_jsonl: archivedArtifacts.jsonlPath,
          archived_or_killed_csv: archivedArtifacts.csvPath,
          kept_md: keptArtifactPath,
          usage_log_path: usageLogPath,
          events_path: eventsPath,
          queue_path: queuePath,
        },
        metrics: postMetrics,
      },
    });

    const vaultBuildSummary = buildVaultSurface({
      db,
      config,
      dryRun,
      runId: resolvedRunId,
      outputPaths: {
        executionArtifactPath,
        nativeSyncReportPath,
      },
    });
    eventCounts.vault_build_copied_files = Number(vaultBuildSummary.copied_files || 0);
    eventCounts.vault_build_removed_files = Number(vaultBuildSummary.removed_files || 0);
    const vaultBuildReportPath = path.join(outputDir, `vault-build-${dateKey}.md`);
    const vaultBuildReportOutputPath = path.join(artifactOutputDir, `vault-build-${dateKey}.md`);
    fs.writeFileSync(vaultBuildReportOutputPath, renderVaultBuildMarkdown({
      timestamp: finishedAt,
      runId: resolvedRunId,
      summary: vaultBuildSummary,
    }), 'utf8');
    executionArtifactPath = writeExecutionArtifact({
      outputDir: artifactOutputDir,
      dateKey,
      payload: {
        triggered_at: startedAt,
        started_at: startedAt,
        finished_at: finishedAt,
        run_id: resolvedRunId,
        trigger_source: 'gigabrainctl-nightly',
        sequence: DAILY_SEQUENCE,
        cleanup_version: cleanupVersion,
        dry_run: dryRun,
        counts: eventCounts,
        artifacts: {
          archive_summary_path: archiveSummaryPath,
          native_sync_report_path: nativeSyncReportPath,
          vault_build_report_path: vaultBuildReportOutputPath,
          vault_root: vaultBuildSummary.vault_root || '',
          surface_summary_path: vaultBuildSummary.surface_summary_path || '',
          archived_or_killed_md: archivedArtifacts.mdPath,
          archived_or_killed_jsonl: archivedArtifacts.jsonlPath,
          archived_or_killed_csv: archivedArtifacts.csvPath,
          kept_md: keptArtifactPath,
          usage_log_path: usageLogPath,
          events_path: eventsPath,
          queue_path: queuePath,
        },
        metrics: postMetrics,
      },
    });
    emit({
      timestamp: finishedAt,
      component: 'maintenance',
      action: 'vault_build',
      reason_codes: [vaultBuildSummary.enabled === true ? 'complete' : 'disabled'],
      memory_id: `run:${resolvedRunId}`,
      payload: {
        copied_files: vaultBuildSummary.copied_files || 0,
        removed_files: vaultBuildSummary.removed_files || 0,
        vault_root: vaultBuildSummary.vault_root || '',
        mirror_root: vaultBuildSummary.mirror_root || '',
        surface_summary_path: vaultBuildSummary.surface_summary_path || '',
        build_report_path: vaultBuildReportOutputPath,
      },
    });

    let graphBuildResult = { ok: false, skipped: true, reason: 'graph_build_not_run' };
    try {
      const graphScript = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'scripts', 'graph-build.js');
      if (fs.existsSync(graphScript)) {
        const graphArgs = [graphScript];
        if (configPath) {
          graphArgs.push('--config', String(configPath));
        }
        const graphOut = execFileSync(process.execPath, graphArgs, {
          timeout: 120000,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const jsonMatch = graphOut.match(/\{[\s\S]*"ok"\s*:\s*true[\s\S]*\}/);
        if (jsonMatch) {
          try {
            graphBuildResult = JSON.parse(jsonMatch[0]);
          } catch {
            graphBuildResult = { ok: true, raw: true };
          }
        } else {
          graphBuildResult = { ok: true, raw: true };
        }
      } else {
        graphBuildResult = { ok: false, skipped: true, reason: 'graph_script_missing' };
      }
    } catch (graphErr) {
      graphBuildResult = {
        ok: false,
        error: String(graphErr?.message || graphErr).slice(0, 200),
      };
    }
    emit({
      timestamp: new Date().toISOString(),
      component: 'maintenance',
      action: 'graph_build',
      reason_codes: [graphBuildResult.ok ? 'complete' : graphBuildResult.skipped ? 'skipped' : 'error'],
      memory_id: `run:${resolvedRunId}`,
      payload: graphBuildResult,
    });

    emit({
      timestamp: finishedAt,
      component: 'maintenance',
      action: 'maintenance_end',
      reason_codes: ['complete'],
      memory_id: `run:${resolvedRunId}`,
      payload: {
        archive_summary_path: archiveSummaryPath,
        native_sync_report_path: nativeSyncReportPath,
        vault_build_report_path: vaultBuildReportOutputPath,
        vault_root: vaultBuildSummary.vault_root || '',
        surface_summary_path: vaultBuildSummary.surface_summary_path || '',
        archived_or_killed_md: archivedArtifacts.mdPath,
        archived_or_killed_jsonl: archivedArtifacts.jsonlPath,
        archived_or_killed_csv: archivedArtifacts.csvPath,
        kept_md: keptArtifactPath,
        execution_artifact_path: executionArtifactPath,
        metrics: postMetrics,
      },
    });

    appendUsageLog(usageLogPath, renderUsageLogEntry({
      timestamp: finishedAt,
      runId: resolvedRunId,
      cleanupVersion,
      sequence: DAILY_SEQUENCE,
      metrics: postMetrics,
      events: eventCounts,
    }));

    return {
      ok: true,
      runId: resolvedRunId,
      cleanupVersion,
      dryRun,
      sequence: DAILY_SEQUENCE,
      snapshots: {
        emergency: emergencySnapshot,
        compact: compactSnapshot,
      },
      artifacts: {
        archiveSummaryPath,
        nativeSyncReportPath,
        vaultBuildReportPath: vaultBuildReportOutputPath,
        vaultMirrorReportPath: vaultBuildReportOutputPath,
        surfaceSummaryPath: vaultBuildSummary.surface_summary_path || '',
        vaultRoot: vaultBuildSummary.vault_root || '',
        archivedOrKilledMdPath: archivedArtifacts.mdPath,
        archivedOrKilledJsonlPath: archivedArtifacts.jsonlPath,
        archivedOrKilledCsvPath: archivedArtifacts.csvPath,
        keptMdPath: keptArtifactPath,
        executionArtifactPath,
        eventsPath,
        usageLogPath,
        queuePath,
      },
      preMetrics,
      postMetrics,
      eventCounts,
    };
  } finally {
    db.close();
  }
};

export {
  DAILY_SEQUENCE,
  runMaintenance,
};
