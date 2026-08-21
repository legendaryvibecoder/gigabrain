#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../lib/core/sqlite.js';

import { loadResolvedConfig } from '../lib/core/config.js';
import { runMaintenance } from '../lib/core/maintenance-service.js';
import { runAudit, runAuditRestore, runAuditReport, watchRun, bumpLocalCounters, exportLocalCounters, purgeNoopReviews } from '../lib/core/audit-service.js';
import { listQueueEntries } from '../lib/core/review-queue.js';
import { checkLegacyContainment, dropLegacyMemoriesTable, ensureProjectionStore, listAdjudications, listBeliefsAsOf, materializeProjectionFromMemories } from '../lib/core/projection-store.js';
import { cloudInboxStaleness, exportMemoryBrief, getSyncStatus, listMemorySources, resolveHostRoots, syncHostMemories } from '../lib/core/host-memory-sync.js';
import { importOpenClawRegistry } from '../lib/core/openclaw-import.js';
import { ensureVaultStore, syncVaultMemory } from '../lib/core/vault-sync.js';
import { ensureTranscriptStore, harvestTranscripts, transcriptStatus } from '../lib/core/transcript-harvester.js';
import { projectWiki, reconcileWiki, resolveWikiConfig } from '../lib/core/wiki-project.js';
import { buildMemoryPassport, writeMemoryPassport } from '../lib/core/handoff-record.js';
import { exportPassportBundle, importPassportBundle } from '../lib/core/handoff-bundle.js';
import { captureSnapshotMetrics } from '../lib/core/metrics.js';
import { orchestrateRecall } from '../lib/core/orchestrator.js';
import { captureFromEvent } from '../lib/core/capture-service.js';
import { installSessionHook, uninstallSessionHook, resolveSessionSettingsPath } from '../lib/core/lifecycle-hooks.js';
import { runAdaptiveTrust } from '../lib/core/adaptive-trust.js';
import { proposeToVaultInbox } from '../lib/core/vault-inbox.js';
import { atomicWriteFileSync, readFileIfExistsSync } from '../lib/core/safe-fs.js';
import { migrateLegacyCheckpoints } from '../lib/core/checkpoint-migration.js';
import {
  ensureWorldModelReady,
  getEntityDetail,
  listContradictions,
  listEntities,
  listOpenLoops,
  rebuildWorldModel,
  listSyntheses,
  projectArbitrationBeliefRows,
} from '../lib/core/world-model.js';

const THIS_FILE = fileURLToPath(import.meta.url);
const THIS_DIR = path.dirname(THIS_FILE);
const NIGHTLY_LOCK_STALE_MS = 6 * 60 * 60 * 1000;

const HELP = `Gigabrain v3 Control CLI

Usage:
  node scripts/gigabrainctl.js <command> [flags]

Commands:
  init         Auto-detect installed coding agents and wire them in one command
  nightly      Run one full nightly cycle (maintain + optional harmonize + audit apply)
  maintain     Run maintenance sequence only
  audit        Run audit service (--mode shadow|apply|restore)
  watch        Re-run the audit against the last watch snapshot; report only NEW findings (never mutates memories)
  inventory    Print current memory inventory metrics
  doctor       Validate config/db + print health checks
  world        Rebuild or inspect the world-model layer
  control      Apply structured memory actions
  orchestrator Explain how Gigabrain would answer a recall query
  synthesis    Inspect or rebuild synthesis artifacts
  briefing     Print the latest generated briefing artifacts
  review       Inspect contradictions, open loops, adjudications, the review queue, beliefs as of a timestamp, or adaptive host trust (trust)
  migrate      Run a migration (legacy-checkpoints: typed immutable backfill; legacy-drop: deprecated table removal)
  vault        Sync or report on READ-ONLY Obsidian vault reference corpora (sync|status; never becomes a belief)
  wiki         Git-versioned LLM-wiki projection of the ledger (project|reconcile|status; human edits round-trip + win arbitration)
  sync-hosts   Sync local host memories into the cross-agent memory bus
  import-openclaw Import a legacy OpenClaw/Gigabrain registry.sqlite with provenance
  handoff      Generate a static Memory Audit report and safe Handoff Records (alias: passport, deprecated)
  export-bundle  Export a portable, re-importable memory bundle (versioned + integrity-hashed)
  import-bundle  Import a memory bundle into this store (verifies integrity, rebuilds world model)

Examples:
  node scripts/gigabrainctl.js init
  node scripts/gigabrainctl.js init --project-root /path/to/repo
  node scripts/gigabrainctl.js nightly --config ~/.openclaw/openclaw.json
  node scripts/gigabrainctl.js nightly --harmonize
  node scripts/gigabrainctl.js nightly --skip-harmonize
  node scripts/gigabrainctl.js audit --mode shadow --db ~/.openclaw/gigabrain/memory/registry.sqlite
  node scripts/gigabrainctl.js audit --mode restore --review-version rv-2026-02-22
  node scripts/gigabrainctl.js watch --config ~/.gigabrain/config.json
  node scripts/gigabrainctl.js watch --install-hook
  node scripts/gigabrainctl.js review queue --status pending --reason-code capture_contradiction_durable_tie
  node scripts/gigabrainctl.js migrate legacy-drop --dry-run --db ~/.openclaw/gigabrain/memory/registry.sqlite
  node scripts/gigabrainctl.js migrate legacy-drop --snapshot ./memories-pre-drop.sqlite --db ~/.openclaw/gigabrain/memory/registry.sqlite
  node scripts/gigabrainctl.js migrate legacy-checkpoints --dry-run --config ~/.gigabrain/config.json
  node scripts/gigabrainctl.js migrate legacy-checkpoints --config ~/.gigabrain/config.json
  node scripts/gigabrainctl.js vault status --config ~/.gigabrain/config.json
  node scripts/gigabrainctl.js vault sync --dry-run --config ~/.gigabrain/config.json
  node scripts/gigabrainctl.js transcript status --config ~/.gigabrain/config.json
  node scripts/gigabrainctl.js transcript sync --dry-run --config ~/.gigabrain/config.json
  node scripts/gigabrainctl.js wiki status --config ~/.gigabrain/config.json
  node scripts/gigabrainctl.js wiki reconcile --config ~/.gigabrain/config.json
  node scripts/gigabrainctl.js wiki project --config ~/.gigabrain/config.json
  node scripts/gigabrainctl.js world rebuild --config ~/.openclaw/openclaw.json
  node scripts/gigabrainctl.js control apply --action replace --target-memory-id <id> --content "<person> moved to <city>" --scope <scope>
  node scripts/gigabrainctl.js control apply --action reinstate --target-memory-id <id> --content "reverses a false over-merge supersession"
  node scripts/gigabrainctl.js orchestrator explain --query "Who is <person>?" --config ~/.openclaw/openclaw.json
  node scripts/gigabrainctl.js sync-hosts --config ~/.gigabrain/config.json --host codex,claude_code
  node scripts/gigabrainctl.js import-openclaw --config ~/.gigabrain/config.json --registry ~/.openclaw/gigabrain/memory/registry.sqlite --source-label remote-host-backup --dry-run
  node scripts/gigabrainctl.js handoff --config ~/.gigabrain/config.json --output-dir ./handoff-record
  node scripts/gigabrainctl.js export-bundle --config ~/.gigabrain/config.json --out ./memory-bundle.json
  node scripts/gigabrainctl.js import-bundle --config ~/.gigabrain/config.json --in ./memory-bundle.json
  node scripts/gigabrainctl.js sync-hosts export-brief --target-host claude_code --config ~/.gigabrain/config.json
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
  if (configPath) {
    const explicitConfigPath = path.resolve(configPath);
    if (!fs.existsSync(explicitConfigPath)) {
      throw new Error([
        `Gigabrain could not find a config at ${explicitConfigPath}.`,
        'If this should be a standalone store, run gigabrain-codex-setup or gigabrain-claude-setup first.',
        'If this should be an OpenClaw install, point --config at an existing openclaw.json.',
      ].join('\n'));
    }
  }
  const workspaceOverride = readFlag('--workspace', '');
  const mode = readFlag('--mode', '');
  const loaded = loadResolvedConfig({
    configPath,
    workspaceRoot: workspaceOverride || undefined,
    mode: mode || undefined,
  });
  const dbPath = path.resolve(readFlag('--db', loaded.config.runtime.paths.registryPath));
  // Fresh-install UX: node:sqlite's DatabaseSync throws a raw "unable to open
  // database file" when the registry's parent dir is missing. Ensure it exists
  // centrally so every command behaves like the sibling commands (sync-hosts,
  // import/export, handoff, vault-inbox) that already ensureDir before opening.
  ensureDir(path.dirname(dbPath));
  // The memory dir holds the registry, backups, and usage logs, so keep it
  // owner-only on shared hosts.
  try { fs.chmodSync(path.dirname(dbPath), 0o700); } catch { /* best-effort */ }
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

// ---------------------------------------------------------------------------
// U16 (R13): `gigabrain watch` — the recurring governance surface.
// ---------------------------------------------------------------------------
const WATCH_HELP = `Gigabrain watch

