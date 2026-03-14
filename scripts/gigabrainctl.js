#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/core/sqlite.js';

import { loadResolvedConfig } from '../lib/core/config.js';
import { runMaintenance } from '../lib/core/maintenance-service.js';
import { runAudit, runAuditRestore, runAuditReport } from '../lib/core/audit-service.js';
import { ensureProjectionStore, materializeProjectionFromMemories } from '../lib/core/projection-store.js';
import { captureSnapshotMetrics } from '../lib/core/metrics.js';
import { buildVaultSurface, inspectVaultHealth, loadSurfaceSummary, syncVaultPull } from '../lib/core/vault-mirror.js';
import { orchestrateRecall } from '../lib/core/orchestrator.js';
import { captureFromEvent } from '../lib/core/capture-service.js';
import {
  ensureWorldModelReady,
  getEntityDetail,
  listContradictions,
  listEntities,
  listOpenLoops,
  rebuildWorldModel,
  listSyntheses,
} from '../lib/core/world-model.js';

const THIS_FILE = fileURLToPath(import.meta.url);
const THIS_DIR = path.dirname(THIS_FILE);
const NIGHTLY_LOCK_STALE_MS = 6 * 60 * 60 * 1000;

const HELP = `Gigabrain v3 Control CLI

Usage:
  node scripts/gigabrainctl.js <command> [flags]

Commands:
  nightly      Run one full nightly cycle (maintain + optional harmonize + audit apply)
  maintain     Run maintenance sequence only
  audit        Run audit service (--mode shadow|apply|restore)
  inventory    Print current memory inventory metrics
  doctor       Validate config/db + print health checks
  world        Rebuild or inspect the world-model layer
  control      Apply structured memory actions
  orchestrator Explain how Gigabrain would answer a recall query
  synthesis    Inspect or rebuild synthesis artifacts
  briefing     Print the latest generated briefing artifacts
  review       Inspect contradictions or open loops
  vault        Build/report/doctor/pull the Obsidian memory surface

Examples:
  node scripts/gigabrainctl.js nightly --config ~/.openclaw/openclaw.json
  node scripts/gigabrainctl.js nightly --harmonize
  node scripts/gigabrainctl.js nightly --skip-harmonize
  node scripts/gigabrainctl.js audit --mode shadow --db ~/.openclaw/gigabrain/memory/registry.sqlite
  node scripts/gigabrainctl.js audit --mode restore --review-version rv-2026-02-22
  node scripts/gigabrainctl.js world rebuild --config ~/.openclaw/openclaw.json
  node scripts/gigabrainctl.js control apply --action replace --target-memory-id <id> --content "Liz moved to Graz" --scope nimbusmain
  node scripts/gigabrainctl.js orchestrator explain --query "Who is Liz?" --config ~/.openclaw/openclaw.json
  node scripts/gigabrainctl.js vault build --config ~/.openclaw/openclaw.json
  node scripts/gigabrainctl.js vault pull --host memory-host --remote-path /path/to/obsidian-vault --target ~/Documents/gigabrainvault
`;

const args = process.argv.slice(2);
const command = String(args[0] || '').trim().toLowerCase();
const flags = args.slice(1);

const readFlag = (name, fallback = '', list = flags) => {
  const idx = list.indexOf(name);
  if (idx !== -1 && list[idx + 1] && !String(list[idx + 1]).startsWith('--')) return list[idx + 1];
  const withEq = list.find((item) => String(item || '').startsWith(`${name}=`));
  if (withEq) return withEq.split('=').slice(1).join('=');
  return fallback;
};

const readBool = (name, fallback = false, list = flags) => {
  if (list.includes(name)) return true;
  const withEq = list.find((item) => String(item || '').startsWith(`${name}=`));
  if (!withEq) return fallback;
  const raw = String(withEq.split('=').slice(1).join('=')).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
};

const wantsHelp = flags.includes('--help') || flags.includes('-h');

const duplicateGroups = (db) => {
  ensureProjectionStore(db);
  const row = db.prepare(`
    SELECT COUNT(*) AS c
    FROM (
      SELECT normalized_hash, scope, COUNT(*) AS cnt
      FROM memory_current
      WHERE status = 'active'
      GROUP BY normalized_hash, scope
      HAVING cnt > 1
    )
  `).get();
  return Number(row?.c || 0);
};

