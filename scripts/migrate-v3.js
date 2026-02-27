#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../lib/core/sqlite.js';

import {
  findDefaultOpenclawConfigPath,
  loadOpenclawConfig,
  normalizeConfig,
  resolveGigabrainConfig,
} from '../lib/core/config.js';
import { appendEvent, ensureEventStore } from '../lib/core/event-store.js';
import {
  ensureProjectionStore,
  listCurrentMemories,
  materializeProjectionFromMemories,
} from '../lib/core/projection-store.js';
import { ensureNativeStore, syncNativeMemory } from '../lib/core/native-sync.js';
import { ensurePersonStore, rebuildEntityMentions } from '../lib/core/person-service.js';

const args = process.argv.slice(2);

const readFlag = (name, fallback = '') => {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1] && !String(args[idx + 1]).startsWith('--')) return args[idx + 1];
  const withEq = args.find((item) => String(item || '').startsWith(`${name}=`));
  if (withEq) return withEq.split('=').slice(1).join('=');
  return fallback;
};

const readBool = (name, fallback = false) => {
  if (args.includes(name)) return true;
  const withEq = args.find((item) => String(item || '').startsWith(`${name}=`));
  if (!withEq) return fallback;
  const raw = String(withEq.split('=').slice(1).join('=')).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
};

const ensureDir = (dirPath) => {
  fs.mkdirSync(path.dirname(dirPath), { recursive: true });
};

const backupFile = (source) => {
  if (!source || !fs.existsSync(source)) return '';
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const target = `${source}.bak.${ts}`;
  ensureDir(target);
  fs.copyFileSync(source, target);
  return target;
};

const mapLegacyToV3 = (legacy = {}, defaults = {}) => {
  const v3 = {
    enabled: legacy.enabled !== false,
    runtime: {
      timezone: 'local',
      cleanupVersion: 'v3.0.0',
      paths: {
        workspaceRoot: legacy?.paths?.workspaceRoot || '',
        memoryRoot: legacy?.paths?.memoryRoot || 'memory',
        registryPath: legacy.memoryRegistryPath || '',
        outputDir: 'output',
        reviewQueuePath: legacy.extractionReviewQueuePath || legacy.memoryReviewQueuePath || 'output/memory-review-queue.jsonl',
      },
    },
    capture: {
      enabled: legacy.captureEnabled !== false,
      requireMemoryNote: true,
      minConfidence: legacy.memoryMinConfidence ?? 0.65,
      minContentChars: legacy.memoryMinContentChars ?? 25,
      queueOnModelUnavailable: true,
    },
    dedupe: {
      exactEnabled: true,
      semanticEnabled: legacy.captureSemanticDedupe !== false,
      autoThreshold: legacy.memorySemanticDedupeAutoThreshold ?? 0.92,
      reviewThreshold: legacy.memorySemanticDedupeReviewThreshold ?? 0.85,
      crossScopeGlobal: legacy.memorySemanticDedupeCrossScopeGlobal === true,
    },
    recall: {
      topK: legacy.recallTopK ?? 8,
      minScore: legacy.recallMinScore ?? 0.45,
      maxTokens: legacy.recallMaxTokens ?? 1200,
      archiveFallbackEnabled: true,
      mode: 'hybrid',
      classBudgets: defaults?.recall?.classBudgets || {
        core: 0.45,
        situational: 0.3,
        decisions: 0.25,
      },
    },
    quality: {
      mode: 'knowledge_rich',
      junkFilterEnabled: legacy.memoryJunkFilterEnabled !== false,
      minContentChars: legacy.memoryMinContentChars ?? 25,
      junkPatternsBase: defaults?.quality?.junkPatternsBase || [],
      junkPatternsAppend: Array.isArray(legacy.memoryJunkPatternsAppend) ? legacy.memoryJunkPatternsAppend : (Array.isArray(legacy.memoryJunkPatterns) ? legacy.memoryJunkPatterns : []),
      junkPatternsReplace: legacy.memoryJunkPatternsReplace === true,
      highValueShortEnabled: legacy.memoryHighValueShortEnabled !== false,
      highValueShortPatternsBase: defaults?.quality?.highValueShortPatternsBase || [],
      highValueShortPatternsAppend: Array.isArray(legacy.memoryHighValueShortPatternsAppend) ? legacy.memoryHighValueShortPatternsAppend : (Array.isArray(legacy.memoryHighValueShortPatterns) ? legacy.memoryHighValueShortPatterns : []),
      durableEnabled: legacy.memoryDurableMemoryEnabled !== false,
      durablePatternsBase: defaults?.quality?.durablePatternsBase || [],
      durablePatternsAppend: Array.isArray(legacy.memoryDurablePatternsAppend) ? legacy.memoryDurablePatternsAppend : (Array.isArray(legacy.memoryDurablePatterns) ? legacy.memoryDurablePatterns : []),
      valueThresholds: {
        keep: legacy?.memoryValueThresholds?.keep ?? 0.75,
        archive: legacy?.memoryValueThresholds?.archive ?? 0.45,
        reject: legacy?.memoryValueThresholds?.reject ?? 0.45,
      },
    },
    llm: {
      provider: legacy?.llm?.provider || (legacy.ollamaUrl ? 'ollama' : 'none'),
      baseUrl: legacy?.llm?.baseUrl || legacy.ollamaUrl || '',
      model: legacy?.llm?.models?.extract || legacy?.llm?.models?.expand || legacy.translationModel || '',
      apiKey: '',
      timeoutMs: 12000,
      review: {
        enabled: legacy.memoryReviewEnabled === true,
        limit: 200,
        minScore: 0.24,
        maxScore: 0.52,
        minConfidence: 0.7,
      },
    },
    maintenance: {
      snapshotDir: 'memory/backups',
      eventsPath: 'output/memory-events.jsonl',
      usageLogPath: 'memory/usage-log.md',
      compactDays: legacy?.backupRetention?.compactDays ?? 30,
      emergencyUnvacuumedDays: legacy?.backupRetention?.emergencyUnvacuumedDays ?? 7,
      maxEmergencyFiles: legacy?.backupRetention?.maxEmergencyFiles ?? 1,
      vacuum: true,
    },
    native: {
      enabled: true,
      memoryMdPath: 'MEMORY.md',
      dailyNotesGlob: 'memory/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*.md',
      includeFiles: [
        'memory/latest.md',
        'memory/recent-changes.md',
        'memory/whois.md',
        'memory/pinned-core-people.md',
        'memory/pinned/core-people.md',
      ],
      excludeGlobs: [
        'memory/archive/**',
        'memory/debug/**',
        'memory/private/**',
        'memory/working.md',
        'memory/*-captured.md',
      ],
      syncMode: 'hybrid',
      maxChunkChars: 900,
      onDemandTemporalDays: 3650,
    },
    person: {
      keepPublicFacts: true,
      relationshipPriorityBoost: 0.35,
      publicProfileBoost: 0.1,
      requireWordBoundaryMatch: true,
    },
  };
  return normalizeConfig(v3);
};