Re-runs the Memory Audit against the last watch snapshot cursor and reports
only NEW findings since that snapshot. The first run (no prior snapshot) is a
full audit and is labeled as such. Watch NEVER mutates memories: its entire
write surface is one watch:snapshot ledger event per run.

Usage:
  node scripts/gigabrainctl.js watch [flags]

Flags:
  --config <path>     Gigabrain config path
  --db <path>         Registry SQLite path override
  --json              Print the full JSON result instead of the human summary
  --run-id <id>       Run id override
  --install-hook      Write a host lifecycle hook. Default --kind=pre-push writes
                      an ADVISORY git pre-push hook into the current repo (warns
                      about new findings and NEVER blocks a push). --kind=session
                      writes a Claude Code SessionEnd (+ PreCompact) hook into the
                      project or user settings. The hook records one structured,
                      deduplicated lifecycle checkpoint per stable host session.
  --uninstall-hook    Remove the hook --install-hook wrote (honors --kind; refuses
                      to touch a hook Gigabrain did not install)
  --kind <kind>       pre-push (default) | session
  --settings <path>   --kind=session: explicit settings.json target (defaults to
                      ./.claude/settings.json, falling back to ~/.claude/settings.json)
  --export-counters   Print the opt-in local counters to stdout — COUNTS ONLY,
                      nothing is ever uploaded (see telemetry.countersEnabled)
  --arbitrate         OPT-IN: run belief arbitration (verdicts + supersession,
                      independent of worldModel.enabled) before the audit read.
                      This is the only watch mode that writes beyond the
                      snapshot event; the default stays read-only.
`;

const WATCH_HOOK_MARKER = '# gigabrain-watch-hook v1';

// Resolve the CURRENT repo's hooks directory. Prefer git itself (correct for
// worktrees and core.hooksPath); fall back to a plain .git/hooks walk-up when
// the git binary is unavailable.
const resolveGitHooksDir = (cwd) => {
  const probe = spawnSync('git', ['rev-parse', '--git-path', 'hooks'], {
    cwd,
    encoding: 'utf8',
    timeout: 15000,
  });
  if (Number(probe.status) === 0) {
    const rel = String(probe.stdout || '').trim();
    if (rel) return path.resolve(cwd, rel);
  }
  let dir = path.resolve(cwd);
  for (;;) {
    const gitPath = path.join(dir, '.git');
    try {
      if (fs.statSync(gitPath).isDirectory()) return path.join(gitPath, 'hooks');
    } catch {
      // keep walking up
    }
    const parent = path.dirname(dir);
    if (parent === dir) return '';
    dir = parent;
  }
};

const buildWatchHookScript = ({ configPath = '', dbPath = '' } = {}) => {
  const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
  const extraFlags = [
    configPath ? ` --config ${shq(configPath)}` : '',
    dbPath ? ` --db ${shq(dbPath)}` : '',
  ].join('');
  // The hook is ADVISORY ONLY: every path ends in `exit 0` — a failed audit,
  // missing node, or new findings all WARN and never block the push.
  return `#!/bin/sh
${WATCH_HOOK_MARKER}
# Installed by: gigabrainctl watch --install-hook
# Remove with:  gigabrainctl watch --uninstall-hook
# ADVISORY ONLY — this hook NEVER blocks a push. It re-runs the Gigabrain
# memory audit against the last watch snapshot and warns about NEW findings.
GB_NODE=${shq(process.execPath)}
GB_CTL=${shq(THIS_FILE)}
out="$("$GB_NODE" "$GB_CTL" watch --json${extraFlags} 2>/dev/null)"
if [ $? -ne 0 ]; then
  echo "gigabrain watch: audit run failed (push NOT blocked)" >&2
  exit 0
fi
new="$(printf '%s' "$out" | "$GB_NODE" -e 'let d="";process.stdin.on("data",(c)=>{d+=c;});process.stdin.on("end",()=>{try{const j=JSON.parse(d);process.stdout.write(String(Math.max(0,Number(j.new_findings)||0)));}catch{process.stdout.write("0");}});')"
if [ "\${new:-0}" -gt 0 ] 2>/dev/null; then
  echo "gigabrain watch: \${new} NEW memory finding(s) since the last snapshot. Run 'gigabrainctl watch' for details. Push NOT blocked." >&2