const loadConfigAndDbPath = () => {
  const configPath = readFlag('--config', '');
  const workspaceOverride = readFlag('--workspace', '');
  const mode = readFlag('--mode', '');
  const loaded = loadResolvedConfig({
    configPath,
    workspaceRoot: workspaceOverride || undefined,
    mode: mode || undefined,
  });
  const dbPath = path.resolve(readFlag('--db', loaded.config.runtime.paths.registryPath));
  return {
    configPath: loaded.configPath,
    source: loaded.source,
    config: loaded.config,
    dbPath,
  };
};

const ensureDir = (dirPath) => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const removeDirIfExists = (dirPath) => {
  if (!dirPath) return;
  fs.rmSync(dirPath, { recursive: true, force: true });
};

const isPidAlive = (pid) => {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
};

const readJsonIfExists = (filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
};

const getNightlyLockPaths = (config) => {
  const workspaceRoot = String(config?.runtime?.paths?.workspaceRoot || process.cwd());
  const outputDir = String(config?.runtime?.paths?.outputDir || path.join(workspaceRoot, 'output'));
  return {
    outputDir,
    lockDir: path.join(outputDir, 'gigabrain-nightly.lock.d'),
    metadataPath: path.join(outputDir, 'gigabrain-nightly.lock.d', 'lock.json'),
  };
};

