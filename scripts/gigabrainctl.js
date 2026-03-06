#!/usr/bin/env node
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/core/sqlite.js';

import { loadResolvedConfig } from '../lib/core/config.js';
import { runMaintenance } from '../lib/core/maintenance-service.js';
import { runAudit, runAuditRestore, runAuditReport } from '../lib/core/audit-service.js';
import { ensureProjectionStore, materializeProjectionFromMemories } from '../lib/core/projection-store.js';
import { captureSnapshotMetrics } from '../lib/core/metrics.js';

const THIS_FILE = fileURLToPath(import.meta.url);
const THIS_DIR = path.dirname(THIS_FILE);

const HELP = `Gigabrain v3 Control CLI

Usage:
  node scripts/gigabrainctl.js <command> [flags]

Commands:
  nightly      Run one full nightly cycle (maintain + optional harmonize + audit apply)
  maintain     Run maintenance sequence only
  audit        Run audit service (--mode shadow|apply|restore)
  inventory    Print current memory inventory metrics
  doctor       Validate config/db + print health checks

Examples:
  node scripts/gigabrainctl.js nightly --config ~/.openclaw/openclaw.json
  node scripts/gigabrainctl.js nightly --harmonize
  node scripts/gigabrainctl.js nightly --skip-harmonize
  node scripts/gigabrainctl.js audit --mode shadow --db ~/.openclaw/gigabrain/memory/registry.sqlite
  node scripts/gigabrainctl.js audit --mode restore --review-version rv-2026-02-22
`;

const args = process.argv.slice(2);
const command = String(args[0] || '').trim().toLowerCase();
const flags = args.slice(1);

const readFlag = (name, fallback = '') => {
  const idx = flags.indexOf(name);
  if (idx !== -1 && flags[idx + 1] && !String(flags[idx + 1]).startsWith('--')) return flags[idx + 1];
  const withEq = flags.find((item) => String(item || '').startsWith(`${name}=`));
  if (withEq) return withEq.split('=').slice(1).join('=');
  return fallback;
};

const readBool = (name, fallback = false) => {
  if (flags.includes(name)) return true;
  const withEq = flags.find((item) => String(item || '').startsWith(`${name}=`));
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
  const loaded = loadResolvedConfig({
    configPath,
    workspaceRoot: workspaceOverride || undefined,
  });
  const dbPath = path.resolve(readFlag('--db', loaded.config.runtime.paths.registryPath));
  return {
    configPath: loaded.configPath,
    config: loaded.config,
    dbPath,
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
  const { config, dbPath } = loadConfigAndDbPath();
  const dryRun = readBool('--dry-run', false);
  const reviewVersion = readFlag('--review-version', '');
  const runId = readFlag('--run-id', '');
  const result = runMaintenance({
    dbPath,
    config,
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

const commandNightly = async () => {
  const { configPath, config, dbPath } = loadConfigAndDbPath();
  const dryRun = readBool('--dry-run', false);
  const runId = readFlag('--run-id', '');
  const reviewVersion = readFlag('--review-version', '');
  const maintain = runMaintenance({
    dbPath,
    config,
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
  console.log(JSON.stringify({
    ok: true,
    command: 'nightly',
    runId: maintain.runId,
    maintain,
    harmonize,
    audit,
  }, null, 2));
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
  const { configPath, config, dbPath } = loadConfigAndDbPath();
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
  } finally {
    db.close();
  }
  console.log(JSON.stringify({
    ok: checks.every((check) => check.ok),
    configPath,
    dbPath,
    checks,
    metrics,
  }, null, 2));
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
  throw new Error(`Unknown command: ${command || '(none)'}`);
};

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