fi
exit 0
`;
};

const commandWatchInstallHook = () => {
  const hooksDir = resolveGitHooksDir(process.cwd());
  if (!hooksDir) {
    throw new Error('watch --install-hook must run inside a git repository (no .git found from the current directory)');
  }
  const hookPath = path.join(hooksDir, 'pre-push');
  const hookState = readFileIfExistsSync(hookPath, 'utf8');
  if (hookState.exists) {
    if (!hookState.data.includes(WATCH_HOOK_MARKER)) {
      throw new Error([
        `Refusing to overwrite an existing pre-push hook Gigabrain did not install: ${hookPath}`,
        `Add a manual call to 'gigabrainctl watch' inside your hook instead.`,
      ].join('\n'));
    }
  }
  fs.mkdirSync(hooksDir, { recursive: true });
  atomicWriteFileSync(hookPath, buildWatchHookScript({
    configPath: readFlag('--config', ''),
    dbPath: readFlag('--db', ''),
  }), { mode: 0o755 });
  // Counter is best-effort: hook installation must work without a configured
  // store (counters are opt-in and silently skipped when config is absent).
  try {
    const { config } = loadConfigAndDbPath();
    bumpLocalCounters(config, { hook_installs: 1 });
  } catch {
    // no configured store — skip counters
  }
  console.log(JSON.stringify({
    ok: true,
    action: 'watch_install_hook',
    hookPath,
    blocking: false,
    note: 'Advisory pre-push hook installed. It warns about NEW findings and never blocks a push.',
  }, null, 2));
};

const commandWatchUninstallHook = () => {
  const hooksDir = resolveGitHooksDir(process.cwd());
  if (!hooksDir) {
    throw new Error('watch --uninstall-hook must run inside a git repository (no .git found from the current directory)');
  }
  const hookPath = path.join(hooksDir, 'pre-push');
  const hookState = readFileIfExistsSync(hookPath, 'utf8');
  if (!hookState.exists) {
    console.log(JSON.stringify({ ok: true, action: 'watch_uninstall_hook', removed: false, reason: 'no_pre_push_hook' }, null, 2));
    return;
  }
  if (!hookState.data.includes(WATCH_HOOK_MARKER)) {
    throw new Error(`Refusing to delete a pre-push hook Gigabrain did not install: ${hookPath}`);
  }
  fs.rmSync(hookPath);
  console.log(JSON.stringify({ ok: true, action: 'watch_uninstall_hook', removed: true, hookPath }, null, 2));
};

// The git pre-push hook above fires on `git push`; the optional session hook
// records a structured checkpoint on Claude Code SessionEnd and PreCompact.
// Ownership, refusal, and merge safety live in lib/core/lifecycle-hooks.js.
const commandSessionInstallHook = () => {
  const settingsPath = resolveSessionSettingsPath({ explicit: readFlag('--settings', '') });
  const result = installSessionHook({
    settingsPath,
    configPath: readFlag('--config', ''),
  });
  if (result.ok) {
    try {
      const { config } = loadConfigAndDbPath();
      bumpLocalCounters(config, { hook_installs: 1 });
    } catch {
      // no configured store — skip counters
    }
  }
  console.log(JSON.stringify(result, null, 2));
};

const commandSessionUninstallHook = () => {
  const settingsPath = resolveSessionSettingsPath({ explicit: readFlag('--settings', '') });
  console.log(JSON.stringify(uninstallSessionHook({ settingsPath }), null, 2));
};

const renderWatchHuman = (result) => {
  const lines = [];
  if (result.full_run) {
    lines.push('gigabrain watch — FIRST RUN (no prior snapshot): full audit, every current finding below is reported as new.');
  } else {
    lines.push(`gigabrain watch — new findings since last snapshot (${result.since}):`);
  }
  if (result.arbitration) {
    lines.push(`arbitration (opt-in): ${result.arbitration.verdicts} verdict(s) over ${result.arbitration.beliefs} beliefs`);
  }
  lines.push(`rows audited: ${result.rows_audited}`);
  lines.push(`new findings: ${result.new_findings}`);
  for (const [action, count] of Object.entries(result.findings_by_action || {})) {
    lines.push(`  ${action}: ${count}`);
  }
  for (const finding of (result.findings || []).slice(0, 50)) {
    const reasons = (finding.reason_codes || []).join(', ') || 'none';
    lines.push(`- [${finding.action}] [${finding.type}] ${String(finding.content || '').replace(/\s+/g, ' ').trim().slice(0, 140)} (reasons: ${reasons})`);
  }
  if ((result.findings || []).length > 50) {
    lines.push(`... ${result.findings.length - 50} more (see ${result.output?.out || 'the findings report'})`);
  }
  if (result.new_findings === 0 && !result.full_run) {
    lines.push('No new findings since the last snapshot.');
  }
  lines.push(`snapshot recorded: ${result.snapshot_event_id} @ ${result.run_at}`);
  return lines.join('\n');
};

const commandWatch = async () => {
  if (wantsHelp) {
    console.log(WATCH_HELP.trim());
    return;
  }
  const hookKind = String(readFlag('--kind', 'pre-push')).trim().toLowerCase();
  if (readBool('--install-hook', false)) {
    if (hookKind === 'session') commandSessionInstallHook();
    else commandWatchInstallHook();
    return;
  }
  if (readBool('--uninstall-hook', false)) {
    if (hookKind === 'session') commandSessionUninstallHook();
    else commandWatchUninstallHook();
    return;
  }
  if (readBool('--export-counters', false)) {
    const { config } = loadConfigAndDbPath();
    // stdout carries COUNTS ONLY; this never uploads anything anywhere.
    console.log(JSON.stringify(exportLocalCounters(config), null, 2));
    if (config?.telemetry?.countersEnabled !== true) {
      console.error('note: telemetry.countersEnabled is false — counters are not being collected; this export shows zeros or stale counts.');
    }
    return;
  }
  const { config, dbPath } = loadConfigAndDbPath();
  const result = await watchRun({
    dbPath,
    config,
    runId: readFlag('--run-id', ''),
    out: readFlag('--out', ''),
    summary: readFlag('--summary', ''),
    samples: readFlag('--samples', ''),
    arbitrate: readBool('--arbitrate', false),
  });
  if (readBool('--json', false)) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(renderWatchHuman(result));
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

const commandMigrate = async () => {
  const subcommand = String(flags[0] || '').trim().toLowerCase();
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(JSON.stringify({
      ok: true,
      usage: [
        'node scripts/gigabrainctl.js migrate legacy-checkpoints [--dry-run] [--memory-root <path>] [--scope <scope>] [--include-today] [--db <path>] [--config <path>]',
        'node scripts/gigabrainctl.js migrate legacy-drop [--dry-run] [--snapshot <path>] [--db <path>] [--config <path>]',
      ],
    }, null, 2));
    return;
  }
  if (!['legacy-checkpoints', 'legacy-drop'].includes(subcommand)) {
    throw new Error(`unknown migrate subcommand: ${subcommand}`);
  }
  const migrateFlags = flags.slice(1);
  const dryRun = readBool('--dry-run', false, migrateFlags);
  const snapshot = String(readFlag('--snapshot', '', migrateFlags)).trim();
  const snapshotPath = snapshot ? path.resolve(snapshot) : null;

  const { config, dbPath } = loadConfigAndDbPath();
  const db = openDatabase(dbPath);
  try {
    if (subcommand === 'legacy-checkpoints') {
      const result = migrateLegacyCheckpoints(db, {
        memoryRoot: readFlag('--memory-root', config.runtime.paths.memoryRoot, migrateFlags),
        defaultScope: readFlag(
          '--scope',
          config?.codex?.defaultProjectScope || config?.codex?.projectScope || 'project:workspace',
          migrateFlags,
        ),
        dryRun,
        includeToday: readBool('--include-today', false, migrateFlags),
      });
      console.log(JSON.stringify({
        command: 'migrate',
        subcommand: 'legacy-checkpoints',
        ...result,
      }, null, 2));
      return;
    }
    // Dry-run: containment report only — never drops, never snapshots.
    if (dryRun) {
      const containment = checkLegacyContainment(db);
      console.log(JSON.stringify({
        ok: true,
        command: 'migrate',
        subcommand: 'legacy-drop',
        dryRun: true,
        dropped: false,
        containment,
      }, null, 2));
      return;
    }
    // Real run: containment-gated drop. dropLegacyMemoriesTable throws if any
    // orphan legacy rows exist (drop refused).
    const result = dropLegacyMemoriesTable(db, { snapshot: snapshotPath });
    console.log(JSON.stringify({
      ok: true,
      command: 'migrate',
      subcommand: 'legacy-drop',
      dryRun: false,
      dropped: result.dropped,
      reason: result.reason,
      snapshotPath: result.snapshotPath,
      containment: result.containment,
      event: result.event ? { event_id: result.event.event_id, action: result.event.action } : null,
    }, null, 2));
  } finally {
    db.close();
  }
};

const commandVault = async () => {
  const subcommand = String(flags[0] || '').trim().toLowerCase();
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(JSON.stringify({
      ok: true,
      usage: 'node scripts/gigabrainctl.js vault <sync|status> [--dry-run] [--db <path>] [--config <path>]',
    }, null, 2));
    return;
  }
  if (subcommand !== 'sync' && subcommand !== 'status' && subcommand !== 'inbox') {
    throw new Error(`unknown vault subcommand: ${subcommand}`);
  }
  const vaultFlags = flags.slice(1);
  const dryRun = readBool('--dry-run', false, vaultFlags);

  const { config, dbPath } = loadConfigAndDbPath();

  // C2 slice: append the current findings digest to the GigaBrain-owned inbox
  // note (vault.inbox config; disabled by default; append-only, never touches
  // human notes). --dry-run prints the digest without contacting the API.
  if (subcommand === 'inbox') {
    ensureDir(path.dirname(dbPath));
    const db = openDatabase(dbPath);
    try {
      ensureProjectionStore(db);
      ensureWorldModelReady({ db, config, rebuildIfEmpty: true });
      const result = await proposeToVaultInbox({ db, config, dryRun });
      console.log(JSON.stringify({ ok: result.ok, action: 'vault_inbox', ...result }, null, 2));
    } finally {
      db.close();
    }
    return;
  }
  const vaults = Array.isArray(config?.native?.vaults) ? config.native.vaults : [];

  // vaults:[] default → BOTH subcommands are graceful no-ops at zero cost. No
  // store creation, no DB open beyond the path resolve.
  if (vaults.length === 0) {
    console.log(JSON.stringify({
      ok: true,
      command: 'vault',
      subcommand,
      enabled: false,
      reason: 'no vaults configured',
      vaults: [],
    }, null, 2));
    return;
  }

  const db = openDatabase(dbPath);
  try {
    if (subcommand === 'sync') {
      const summary = syncVaultMemory({
        db,
        config,
        dryRun,
        maxFiles: Number(config?.native?.vaultSyncMaxFiles || 0) || 0,
      });
      console.log(JSON.stringify({
        ok: true,
        command: 'vault',
        subcommand: 'sync',
        dryRun,
        summary,
      }, null, 2));
      return;
    }

    // status: read-only per-vault rollup of chunk counts + last sync + evicted.
    ensureVaultStore(db);
    const perVaultRows = db.prepare(`
      SELECT c.source_path AS source_path,
             COUNT(*) AS chunk_count,
             MAX(s.last_synced_at) AS last_synced_at
      FROM memory_native_chunks c
      LEFT JOIN memory_native_sync_state s ON s.source_path = c.source_path
      WHERE c.source_kind = 'vault' AND c.status = 'active'
      GROUP BY c.source_path
    `).all();
    // Group source-level rollups under their configured vault root, then a
    // lightweight dry-run pass re-derives skipped_evicted per vault (the
    // eviction count is not persisted, so we recompute it read-only here).
    const vaultStatus = vaults.map((vault) => {
      const root = String(vault?.path || '').trim();
      const owned = perVaultRows.filter((row) => String(row.source_path || '').startsWith(`${root}/`) || String(row.source_path || '') === root);
      const chunkCount = owned.reduce((acc, row) => acc + Number(row.chunk_count || 0), 0);
      const lastSync = owned.reduce((acc, row) => {
        const v = String(row.last_synced_at || '');
        return v > acc ? v : acc;
      }, '');
      const probe = syncVaultMemory({
        db,
        config: { ...config, native: { ...config.native, vaults: [vault] } },
        dryRun: true,
        embed: false,
      });
      return {
        path: root,
        glob: String(vault?.glob || '').trim() || null,
        chunk_count: chunkCount,
        source_count: owned.length,
        last_synced_at: lastSync || null,
        skipped_evicted: Number(probe.skipped_evicted || 0),
      };
    });
    const totalChunks = vaultStatus.reduce((acc, v) => acc + Number(v.chunk_count || 0), 0);
    console.log(JSON.stringify({
      ok: true,
      command: 'vault',
      subcommand: 'status',
      enabled: true,
      vault_count: vaults.length,
      total_chunks: totalChunks,
      vaults: vaultStatus,
    }, null, 2));
  } finally {
    db.close();
  }
};

// idea #1 — transcript / rollout CDC harvester CLI. Mirrors `vault sync|status`.
//   transcript sync   — CDC-tail the configured rollout globs (local-only).
//   transcript status — read-only per-source cursor rollup (no walk, no LLM).
// native.transcripts.enabled:false (DEFAULT) → both subcommands are graceful
// no-ops at zero cost.
const commandTranscript = async () => {
  const subcommand = String(flags[0] || '').trim().toLowerCase();
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(JSON.stringify({
      ok: true,
      usage: 'node scripts/gigabrainctl.js transcript <sync|status> [--dry-run] [--db <path>] [--config <path>]',
    }, null, 2));
    return;
  }
  if (subcommand !== 'sync' && subcommand !== 'status') {
    throw new Error(`unknown transcript subcommand: ${subcommand}`);
  }
  const subFlags = flags.slice(1);
  const dryRun = readBool('--dry-run', false, subFlags);

  const { config, dbPath } = loadConfigAndDbPath();
  const enabled = config?.native?.transcripts?.enabled === true;

  // Disabled → a graceful no-op at zero cost (no store creation, no walk).
  if (!enabled) {
    console.log(JSON.stringify({
      ok: true,
      command: 'transcript',
      subcommand,
      enabled: false,
      reason: 'native.transcripts.enabled is false',
    }, null, 2));
    return;
  }

  const db = openDatabase(dbPath);
  try {
    if (subcommand === 'sync') {
      const summary = harvestTranscripts({
        db,
        config,
        incremental: true,
        arbitrate: !dryRun,
        dryRun,
        projectBeliefRows: projectArbitrationBeliefRows,
      });
      console.log(JSON.stringify({
        ok: summary.ok !== false,
        command: 'transcript',
        subcommand: 'sync',
        dryRun,
        summary,
      }, null, 2));
      return;
    }
    // status
    ensureTranscriptStore(db);
    const status = transcriptStatus({ db, config });
    console.log(JSON.stringify({
      ok: true,
      command: 'transcript',
      subcommand: 'status',
      ...status,
    }, null, 2));
  } finally {
    db.close();
  }
};

// idea #5 — git-versioned LLM-wiki CLI. Mirrors `vault`/`transcript`.
//   wiki project    — materialize the arbitrated CURRENT belief set into the
//                     git wiki tree + commit (GigaBrain-authored, deterministic).
//   wiki reconcile  — ingest HUMAN edits to the wiki back into the ledger as
//                     high-trust human_wiki facts that WIN arbitration.
//   wiki status     — read-only: enabled?, dir, HEAD, last generated sha, files.
// native.wiki.enabled:false (DEFAULT) → all subcommands are graceful no-ops.
const commandWiki = async () => {
  const subcommand = String(flags[0] || '').trim().toLowerCase();
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(JSON.stringify({
      ok: true,
      usage: 'node scripts/gigabrainctl.js wiki <project|reconcile|status> [--dry-run] [--db <path>] [--config <path>]',
    }, null, 2));
    return;
  }
  if (!['project', 'reconcile', 'status'].includes(subcommand)) {
    throw new Error(`unknown wiki subcommand: ${subcommand}`);
  }
  const subFlags = flags.slice(1);
  const dryRun = readBool('--dry-run', false, subFlags);

  const { config, dbPath } = loadConfigAndDbPath();
  const wiki = resolveWikiConfig(config);

  // Disabled → graceful no-op at zero cost (no repo, no disk, no DB walk).
  if (!wiki.enabled) {
    console.log(JSON.stringify({
      ok: true,
      command: 'wiki',
      subcommand,
      enabled: false,
      reason: 'native.wiki.enabled is false',
    }, null, 2));
    return;
  }

  if (subcommand === 'status') {
    // Read-only rollup: enabled, dir, whether a repo/commit exists, file count.
    const fsLocal = fs;
    const exists = fsLocal.existsSync(wiki.dir);
    let files = 0;
    try {
      const entitiesDir = path.join(wiki.dir, 'entities');
      if (fsLocal.existsSync(entitiesDir)) {
        files = fsLocal.readdirSync(entitiesDir).filter((f) => f.endsWith('.md')).length;
      }
    } catch { files = 0; }
    let state = {};
    try {
      state = JSON.parse(fsLocal.readFileSync(path.join(wiki.dir, '.gigabrain-wiki-state.json'), 'utf8')) || {};
    } catch { state = {}; }
    console.log(JSON.stringify({
      ok: true,
      command: 'wiki',
      subcommand: 'status',
      enabled: true,
      dir: wiki.dir,
      repo_exists: exists,
      files,
      last_generated_sha: state.generatedSha || null,
    }, null, 2));
    return;
  }

  const db = openDatabase(dbPath);
  try {
    if (subcommand === 'reconcile') {
      const summary = reconcileWiki({ db, config, dryRun });
      console.log(JSON.stringify({
        ok: !summary.error,
        command: 'wiki',
        subcommand: 'reconcile',
        dryRun,
        summary,
      }, null, 2));
      return;
    }
    // project
    const summary = projectWiki({ db, config, dryRun });
    console.log(JSON.stringify({
      ok: !summary.error,
      command: 'wiki',
      subcommand: 'project',
      dryRun,
      summary,
    }, null, 2));
  } finally {
    db.close();
  }
};

const commandControl = async () => {
  const subcommand = String(flags[0] || '').trim().toLowerCase();
  if (!subcommand || subcommand === '--help' || subcommand === '-h') {
    console.log(JSON.stringify({
      ok: true,
      usage: 'node scripts/gigabrainctl.js control apply --action <remember|update|replace|forget|protect|do_not_store|reinstate> [--target-memory-id <id> | --target <text>] [--content <text>] [--scope <scope>] [--type <type>] [--confidence <n>]',
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
    // The nightly audit writes roughly one review row per active memory per
    // night. Keep the newest no-op per memory to bound growth;
    // memory_events stays append-only by design (the provenance ledger).
    let reviewPurge = null;
    if (!dryRun) {
      try {
        reviewPurge = purgeNoopReviews({ dbPath });
      } catch (error) {
        reviewPurge = { ok: false, error: String(error?.message || error) };
      }
    }
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
      review_purge: reviewPurge,
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
  let cloudInboxNudges = [];
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
    // #6 cloud-inbox staleness nudge. Disabled (default) → [] (no check at all).
    // When enabled, a configured cloud source whose NEWEST export is older than
    // staleDays is surfaced as a non-fatal nudge to re-export from that cloud.
    cloudInboxNudges = cloudInboxStaleness({ db, config });
    const staleSources = cloudInboxNudges.filter((row) => row.status === 'stale');
    if (config?.native?.cloudInbox?.enabled === true) {
      checks.push({
        name: 'cloud_inbox_fresh',
        ok: staleSources.length === 0,
        stale: staleSources.map((row) => `${row.vendor} (${row.age_days}d > ${row.stale_days}d)`),
      });
    }
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
    cloud_inbox: cloudInboxNudges,
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
  // U16 read surface (agent-native review F3): list/filter review-queue
  // entries (incl. the U11/U13 escalation reason codes). READ-ONLY — listing
  // never rewrites or resolves entries; resolution is future scope. The
  // queue is file-based JSONL, so no db/world-model open is needed.
  if (action === 'queue') {
    const queuePath = String(config?.runtime?.paths?.reviewQueuePath || '').trim();
    const status = String(readFlag('--status', 'pending', reviewFlags)).trim().toLowerCase();
    const reasonCode = String(readFlag('--reason-code', '', reviewFlags)).trim().toLowerCase();
    const result = listQueueEntries(queuePath, {
      status,
      reasonCode,
      limit: Number(readFlag('--limit', '100', reviewFlags) || 100),
    });
    console.log(JSON.stringify({
      ok: true,
      action: 'review_queue',
      read_only: true,
      queuePath,
      status: status || null,
      reason_code: reasonCode || null,
      items: result.entries,
      count: result.entries.length,
      total: result.total,
      malformed_rows: result.malformed,
    }, null, 2));
    return;
  }
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
    // B1 shadow surface: per-host adaptive-trust view (base tier, stored
    // delta, fold target, effective value, evidence). dryRun — a review never
    // moves deltas or writes events; only the nightly step does.
    if (action === 'trust') {
      const summary = runAdaptiveTrust({ db, config, dryRun: true });
      console.log(JSON.stringify({
        ok: true,
        action: 'review_trust',
        read_only: true,
        shadow: summary.shadow,
        hosts: summary.hosts,
        fingerprint: summary.fingerprint,
      }, null, 2));
      return;
    }
    // U15 drill-down parity: CLI leg of the MCP + /gb/ + CLI triple for the
    // adjudication ledger and the bi-temporal as-of view.
    if (action === 'adjudications') {
      const states = String(readFlag('--states', '', reviewFlags) || '')
        .split(',')
        .map((item) => item.trim().toUpperCase())
        .filter(Boolean);
      const items = listAdjudications(db, {
        memoryId: readFlag('--memory-id', '', reviewFlags),
        states,
        limit: Number(readFlag('--limit', '100', reviewFlags) || 100),
      });
      console.log(JSON.stringify({ ok: true, action: 'review_adjudications', items, count: items.length }, null, 2));
      return;
    }
    if (action === 'beliefs-as-of') {
      const at = String(readFlag('--at', '', reviewFlags) || '').trim();
      if (!at || !Number.isFinite(Date.parse(at))) {
        throw new Error('review beliefs-as-of requires a parseable ISO --at timestamp');
      }
      const items = listBeliefsAsOf(db, {
        at,
        scope: readFlag('--scope', '', reviewFlags),
        limit: Number(readFlag('--limit', '200', reviewFlags) || 200),
      });
      console.log(JSON.stringify({ ok: true, action: 'review_beliefs_as_of', at, items, count: items.length }, null, 2));
      return;
    }
    throw new Error(`Unknown review action: ${action || '(none)'}`);
  } finally {
    db.close();
  }
};

const parseHostList = (list = flags) => {
  const raw = String(readFlag('--host', '', list) || readFlag('--hosts', '', list)).trim();
  if (!raw) return [];
  return raw.split(',').map((item) => item.trim()).filter(Boolean);
};

const SYNC_HOSTS_HELP = `Gigabrain sync-hosts