const main = () => {
  const apply = readBool('--apply', false);
  const explicitConfigPath = readFlag('--config', '') || findDefaultOpenclawConfigPath();
  if (!explicitConfigPath) throw new Error('Could not resolve openclaw.json path; pass --config <path>');

  const loaded = loadOpenclawConfig(explicitConfigPath);
  const openclawConfig = loaded.config || {};
  const pluginConfig = resolveGigabrainConfig(openclawConfig);
  const migrated = mapLegacyToV3(pluginConfig);
  const dbPath = path.resolve(readFlag('--db', migrated.runtime.paths.registryPath));
  const rollbackMetaPath = path.resolve(readFlag('--rollback-meta', path.join(migrated.runtime.paths.outputDir, 'gigabrain-v3-rollback-meta.json')));

  const preview = {
    ok: true,
    apply,
    configPath: explicitConfigPath,
    dbPath,
    rollbackMetaPath,
    oldTopLevelKeys: Object.keys(pluginConfig || {}),
    newTopLevelKeys: Object.keys(migrated || {}),
  };

  if (!apply) {
    console.log(JSON.stringify(preview, null, 2));
    return;
  }

  const configBackup = backupFile(explicitConfigPath);
  const dbBackup = backupFile(dbPath);

  if (!openclawConfig.plugins) openclawConfig.plugins = {};
  if (!openclawConfig.plugins.entries) openclawConfig.plugins.entries = {};
  if (!openclawConfig.plugins.entries.gigabrain) openclawConfig.plugins.entries.gigabrain = { enabled: true, config: {} };
  openclawConfig.plugins.entries.gigabrain.config = migrated;
  fs.writeFileSync(explicitConfigPath, JSON.stringify(openclawConfig, null, 2), 'utf8');

  const db = openDatabase(dbPath);
  let projectionImport = 0;
  let backfilledEvents = 0;
  let nativeChangedFiles = 0;
  let nativeInsertedChunks = 0;
  try {
    ensureProjectionStore(db);
    ensureEventStore(db);
    ensureNativeStore(db);
    ensurePersonStore(db);
    const imported = materializeProjectionFromMemories(db);
    projectionImport = Number(imported.imported || 0);
    const eventCount = db.prepare('SELECT COUNT(*) AS c FROM memory_events').get()?.c || 0;
    if (Number(eventCount) === 0) {
      const rows = listCurrentMemories(db, { limit: 300000 });
      db.exec('BEGIN');
      try {
        for (const row of rows) {
          appendEvent(db, {
            timestamp: String(row.updated_at || row.created_at || new Date().toISOString()),
            component: 'migration',
            action: 'migration_backfill_import',
            reason_codes: ['migration_backfill'],
            memory_id: String(row.memory_id),
            cleanup_version: 'v3.0.0',
            run_id: `migrate-${new Date().toISOString().replace(/[:.]/g, '-')}`,
            review_version: '',
            payload: {
              status: row.status,
              scope: row.scope,
              type: row.type,
            },
          });
          backfilledEvents += 1;
        }
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    }
    const nativeSync = syncNativeMemory({
      db,
      config: migrated,
      dryRun: false,
    });
    nativeChangedFiles = Number(nativeSync.changed_files || 0);
    nativeInsertedChunks = Number(nativeSync.inserted_chunks || 0);
    rebuildEntityMentions(db);
  } finally {
    db.close();
  }

  const rollbackMeta = {
    generated_at: new Date().toISOString(),
    configPath: explicitConfigPath,
    dbPath,
    backups: {
      configBackup,
      dbBackup,
    },
    migration: {
      projectionImport,
      backfilledEvents,
      nativeChangedFiles,
      nativeInsertedChunks,
    },
  };
  ensureDir(rollbackMetaPath);
  fs.writeFileSync(rollbackMetaPath, JSON.stringify(rollbackMeta, null, 2), 'utf8');

  console.log(JSON.stringify({
    ...preview,
    migrated: true,
    backups: rollbackMeta.backups,
    projectionImport,
    backfilledEvents,
    nativeChangedFiles,
    nativeInsertedChunks,
  }, null, 2));
};

try {
  main();
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
}