const acquireNightlyLock = ({ config, configPath = '', runId = '' } = {}) => {
  const { outputDir, lockDir, metadataPath } = getNightlyLockPaths(config);
  ensureDir(outputDir);
  const metadata = {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    runId: String(runId || ''),
    configPath: String(configPath || ''),
  };

  const writeMetadata = () => {
    fs.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}
`, 'utf8');
  };

  const inspectExistingLock = () => {
    const existing = readJsonIfExists(metadataPath);
    if (existing && isPidAlive(existing.pid)) {
      return {
        active: true,
        existing,
        reason: 'pid_alive',
      };
    }
    const lockAgeMs = (() => {
      try {
        return Math.max(0, Date.now() - fs.statSync(lockDir).mtimeMs);
      } catch {
        return NIGHTLY_LOCK_STALE_MS;
      }
    })();
    const startedAtMs = Date.parse(String(existing?.startedAt || ''));
    const staleByAge = lockAgeMs >= NIGHTLY_LOCK_STALE_MS;
    const staleByStartedAt = Number.isFinite(startedAtMs) && (Date.now() - startedAtMs) >= NIGHTLY_LOCK_STALE_MS;
    if (existing && !isPidAlive(existing.pid)) {
      return {
        active: false,
        existing,
        reason: 'pid_missing',
      };
    }
    if (!existing && staleByAge) {
      return {
        active: false,
        existing: null,
        reason: 'metadata_missing_timeout',
      };
    }
    if (existing && staleByStartedAt) {
      return {
        active: false,
        existing,
        reason: 'started_at_timeout',
      };
    }
    return {
      active: true,
      existing,
      reason: existing ? 'unknown_owner' : 'metadata_missing_recent',
    };
  };

  const attemptAcquire = () => {
    fs.mkdirSync(lockDir);
    writeMetadata();
    return {
      acquired: true,
      skipped: false,
      clearedStale: false,
      staleReason: '',
      lockDir,
      metadataPath,
      metadata,
    };
  };

  try {
    return attemptAcquire();
  } catch (err) {
    if (err?.code !== 'EEXIST') throw err;
    const inspection = inspectExistingLock();
    if (inspection.active) {
      return {
        acquired: false,
        skipped: true,
        clearedStale: false,
        staleReason: '',
        reason: 'nightly_already_running',
        lockDir,
        metadataPath,
        existing: inspection.existing,
        detail: inspection.reason,
      };
    }
    removeDirIfExists(lockDir);
    const acquired = attemptAcquire();
    return {
      ...acquired,
      clearedStale: true,
      staleReason: inspection.reason,
      previous: inspection.existing,
    };
  }
};

const releaseNightlyLock = (lockState) => {
  removeDirIfExists(lockState?.lockDir || '');
};

const verifyNightlyOutputs = ({ maintain, dryRun = false } = {}) => {
  const artifactPath = String(maintain?.artifacts?.executionArtifactPath || '');
  if (!artifactPath || !fs.existsSync(artifactPath)) {
    throw new Error(`Nightly execution artifact missing: ${artifactPath || '(empty path)'}`);
  }
  const artifact = readJsonIfExists(artifactPath);
  if (!artifact || typeof artifact !== 'object') {
    throw new Error(`Nightly execution artifact is not valid JSON: ${artifactPath}`);
  }
  if (String(artifact.run_id || '') !== String(maintain?.runId || '')) {
    throw new Error(`Nightly execution artifact run_id mismatch: expected ${maintain?.runId || '(empty)'}, got ${String(artifact.run_id || '(empty)')}`);
  }
  if (Boolean(artifact.dry_run) !== Boolean(dryRun)) {
    throw new Error(`Nightly execution artifact dry_run mismatch for ${artifactPath}`);
  }
  const usageLogPath = String(maintain?.artifacts?.usageLogPath || '');
  if (!usageLogPath || !fs.existsSync(usageLogPath)) {
    throw new Error(`Nightly usage log missing: ${usageLogPath || '(empty path)'}`);
  }
  const usageLog = fs.readFileSync(usageLogPath, 'utf8');
  if (!usageLog.includes(`- run_id: \`${String(maintain?.runId || '')}\``)) {
    throw new Error(`Nightly usage log is missing run_id ${String(maintain?.runId || '')}`);
  }
  return {
    ok: true,
    artifactPath,
    usageLogPath,
    artifactVerified: true,
    usageLogVerified: true,
  };
};
const runNightlyHarmonize = ({
  configPath,
  dbPath,
  config,
  dryRun,
} = {}) => {
  const harmonizeConfig = config?.maintenance?.harmonize || {};
  const defaultEnabled = harmonizeConfig?.enabled === true;
  const enabled = flags.includes('--skip-harmonize')
    ? false
    : readBool('--harmonize', defaultEnabled);
  if (!enabled) {
    return {
      enabled: false,
      ran: false,
      reason: 'disabled',
    };
  }
  if (dryRun) {
    return {
      enabled: true,
      ran: false,
      reason: 'dry_run',
    };
  }

  const scriptPath = path.join(THIS_DIR, 'harmonize-memory.js');
  const argsForNode = [scriptPath];
  if (configPath) {
    argsForNode.push('--config', String(configPath));
  }
  argsForNode.push('--db', String(dbPath));

  const statuses = Array.isArray(harmonizeConfig?.statuses)
    ? harmonizeConfig.statuses.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : [];
  if (statuses.length > 0) argsForNode.push('--statuses', statuses.join(','));

  if (harmonizeConfig?.outPath) argsForNode.push('--out', String(harmonizeConfig.outPath));
  if (Number.isFinite(Number(harmonizeConfig?.maxRows))) argsForNode.push('--max-rows', String(harmonizeConfig.maxRows));
  if (Number.isFinite(Number(harmonizeConfig?.perTypeLimit))) argsForNode.push('--per-type-limit', String(harmonizeConfig.perTypeLimit));
  if (Number.isFinite(Number(harmonizeConfig?.minConfidence))) argsForNode.push('--min-confidence', String(harmonizeConfig.minConfidence));

  argsForNode.push(`--sync-native=${String(harmonizeConfig?.syncNative !== false)}`);
  argsForNode.push(`--include-in-native=${String(harmonizeConfig?.includeInNative !== false)}`);
  argsForNode.push(`--backup=${String(harmonizeConfig?.backup !== false)}`);

  const run = spawnSync(process.execPath, argsForNode, {
    cwd: THIS_DIR,
    encoding: 'utf8',
    timeout: 180000,
  });
  const stdout = String(run.stdout || '').trim();
  const stderr = String(run.stderr || '').trim();
  let parsed = null;
  if (stdout) {
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = null;
    }
  }
  const ok = Number(run.status || 0) === 0 && (!parsed || parsed.ok !== false);
  return {
    enabled: true,
    ran: true,
    ok,
    exitCode: Number(run.status ?? 1),
    signal: run.signal || null,
    result: parsed,
    stdout: parsed ? '' : stdout,
    stderr,
    command: [process.execPath, ...argsForNode].join(' '),
  };
};