Usage:
  node scripts/gigabrainctl.js sync-hosts [flags]
  node scripts/gigabrainctl.js sync-hosts sources [flags]
  node scripts/gigabrainctl.js sync-hosts status [flags]
  node scripts/gigabrainctl.js sync-hosts export-brief [flags]

Commands:
  sync-hosts            Force/debug re-index of local host memories into Gigabrain
  sync-hosts sources    Show synced source counts and optional local discovery
  sync-hosts status     Show host sync diagnostics grouped by readiness
  sync-hosts export-brief Generate an AGENTS.md/CLAUDE.md/manual-import brief

Note:
  Host memories are now auto-ingested on \`npm run setup\` and on every nightly
  \`maintain\` run (budgeted host_sync step, per-host incremental cursor). This
  verb is the FORCE/DEBUG path: it re-indexes ALL detected lines (the cursor is
  not consulted) and is useful for targeting a single host or troubleshooting.

Flags:
  --config <path>       Gigabrain config path
  --host <list>         Comma-separated hosts, for example codex,claude_code,cursor,windsurf
  --scope <scope>       Target scope for imported memories
  --codex-home <path>   Override Codex home containing memories/
  --claude-home <path>  Override Claude home containing projects/
  --hermes-home <path>  Override Hermes home containing memories/
  --manual-import <path> Explicit manual cloud export file/folder
  --manual-source-host <host> chatgpt_manual|gemini_manual|copilot_manual|claude_manual
  --dry-run             Discover and parse without writing
  --no-arbitrate        Skip ingest-time arbitration (debug; nightly still arbitrates)

Examples:
  node scripts/gigabrainctl.js sync-hosts --config ~/.gigabrain/config.json --host codex,claude_code
  node scripts/gigabrainctl.js sync-hosts sources --config ~/.gigabrain/config.json --include-discovery
  node scripts/gigabrainctl.js sync-hosts export-brief --config ~/.gigabrain/config.json --target-host claude_code
`;

const commandSyncHosts = async () => {
  const action = ['sources', 'status', 'export-brief'].includes(String(flags[0] || '').trim().toLowerCase())
    ? String(flags[0] || '').trim().toLowerCase()
    : 'sync';
  const syncFlags = action === 'sync' ? flags : flags.slice(1);
  if (syncFlags.includes('--help') || syncFlags.includes('-h')) {
    console.log(SYNC_HOSTS_HELP.trim());
    return;
  }
  const { configPath, config, dbPath } = loadConfigAndDbPath();
  ensureDir(path.dirname(dbPath));
  const db = openDatabase(dbPath);
  const requestedHostsForSync = parseHostList(syncFlags);
  const manualImportPath = readFlag('--manual-import', '', syncFlags);
  const manualSourceHost = readFlag('--manual-source-host', 'chatgpt_manual', syncFlags);
  const effectiveHosts = requestedHostsForSync.length > 0
    ? requestedHostsForSync
    : (manualImportPath ? [manualSourceHost] : []);
  const common = {
    db,
    config,
    hosts: effectiveHosts,
    codexHome: readFlag('--codex-home', '', syncFlags),
    claudeHome: readFlag('--claude-home', '', syncFlags),
    hermesHome: readFlag('--hermes-home', '', syncFlags),
    workspaceRoot: readFlag('--workspace', '', syncFlags),
  };
  try {
    ensureProjectionStore(db);
    if (action === 'sources') {
      console.log(JSON.stringify({
        configPath,
        dbPath,
        ...listMemorySources({
          ...common,
          includeDiscovery: readBool('--include-discovery', false, syncFlags),
          manualImportPath,
          manualSourceHost,
        }),
      }, null, 2));
      return;
    }
    if (action === 'status') {
      console.log(JSON.stringify({
        configPath,
        dbPath,
        ...getSyncStatus(common),
      }, null, 2));
      return;
    }
    if (action === 'export-brief') {
      console.log(JSON.stringify({
        configPath,
        dbPath,
        ...exportMemoryBrief({
          db,
          config,
          targetHost: readFlag('--target-host', 'agents', syncFlags),
          scope: readFlag('--scope', '', syncFlags),
          limit: Number(readFlag('--limit', '25', syncFlags) || 25),
          allowAllScopes: readBool('--all-scopes', false, syncFlags),
        }),
      }, null, 2));
      return;
    }
    const result = syncHostMemories({
      ...common,
      scope: readFlag('--scope', '', syncFlags),
      dryRun: readBool('--dry-run', false, syncFlags),
      // Force/debug path: the cursor is NOT consulted (incremental defaults
      // off) so every detected line is re-indexed. Ingest-time arbitration
      // still runs (--no-arbitrate to skip) using the world-model projector.
      arbitrate: !readBool('--no-arbitrate', false, syncFlags),
      projectBeliefRows: projectArbitrationBeliefRows,
      manualImportPath,
      manualSourceHost,
    });
    console.log(JSON.stringify({
      configPath,
      dbPath,
      ...result,
    }, null, 2));
  } finally {
    db.close();
  }
};