const commandMaintain = async () => {
  const { configPath, config, dbPath } = loadConfigAndDbPath();
  const dryRun = readBool('--dry-run', false);
  const reviewVersion = readFlag('--review-version', '');
  const runId = readFlag('--run-id', '');
  const result = runMaintenance({
    dbPath,
    config,
    configPath,
    dryRun,
    reviewVersion,
    runId,
  });
  console.log(JSON.stringify(result, null, 2));
};

const commandAudit = async () => {
  const { config, dbPath } = loadConfigAndDbPath();
  const mode = String(readFlag('--mode', 'shadow') || 'shadow').trim().toLowerCase();
  const reviewVersion = readFlag('--review-version', '');
  const runId = readFlag('--run-id', '');
  if (mode === 'restore') {
    const result = runAuditRestore({
      dbPath,
      reviewVersion,
      runId,
      cleanupVersion: config.runtime.cleanupVersion,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  if (mode === 'report') {
    const out = readFlag('--out', '');
    const result = runAuditReport({
      dbPath,
      reviewVersion,
      out,
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const llmEnabled = readBool('--llm-review', config.llm.review.enabled === true);
  const llm = {
    enabled: llmEnabled,
    provider: readFlag('--llm-provider', config.llm.provider),
    baseUrl: readFlag('--llm-base-url', config.llm.baseUrl),
    model: readFlag('--llm-model', config.llm.model),
    apiKey: readFlag('--llm-api-key', config.llm.apiKey),
    timeoutMs: Number(readFlag('--llm-timeout-ms', String(config.llm.timeoutMs)) || config.llm.timeoutMs),
    limit: Number(readFlag('--llm-review-limit', String(config.llm.review.limit)) || config.llm.review.limit),
    minScore: Number(readFlag('--llm-review-min-score', String(config.llm.review.minScore)) || config.llm.review.minScore),
    maxScore: Number(readFlag('--llm-review-max-score', String(config.llm.review.maxScore)) || config.llm.review.maxScore),
    minConfidence: Number(readFlag('--llm-review-min-confidence', String(config.llm.review.minConfidence)) || config.llm.review.minConfidence),
  };

  const result = await runAudit({
    dbPath,
    config,
    mode,
    reviewVersion,
    runId,
    out: readFlag('--out', ''),
    summary: readFlag('--summary', ''),
    samples: readFlag('--samples', ''),
    llm,
  });
  console.log(JSON.stringify(result, null, 2));
};

const renderMemoryActionTag = ({
  action = '',
  type = '',
  confidence = '',
  scope = '',
  target = '',
  targetMemoryId = '',
  content = '',
} = {}) => {
  const attrs = [];
  const pushAttr = (key, value) => {
    const text = String(value || '').trim();
    if (!text) return;
    const escaped = text.replace(/"/g, '&quot;');
    attrs.push(`${key}="${escaped}"`);
  };
  pushAttr('action', action);
  pushAttr('type', type);
  pushAttr('confidence', confidence);
  pushAttr('scope', scope);
  pushAttr('target', target);
  pushAttr('target_memory_id', targetMemoryId);
  const body = String(content || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<memory_action ${attrs.join(' ')}>${body}</memory_action>`;
};

const commandControl = async () => {
  const subcommand = String(flags[0] || '').trim().toLowerCase();
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(JSON.stringify({
      ok: true,
      usage: 'node scripts/gigabrainctl.js control apply --action <remember|update|replace|forget|protect|do_not_store> [--target-memory-id <id> | --target <text>] [--content <text>] [--scope <scope>] [--type <type>] [--confidence <n>]',
    }, null, 2));
    return;
  }
  if (subcommand !== 'apply') {
    throw new Error(`unknown control subcommand: ${subcommand}`);
  }
  const actionFlags = flags.slice(1);
  const action = String(readFlag('--action', '', actionFlags)).trim().toLowerCase();
  const content = String(readFlag('--content', '', actionFlags)).trim();
  const target = String(readFlag('--target', '', actionFlags)).trim();
  const targetMemoryId = String(readFlag('--target-memory-id', '', actionFlags)).trim();
  const scope = String(readFlag('--scope', 'shared', actionFlags)).trim() || 'shared';
  const type = String(readFlag('--type', '', actionFlags)).trim();
  const confidence = String(readFlag('--confidence', '', actionFlags)).trim();
  if (!action) throw new Error('--action is required');

  const { config, dbPath } = loadConfigAndDbPath();
  const db = openDatabase(dbPath);
  try {
    const tag = renderMemoryActionTag({
      action,
      type,
      confidence,
      scope,
      target,
      targetMemoryId,
      content,
    });
    const result = captureFromEvent({
      db,
      config,
      event: {
        scope,
        agentId: scope,
        sessionKey: `control:${scope}`,
        text: tag,
        output: tag,
        prompt: '',
        messages: [],
      },
      logger: console,
      runId: `control-${new Date().toISOString().replace(/[:.]/g, '-')}`,
      reviewVersion: '',
    });
    console.log(JSON.stringify({
      ok: true,
      action,
      scope,
      result,
    }, null, 2));
  } finally {
    db.close();
  }
};

const commandNightly = async () => {
  const { configPath, config, dbPath } = loadConfigAndDbPath();
  const dryRun = readBool('--dry-run', false);
  const runId = readFlag('--run-id', '');
  const reviewVersion = readFlag('--review-version', '');
  const lock = acquireNightlyLock({
    config,
    configPath,
    runId,
  });
  if (lock.skipped) {
    console.log(JSON.stringify({
      ok: true,
      command: 'nightly',
      skipped: true,
      reason: lock.reason,
      lock,
    }, null, 2));
    return;
  }
  try {
    const maintain = runMaintenance({
      dbPath,
      config,
      configPath,
      dryRun,
      reviewVersion,
      runId,
    });
    const harmonize = runNightlyHarmonize({
      configPath,
      dbPath,
      config,
      dryRun,
    });
    if (harmonize.enabled && harmonize.ran && harmonize.ok !== true) {
      const msg = [
        'Nightly harmonize step failed.',
        harmonize.stderr ? `stderr: ${harmonize.stderr}` : '',
        harmonize.stdout ? `stdout: ${harmonize.stdout}` : '',
      ].filter(Boolean).join(' ');
      throw new Error(msg);
    }
    const audit = await runAudit({
      dbPath,
      config,
      mode: dryRun ? 'shadow' : 'apply',
      reviewVersion,
      runId,
      out: readFlag('--audit-out', ''),
      summary: readFlag('--audit-summary', ''),
      samples: readFlag('--audit-samples', ''),
      llm: {
        enabled: readBool('--llm-review', config.llm.review.enabled === true),
        provider: readFlag('--llm-provider', config.llm.provider),
        baseUrl: readFlag('--llm-base-url', config.llm.baseUrl),
        model: readFlag('--llm-model', config.llm.model),
        apiKey: readFlag('--llm-api-key', config.llm.apiKey),
        timeoutMs: Number(readFlag('--llm-timeout-ms', String(config.llm.timeoutMs)) || config.llm.timeoutMs),
        limit: Number(readFlag('--llm-review-limit', String(config.llm.review.limit)) || config.llm.review.limit),
        minScore: Number(readFlag('--llm-review-min-score', String(config.llm.review.minScore)) || config.llm.review.minScore),
        maxScore: Number(readFlag('--llm-review-max-score', String(config.llm.review.maxScore)) || config.llm.review.maxScore),
        minConfidence: Number(readFlag('--llm-review-min-confidence', String(config.llm.review.minConfidence)) || config.llm.review.minConfidence),
      },
    });
    const verification = verifyNightlyOutputs({
      maintain,
      dryRun,
    });
    console.log(JSON.stringify({
      ok: true,
      command: 'nightly',
      runId: maintain.runId,
      lock,
      maintain,
      harmonize,
      audit,
      verification,
    }, null, 2));
  } finally {
    releaseNightlyLock(lock);
  }
};
const commandInventory = async () => {
  const { dbPath } = loadConfigAndDbPath();
  const db = openDatabase(dbPath);
  try {
    ensureProjectionStore(db);
    const count = db.prepare('SELECT COUNT(*) AS c FROM memory_current').get()?.c || 0;
    if (Number(count) === 0) {
      materializeProjectionFromMemories(db);
    }
    const metrics = captureSnapshotMetrics(db, dbPath);
    console.log(JSON.stringify({
      ok: true,
      dbPath,
      metrics,
      exact_duplicate_groups_active: duplicateGroups(db),
    }, null, 2));
  } finally {
    db.close();
  }
};

const commandDoctor = async () => {
  const { configPath, source, config, dbPath } = loadConfigAndDbPath();
  if (source === 'standalone' && config?.codex?.enabled !== false) {
    const { runDoctor } = await import('../lib/core/codex-service.js');
    const result = await runDoctor({
      configPath,
      target: readFlag('--target', 'both'),
      workspaceRoot: readFlag('--workspace', ''),
      mode: readFlag('--mode', source),
    });
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const checks = [];
  checks.push({ name: 'config_loaded', ok: Boolean(config) });
  checks.push({ name: 'db_exists', ok: Boolean(dbPath) });
  let metrics = null;
  let duplicates = null;
  const db = openDatabase(dbPath);
  try {
    ensureProjectionStore(db);
    const count = db.prepare('SELECT COUNT(*) AS c FROM memory_current').get()?.c || 0;
    if (Number(count) === 0) materializeProjectionFromMemories(db);
    metrics = captureSnapshotMetrics(db, dbPath);
    duplicates = duplicateGroups(db);
    checks.push({ name: 'projection_ready', ok: true, total: metrics.totals.all });
    checks.push({ name: 'exact_duplicates_active', ok: duplicates === 0, value: duplicates });
    checks.push({
      name: 'free_page_ratio_slo',
      ok: Number(metrics.db.page.free_page_ratio || 0) < 0.2,
      value: Number(metrics.db.page.free_page_ratio || 0),
    });
    const vaultHealth = inspectVaultHealth({ config, db });
    checks.push({
      name: 'vault_surface_ready',
      ok: config?.vault?.enabled !== true || vaultHealth.manual_protection.ok === true,
      value: vaultHealth,
    });
  } finally {
    db.close();
  }
  console.log(JSON.stringify({
    ok: checks.every((check) => check.ok),
    configKind: source,
    configPath,
    dbPath,
    checks,
    metrics,
  }, null, 2));
};

const commandWorld = async () => {
  const action = String(flags[0] || 'rebuild').trim().toLowerCase();
  const worldFlags = flags.slice(1);
  const configPath = readFlag('--config', '', worldFlags);
  const workspaceOverride = readFlag('--workspace', '', worldFlags);
  const loaded = loadResolvedConfig({
    configPath,
    workspaceRoot: workspaceOverride || undefined,
  });
  const config = loaded.config;
  const dbPath = path.resolve(readFlag('--db', config.runtime.paths.registryPath, worldFlags));
  const db = openDatabase(dbPath);
  try {
    ensureProjectionStore(db);
    ensureWorldModelReady({ db, config, rebuildIfEmpty: false });
    if (action === 'rebuild') {
      const result = rebuildWorldModel({ db, config });
      console.log(JSON.stringify({ ok: true, action: 'world_rebuild', configPath: loaded.configPath, dbPath, result }, null, 2));
      return;
    }
    if (action === 'entities') {
      const items = listEntities(db, { kind: readFlag('--kind', '', worldFlags), limit: Number(readFlag('--limit', '200', worldFlags) || 200) });
      console.log(JSON.stringify({ ok: true, action: 'world_entities', items, count: items.length }, null, 2));
      return;
    }
    throw new Error(`Unknown world action: ${action || '(none)'}`);
  } finally {
    db.close();
  }
};

const commandOrchestrator = async () => {
  const action = String(flags[0] || 'explain').trim().toLowerCase();
  const orchestratorFlags = flags.slice(1);
  if (action !== 'explain') throw new Error(`Unknown orchestrator action: ${action || '(none)'}`);
  const query = String(readFlag('--query', '', orchestratorFlags)).trim();
  if (!query) throw new Error('orchestrator explain requires --query');
  const configPath = readFlag('--config', '', orchestratorFlags);
  const workspaceOverride = readFlag('--workspace', '', orchestratorFlags);
  const loaded = loadResolvedConfig({
    configPath,
    workspaceRoot: workspaceOverride || undefined,
  });
  const config = loaded.config;
  const dbPath = path.resolve(readFlag('--db', config.runtime.paths.registryPath, orchestratorFlags));
  const db = openDatabase(dbPath);
  try {
    ensureProjectionStore(db);
    ensureWorldModelReady({ db, config, rebuildIfEmpty: true });
    const result = orchestrateRecall({
      db,
      config,
      query,
      scope: String(readFlag('--scope', '', orchestratorFlags)).trim(),
    });
    console.log(JSON.stringify({ ok: true, action: 'orchestrator_explain', result }, null, 2));
  } finally {
    db.close();
  }
};

const commandSynthesis = async () => {
  const action = String(flags[0] || 'build').trim().toLowerCase();
  const synthesisFlags = flags.slice(1);
  const configPath = readFlag('--config', '', synthesisFlags);
  const workspaceOverride = readFlag('--workspace', '', synthesisFlags);
  const loaded = loadResolvedConfig({
    configPath,
    workspaceRoot: workspaceOverride || undefined,
  });
  const config = loaded.config;
  const dbPath = path.resolve(readFlag('--db', config.runtime.paths.registryPath, synthesisFlags));
  const db = openDatabase(dbPath);
  try {
    ensureProjectionStore(db);
    ensureWorldModelReady({ db, config, rebuildIfEmpty: true });
    if (action === 'build') {
      const result = rebuildWorldModel({ db, config });
      console.log(JSON.stringify({ ok: true, action: 'synthesis_build', result }, null, 2));
      return;
    }
    if (action === 'list') {
      const items = listSyntheses(db, { kind: readFlag('--kind', '', synthesisFlags), limit: Number(readFlag('--limit', '200', synthesisFlags) || 200) });
      console.log(JSON.stringify({ ok: true, action: 'synthesis_list', items, count: items.length }, null, 2));
      return;
    }
    throw new Error(`Unknown synthesis action: ${action || '(none)'}`);
  } finally {
    db.close();
  }
};

const commandBriefing = async () => {
  const configPath = readFlag('--config', '');
  const workspaceOverride = readFlag('--workspace', '');
  const loaded = loadResolvedConfig({
    configPath,
    workspaceRoot: workspaceOverride || undefined,
  });
  const config = loaded.config;
  const dbPath = path.resolve(readFlag('--db', config.runtime.paths.registryPath));
  const db = openDatabase(dbPath);
  try {
    ensureProjectionStore(db);
    ensureWorldModelReady({ db, config, rebuildIfEmpty: true });
    const items = listSyntheses(db, { kind: 'session_brief', limit: 5 });
    console.log(JSON.stringify({ ok: true, action: 'briefing_build', items, count: items.length }, null, 2));
  } finally {
    db.close();
  }
};

const commandReview = async () => {
  const action = String(flags[0] || '').trim().toLowerCase();
  const reviewFlags = flags.slice(1);
  const configPath = readFlag('--config', '', reviewFlags);
  const workspaceOverride = readFlag('--workspace', '', reviewFlags);
  const loaded = loadResolvedConfig({
    configPath,
    workspaceRoot: workspaceOverride || undefined,
  });
  const config = loaded.config;
  const dbPath = path.resolve(readFlag('--db', config.runtime.paths.registryPath, reviewFlags));
  const db = openDatabase(dbPath);
  try {
    ensureProjectionStore(db);
    ensureWorldModelReady({ db, config, rebuildIfEmpty: true });
    if (action === 'contradictions') {
      const items = listContradictions(db, { limit: Number(readFlag('--limit', '200', reviewFlags) || 200) });
      console.log(JSON.stringify({ ok: true, action: 'review_contradictions', items, count: items.length }, null, 2));
      return;
    }
    if (action === 'open-loops') {
      const items = listOpenLoops(db, { limit: Number(readFlag('--limit', '200', reviewFlags) || 200) });
      console.log(JSON.stringify({ ok: true, action: 'review_open_loops', items, count: items.length }, null, 2));
      return;
    }
    throw new Error(`Unknown review action: ${action || '(none)'}`);
  } finally {
    db.close();
  }
};

const commandVault = async () => {
  const action = String(flags[0] || 'build').trim().toLowerCase();
  const vaultFlags = flags.slice(1);
  const configPath = readFlag('--config', '', vaultFlags);
  const workspaceOverride = readFlag('--workspace', '', vaultFlags);
  const loaded = loadResolvedConfig({
    configPath,
    workspaceRoot: workspaceOverride || undefined,
  });
  const config = loaded.config;
  const dbPath = path.resolve(readFlag('--db', config.runtime.paths.registryPath, vaultFlags));

  if (action === 'build') {
    const result = buildVaultSurface({
      dbPath,
      config,
      dryRun: readBool('--dry-run', false, vaultFlags),
      runId: readFlag('--run-id', '', vaultFlags),
    });
    console.log(JSON.stringify({
      ok: true,
      action: 'vault_build',
      configPath: loaded.configPath,
      dbPath,
      result,
    }, null, 2));
    return;
  }

  if (action === 'doctor') {
    const health = inspectVaultHealth({ config, dbPath });
    console.log(JSON.stringify({
      ok: config?.vault?.enabled !== true || health.manual_protection.ok === true,
      action: 'vault_doctor',
      configPath: loaded.configPath,
      dbPath,
      health,
    }, null, 2));
    return;
  }

  if (action === 'report') {
    const loadedSummary = loadSurfaceSummary({ config });
    const summary = loadedSummary.summary || buildVaultSurface({
      dbPath,
      config,
      dryRun: true,
      runId: readFlag('--run-id', '', vaultFlags),
    });
    console.log(JSON.stringify({
      ok: true,
      action: 'vault_report',
      configPath: loaded.configPath,
      dbPath,
      summaryPath: loadedSummary.filePath,
      summary,
    }, null, 2));
    return;
  }

  if (action === 'pull') {
    const result = syncVaultPull({
      host: readFlag('--host', '', vaultFlags),
      remotePath: readFlag('--remote-path', '', vaultFlags),
      target: path.resolve(readFlag('--target', config.vault.path, vaultFlags)),
      subdir: String(config?.vault?.subdir || 'Gigabrain'),
      manualFolders: Array.isArray(config?.vault?.manualFolders) ? config.vault.manualFolders : ['Inbox', 'Manual'],
      preserveManual: readBool('--preserve-manual', true, vaultFlags),
      dryRun: readBool('--dry-run', false, vaultFlags),
    });
    console.log(JSON.stringify({
      ok: true,
      action: 'vault_pull',
      result,
    }, null, 2));
    return;
  }

  throw new Error(`Unknown vault action: ${action || '(none)'}`);
};

const main = async () => {
  if (['', 'help', '--help', '-h'].includes(command) || wantsHelp) {
    console.log(HELP.trim());
    return;
  }
  if (command === 'maintain') {
    await commandMaintain();
    return;
  }
  if (command === 'audit') {
    await commandAudit();
    return;
  }
  if (command === 'nightly') {
    await commandNightly();
    return;
  }
  if (command === 'inventory') {
    await commandInventory();
    return;
  }
  if (command === 'doctor') {
    await commandDoctor();
    return;
  }
  if (command === 'world') {
    await commandWorld();
    return;
  }
  if (command === 'control') {
    await commandControl();
    return;
  }
  if (command === 'orchestrator') {
    await commandOrchestrator();
    return;
  }
  if (command === 'synthesis') {
    await commandSynthesis();
    return;
  }
  if (command === 'briefing') {
    await commandBriefing();
    return;
  }
  if (command === 'review') {
    await commandReview();
    return;
  }
  if (command === 'vault') {
    await commandVault();
    return;
  }
  throw new Error(`Unknown command: ${command || '(none)'}`);
};

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