const IMPORT_OPENCLAW_HELP = `Gigabrain import-openclaw

Usage:
  node scripts/gigabrainctl.js import-openclaw --registry /path/to/registry.sqlite [flags]

Flags:
  --config <path>       Gigabrain config path
  --db <path>           Target registry SQLite override
  --registry <path>     Legacy OpenClaw/Gigabrain registry.sqlite
  --memory-root <path>  Optional legacy memory folder for reporting/provenance
  --source-host <host>  Source host label, usually openclaw
  --source-label <name> Human label for this import, e.g. remote-host-backup-2026-02-12
  --dry-run             Read and count without writing

Examples:
  node scripts/gigabrainctl.js import-openclaw --config ~/.gigabrain/config.json --registry ~/.openclaw/gigabrain/memory/registry.sqlite --source-label remote-host-backup --dry-run
`;

const commandImportOpenClaw = async () => {
  if (flags.includes('--help') || flags.includes('-h')) {
    console.log(IMPORT_OPENCLAW_HELP.trim());
    return;
  }
  const registryPath = readFlag('--registry', '');
  if (!registryPath) {
    throw new Error('import-openclaw requires --registry /path/to/registry.sqlite');
  }
  const { configPath, dbPath } = loadConfigAndDbPath();
  ensureDir(path.dirname(dbPath));
  const db = openDatabase(dbPath);
  try {
    const result = importOpenClawRegistry({
      db,
      registryPath,
      memoryRoot: readFlag('--memory-root', ''),
      sourceHost: readFlag('--source-host', 'openclaw'),
      sourceLabel: readFlag('--source-label', ''),
      dryRun: readBool('--dry-run', false),
    });
    console.log(JSON.stringify({
      configPath,
      dbPath,
      ...result,
    }, null, 2));
  } finally {
    db.close();
  }
};

const PASSPORT_HELP = `Gigabrain Memory Audit + Handoff Records

Usage:
  node scripts/gigabrainctl.js handoff [flags]
  node scripts/gigabrainctl.js passport [flags]   (DEPRECATED alias of handoff)

Generates a static Memory Audit report (source inventory + trust-risk findings)
plus safe Handoff Records you can paste into another agent.

Flags:
  --config <path>       Gigabrain config path
  --db <path>           Registry SQLite path override
  --output-dir <path>   Directory for memory-audit.md/html/json and handoff-records/
  --format <list>       all|markdown|html|json|handoffs (comma-separated)
  --scope <scope>       Limit report and Handoff Record memories to a scope
  --limit <n>           Max rows per audit section
  --handoff-limit <n>   Max memories per generated Handoff Record
  --stale-days <n>      Mark memories stale when not updated within this many days
  --host <list>         Optional host discovery filter, for example codex,claude_code
  --codex-home <path>   Override Codex home containing memories/
  --claude-home <path>  Override Claude home containing projects/
  --workspace <path>    Workspace root for Cursor/Windsurf discovery
  --skip-handoffs       Do not write Handoff Record files

Examples:
  node scripts/gigabrainctl.js handoff --config ~/.gigabrain/config.json
  node scripts/gigabrainctl.js handoff --config ~/.gigabrain/config.json --scope profile:user --output-dir ./handoff-record
`;

const commandPassport = async () => {
  const passportFlags = flags;
  if (passportFlags.includes('--help') || passportFlags.includes('-h')) {
    console.log(PASSPORT_HELP.trim());
    return;
  }
  const { configPath, config, dbPath } = loadConfigAndDbPath();
  ensureDir(path.dirname(dbPath));
  const db = openDatabase(dbPath);
  try {
    ensureProjectionStore(db);
    const count = db.prepare('SELECT COUNT(*) AS c FROM memory_current').get()?.c || 0;
    if (Number(count) === 0) materializeProjectionFromMemories(db);
    const outputDir = path.resolve(readFlag(
      '--output-dir',
      path.join(String(config?.runtime?.paths?.outputDir || process.cwd()), 'memory-audit'),
      passportFlags,
    ));
    const requestedHostsForDiscovery = parseHostList(passportFlags);
    const passport = buildMemoryPassport({
      db,
      config,
      scope: readFlag('--scope', '', passportFlags),
      limit: Number(readFlag('--limit', '50', passportFlags) || 50),
      handoffLimit: Number(readFlag('--handoff-limit', '25', passportFlags) || 25),
      staleDays: Number(readFlag('--stale-days', '180', passportFlags) || 180),
      includeDiscovery: !passportFlags.includes('--skip-discovery'),
      hosts: requestedHostsForDiscovery,
      codexHome: readFlag('--codex-home', '', passportFlags),
      claudeHome: readFlag('--claude-home', '', passportFlags),
      workspaceRoot: readFlag('--workspace', '', passportFlags),
    });
    const files = writeMemoryPassport(passport, {
      outputDir,
      formats: readFlag('--format', 'all', passportFlags),
      includeHandoffs: !passportFlags.includes('--skip-handoffs'),
    });
    console.log(JSON.stringify({
      ok: true,
      action: 'memory_audit',
      configPath,
      dbPath,
      outputDir,
      files,
      summary: passport.summary,
      generated_at: passport.generated_at,
    }, null, 2));
  } finally {
    db.close();
  }
};

const commandExportBundle = async () => {
  const { configPath, dbPath } = loadConfigAndDbPath();
  ensureDir(path.dirname(dbPath));
  const db = openDatabase(dbPath);
  try {
    ensureProjectionStore(db);
    const count = db.prepare('SELECT COUNT(*) AS c FROM memory_current').get()?.c || 0;
    if (Number(count) === 0) materializeProjectionFromMemories(db);
    const outPath = path.resolve(readFlag('--out', './memory-bundle.json'));
    const bundle = exportPassportBundle({
      db,
      scope: readFlag('--scope', ''),
      includeEvents: readBool('--include-events', false),
    });
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({
      ok: true,
      action: 'export_bundle',
      configPath,
      dbPath,
      outPath,
      manifest: bundle.manifest,
    }, null, 2));
  } finally {
    db.close();
  }
};

const commandImportBundle = async () => {
  const inFlag = readFlag('--in', '');
  if (!inFlag) {
    throw new Error('import-bundle requires --in /path/to/memory-bundle.json');
  }
  const inPath = path.resolve(inFlag);
  const bundle = JSON.parse(fs.readFileSync(inPath, 'utf8'));
  const { configPath, config, dbPath } = loadConfigAndDbPath();
  ensureDir(path.dirname(dbPath));
  const db = openDatabase(dbPath);
  try {
    const result = importPassportBundle({
      db,
      bundle,
      skipIntegrityCheck: readBool('--skip-integrity-check', false),
      runId: readFlag('--run-id', `import-bundle-${new Date().toISOString()}`),
    });
    // The bundle carries memories only; beliefs/entities are derived state and
    // must be re-projected from the imported rows (see handoff-bundle.js).
    let worldModel = null;
    if (!readBool('--skip-world-rebuild', false)) {
      worldModel = rebuildWorldModel({ db, config });
    }
    console.log(JSON.stringify({
      ok: true,
      action: 'import_bundle',
      configPath,
      dbPath,
      inPath,
      result,
      world_model_rebuilt: Boolean(worldModel?.rebuilt),
    }, null, 2));
  } finally {
    db.close();
  }
};

const INIT_HELP = `Gigabrain init

Auto-detect installed coding agents on this machine and wire each one to
Gigabrain in a single, idempotent command. Re-running is safe: existing
config is merged, not overwritten.

Usage:
  node scripts/gigabrainctl.js init [flags]

Flags:
  --project-root <path>   Repo root to wire (default: cwd)
  --config <path>         Standalone Gigabrain config path override
  --store-mode <mode>     Store mode for per-host setup: global (default) or project-local
  --host <list>           Limit to specific hosts, e.g. codex,claude_code
  --codex-home <path>     Override Codex home (for detection)
  --claude-home <path>    Override Claude home (for detection)
  --hermes-home <path>    Override Hermes home (for detection)
  --dry-run               Detect hosts and report without running setup
  --help                  Print this help

Examples:
  node scripts/gigabrainctl.js init
  node scripts/gigabrainctl.js init --project-root /path/to/repo
  node scripts/gigabrainctl.js init --dry-run
`;

// Per-host setup wiring. cursor/windsurf are read-only synced surfaces with no
// standalone setup script, so init reports them as detected (sync-only) rather
// than running a setup script.
const INIT_HOST_SETUP = {
  codex: { script: 'gigabrain-codex-setup.js', mode: 'setup' },
  claude_code: { script: 'gigabrain-claude-setup.js', mode: 'setup' },
  hermes: { script: 'gigabrain-hermes-setup.js', mode: 'setup' },
  cursor: { script: '', mode: 'sync_only' },
  windsurf: { script: '', mode: 'sync_only' },
};

const runHostSetupScript = ({ script, projectRoot, configPath, storeMode } = {}) => {
  const scriptPath = path.join(THIS_DIR, script);
  const scriptArgs = [scriptPath, '--project-root', String(projectRoot)];
  if (configPath) scriptArgs.push('--config', String(configPath));
  if (storeMode) scriptArgs.push('--store-mode', String(storeMode));
  const run = spawnSync(process.execPath, scriptArgs, {
    cwd: THIS_DIR,
    encoding: 'utf8',
    timeout: 180000,
    env: process.env,
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
    ok,
    exitCode: Number(run.status ?? 1),
    configPath: parsed?.configPath || parsed?.standaloneConfigPath || '',
    stderr,
    stdout: parsed ? '' : stdout,
  };
};

const commandInit = async () => {
  if (flags.includes('--help') || flags.includes('-h')) {
    console.log(INIT_HELP.trim());
    return;
  }
  const projectRoot = path.resolve(readFlag('--project-root', process.cwd()));
  const explicitConfig = readFlag('--config', '');
  const storeMode = readFlag('--store-mode', '');
  const dryRun = readBool('--dry-run', false);
  const requestedHosts = parseHostList(flags);
  const requestedSet = requestedHosts.length > 0 ? new Set(requestedHosts) : null;

  // Reuse host discovery from host-memory-sync; resolveHostRoots stamps each
  // candidate root with `available` based on what is actually on disk.
  const roots = resolveHostRoots({
    codexHome: readFlag('--codex-home', ''),
    claudeHome: readFlag('--claude-home', ''),
    hermesHome: readFlag('--hermes-home', ''),
    workspaceRoot: projectRoot,
  });
  const detectedHosts = [...new Set(
    roots
      .filter((row) => row.available && INIT_HOST_SETUP[row.source_host])
      .map((row) => row.source_host),
  )].filter((host) => !requestedSet || requestedSet.has(host));

  const results = [];
  for (const host of detectedHosts) {
    const spec = INIT_HOST_SETUP[host];
    if (spec.mode === 'sync_only') {
      results.push({
        host,
        action: 'sync_only',
        ran: false,
        note: 'Read-only surface; wire memories with: gigabrainctl sync-hosts',
      });
      continue;
    }
    if (dryRun) {
      results.push({ host, action: 'setup', ran: false, reason: 'dry_run' });
      continue;
    }
    const setupResult = runHostSetupScript({
      script: spec.script,
      projectRoot,
      configPath: explicitConfig,
      storeMode,
    });
    results.push({
      host,
      action: 'setup',
      ran: true,
      ok: setupResult.ok,
      configPath: setupResult.configPath,
      ...(setupResult.ok ? {} : { exitCode: setupResult.exitCode, stderr: setupResult.stderr, stdout: setupResult.stdout }),
    });
  }

  const wiredHosts = results.filter((row) => row.action === 'setup' && row.ran && row.ok).map((row) => row.host);
  const failedHosts = results.filter((row) => row.action === 'setup' && row.ran && !row.ok).map((row) => row.host);
  const nextSteps = [];
  if (wiredHosts.length > 0) {
    nextSteps.push('Sync detected host memories: node scripts/gigabrainctl.js sync-hosts --config ~/.gigabrain/config.json');
    nextSteps.push('Generate a Memory Audit + Handoff Records: node scripts/gigabrainctl.js handoff --config ~/.gigabrain/config.json');
  } else if (detectedHosts.length === 0) {
    nextSteps.push('No installed agents detected on disk. Install Codex, Claude Code, or Hermes, then re-run init.');
  }

  console.log(JSON.stringify({
    ok: failedHosts.length === 0,
    command: 'init',
    projectRoot,
    dryRun,
    detectedHosts,
    wiredHosts,
    failedHosts,
    results,
    nextSteps,
  }, null, 2));
};

const main = async () => {
  if (command === 'init') {
    await commandInit();
    return;
  }
  if (command === 'sync-hosts') {
    await commandSyncHosts();
    return;
  }
  if (command === 'import-openclaw') {
    await commandImportOpenClaw();
    return;
  }
  if (command === 'handoff') {
    await commandPassport();
    return;
  }
  if (command === 'passport') {
    // Deprecated alias of `handoff`. Note goes to stderr so JSON stdout stays clean.
    console.error('[gigabrain] note: `passport` is deprecated; use `handoff` (the Handoff Record verb). This alias still works.');
    await commandPassport();
    return;
  }
  if (command === 'export-bundle') {
    await commandExportBundle();
    return;
  }
  if (command === 'import-bundle') {
    await commandImportBundle();
    return;
  }
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
  if (command === 'watch') {
    await commandWatch();
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
  if (command === 'migrate') {
    await commandMigrate();
    return;
  }
  if (command === 'vault') {
    await commandVault();
    return;
  }
  if (command === 'transcript') {
    await commandTranscript();
    return;
  }
  if (command === 'wiki') {
    await commandWiki();
    return;
  }
  throw new Error(`Unknown command: ${command || '(none)'}`);
};

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
