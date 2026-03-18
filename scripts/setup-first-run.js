#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDatabase } from '../lib/core/sqlite.js';
import { ensureProjectionStore, materializeProjectionFromMemories } from '../lib/core/projection-store.js';
import { ensureEventStore } from '../lib/core/event-store.js';
import { ensureNativeStore, syncNativeMemory } from '../lib/core/native-sync.js';
import { ensurePersonStore, rebuildEntityMentions } from '../lib/core/person-service.js';
import { loadResolvedConfig } from '../lib/core/config.js';
import { buildVaultSurface } from '../lib/core/vault-mirror.js';

const HELP = `Gigabrain first-run setup

Usage:
  npm run setup
  npm run setup -- --config ~/.openclaw/openclaw.json --workspace ~/my-workspace
  npm run setup -- --skip-agents --skip-restart

Flags:
  --config <path>       Path to openclaw.json (default: ~/.openclaw/openclaw.json or $OPENCLAW_CONFIG)
  --workspace <path>    Workspace root for Gigabrain runtime paths
  --agents-path <path>  AGENTS.md path (default: <workspace>/AGENTS.md)
  --vault-path <path>   Vault root for the generated Obsidian surface
  --vault-subdir <name> Subdirectory inside the vault root (default: Gigabrain)
  --skip-vault          Do not enable/build the Obsidian memory surface
  --skip-agents         Do not add/update AGENTS.md memory protocol block
  --skip-restart        Do not run 'openclaw gateway restart'
  --help                Print this help
`;

const START_MARKER = '<!-- GIGABRAIN_MEMORY_PROTOCOL_START -->';
const END_MARKER = '<!-- GIGABRAIN_MEMORY_PROTOCOL_END -->';
const MEMORY_BLOCK = `${START_MARKER}
## Memory

Gigabrain uses a hybrid memory model.

- Native markdown (\`MEMORY.md\` and \`memory/YYYY-MM-DD.md\`) is the human-readable layer.
- The Gigabrain registry is the structured recall layer built on top.
- Gigabrain is the primary memory layer for normal recall answers in this workspace.
- Use injected Gigabrain context first before reaching for deeper verification tools.
- Only use \`memory_search\` / \`memory_get\` for explicit verification, exact source, exact wording, or exact date questions.
- Do not mention provenance, file paths, line numbers, memory ids, or source mechanics unless the user explicitly asks.

### Remember Behavior

When the user explicitly asks you to remember or save something
(for example: "remember that", "remember this", "merk dir das", "note this down", "save this preference"):

1. Treat it as an explicit memory-save request.
2. Keep the remembered fact short, concrete, and self-contained.
3. Gigabrain will project explicit remembers into native markdown and the structured registry when configured.
4. Do not explain internal storage mechanics unless the user asks.

### Internal Capture Protocol

For explicit remembers, emit a \`<memory_note>\` tag with the fact:
   \`\`\`xml
   <memory_note type="USER_FACT" confidence="0.9">Concrete fact here.</memory_note>
   \`\`\`
- Use one tag per fact.
- Choose the appropriate type (USER_FACT, PREFERENCE, DECISION, ENTITY, EPISODE, AGENT_IDENTITY, CONTEXT).
- Do not mention the internal \`<memory_note>\` protocol to the user.

When the user does NOT explicitly ask to save memory:
- Do NOT emit \`<memory_note>\` tags.
- Normal conversation does not trigger memory capture.

When answering normal memory questions:
- Prefer the already injected Gigabrain memory context first.
- Treat \`memory_search\` / \`memory_get\` as verification tools, not as the default first step.
- If the user asks "where is that written?", "what is the exact wording?", or "what exact date was that?", verification tools are appropriate.

Never include secrets, credentials, tokens, or API keys in memory notes.
${END_MARKER}
`;

const args = process.argv.slice(2);
const readFlag = (name, fallback = '') => {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1] && !String(args[idx + 1]).startsWith('--')) return String(args[idx + 1]);
  const withEq = args.find((item) => String(item || '').startsWith(`${name}=`));
  if (withEq) return String(withEq.split('=').slice(1).join('='));
  return fallback;
};
const hasFlag = (name) => args.includes(name);

const expandHome = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return raw;
};

const resolveAbsolute = (value) => path.resolve(expandHome(value));

const defaultOpenclawConfigPath = () => {
  const fromEnv = expandHome(process.env.OPENCLAW_CONFIG || '');
  if (fromEnv) return resolveAbsolute(fromEnv);
  return path.join(os.homedir(), '.openclaw', 'openclaw.json');
};

const readJson = (filePath, fallback) => {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
};

const ensureDir = (dirPath) => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const ensureObject = (parent, key) => {
  if (!parent[key] || typeof parent[key] !== 'object' || Array.isArray(parent[key])) {
    parent[key] = {};
  }
  return parent[key];
};

const upsertMarkedBlock = ({ existing, startMarker, endMarker, block }) => {
  const start = existing.indexOf(startMarker);
  const end = existing.indexOf(endMarker);
  if (start !== -1 && end !== -1 && end >= start) {
    const before = existing.slice(0, start).trimEnd();
    const after = existing.slice(end + endMarker.length).trimStart();
    const next = [
      before,
      block,
      after,
    ].filter((part) => String(part || '').trim().length > 0).join('\n\n');
    return `${next}\n`;
  }
  return existing.trim().length > 0
    ? `${existing.trimEnd()}\n\n${block}\n`
    : `${block}\n`;
};

const upsertAgentsBlock = (agentsPath) => {
  const targetDir = path.dirname(agentsPath);
  ensureDir(targetDir);
  const existing = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : '';
  const next = upsertMarkedBlock({
    existing,
    startMarker: START_MARKER,
    endMarker: END_MARKER,
    block: MEMORY_BLOCK,
  });
  const changed = next !== existing;
  if (changed) fs.writeFileSync(agentsPath, next, 'utf8');
  return { changed, path: agentsPath };
};

const writeJsonPretty = (filePath, obj) => {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
};

const run = (cmd, cmdArgs, options = {}) => {
  const child = spawnSync(cmd, cmdArgs, {
    stdio: 'inherit',
    ...options,
  });
  return child.status === 0;
};

const bootstrapDatabase = ({ configPath, workspaceRoot }) => {
  const loaded = loadResolvedConfig({
    configPath,
    workspaceRoot,
  });
  const config = loaded.config;
  const dbPath = path.resolve(String(config?.runtime?.paths?.registryPath || ''));
  if (!dbPath) throw new Error('Could not resolve registry path from config');
  ensureDir(path.dirname(dbPath));

  const db = openDatabase(dbPath);
  let projectionImport = 0;
  let nativeChangedFiles = 0;
  let nativeInsertedChunks = 0;
  try {
    ensureProjectionStore(db);
    ensureEventStore(db);
    ensureNativeStore(db);
    ensurePersonStore(db);
    const imported = materializeProjectionFromMemories(db);
    projectionImport = Number(imported?.imported || 0);
    const nativeResult = syncNativeMemory({
      db,
      config,
      dryRun: false,
    });
    nativeChangedFiles = Number(nativeResult?.changed_files || 0);
    nativeInsertedChunks = Number(nativeResult?.inserted_chunks || 0);
    rebuildEntityMentions(db);
  } finally {
    db.close();
  }
  return {
    dbPath,
    projectionImport,
    nativeChangedFiles,
    nativeInsertedChunks,
  };
};

const main = () => {
  if (hasFlag('--help') || hasFlag('-h')) {
    console.log(HELP.trim());
    return;
  }

  const configPath = resolveAbsolute(readFlag('--config', defaultOpenclawConfigPath()));
  const requestedWorkspace = readFlag('--workspace', '');
  const requestedVaultPathRaw = readFlag('--vault-path', '');
  const requestedVaultPath = requestedVaultPathRaw ? resolveAbsolute(requestedVaultPathRaw) : '';
  const requestedVaultSubdir = readFlag('--vault-subdir', '');
  const skipVault = hasFlag('--skip-vault');
  const skipAgents = hasFlag('--skip-agents');
  const skipRestart = hasFlag('--skip-restart');

  const openclawConfig = readJson(configPath, {});
  if (!openclawConfig || typeof openclawConfig !== 'object' || Array.isArray(openclawConfig)) {
    throw new Error(`openclaw config at ${configPath} is not a JSON object`);
  }

  const plugins = ensureObject(openclawConfig, 'plugins');
  const slots = ensureObject(plugins, 'slots');
  const memory = ensureObject(openclawConfig, 'memory');
  const entries = ensureObject(plugins, 'entries');
  const gigabrain = ensureObject(entries, 'gigabrain');
  const gigabrainConfig = ensureObject(gigabrain, 'config');
  const runtime = ensureObject(gigabrainConfig, 'runtime');
  const runtimePaths = ensureObject(runtime, 'paths');
  const capture = ensureObject(gigabrainConfig, 'capture');
  const rememberIntent = ensureObject(capture, 'rememberIntent');
  const nativePromotion = ensureObject(gigabrainConfig, 'nativePromotion');
  const orchestrator = ensureObject(gigabrainConfig, 'orchestrator');
  const worldModel = ensureObject(gigabrainConfig, 'worldModel');
  const topicEntities = ensureObject(worldModel, 'topicEntities');
  const vault = ensureObject(gigabrainConfig, 'vault');
  const vaultViews = ensureObject(vault, 'views');
  const vaultReports = ensureObject(vault, 'reports');

  const existingWorkspace = String(runtimePaths.workspaceRoot || '').trim();
  const workspaceRoot = resolveAbsolute(
    requestedWorkspace
      || existingWorkspace
      || process.env.OPENCLAW_WORKSPACE_ROOT
      || path.join(os.homedir(), '.openclaw', 'gigabrain-workspace'),
  );
  const registryPath = resolveAbsolute(
    String(runtimePaths.registryPath || '').trim()
      || path.join(workspaceRoot, 'memory', 'registry.sqlite'),
  );
  const memoryRootRaw = String(runtimePaths.memoryRoot || 'memory').trim() || 'memory';
  const outputDirRaw = String(runtimePaths.outputDir || 'output').trim() || 'output';
  const memoryRootPath = path.isAbsolute(memoryRootRaw)
    ? memoryRootRaw
    : path.join(workspaceRoot, memoryRootRaw);
  const outputDirPath = path.isAbsolute(outputDirRaw)
    ? outputDirRaw
    : path.join(workspaceRoot, outputDirRaw);

  gigabrain.enabled = true;
  slots.memory = 'gigabrain';
  gigabrainConfig.enabled = true;
  runtimePaths.workspaceRoot = workspaceRoot;
  runtimePaths.memoryRoot = memoryRootRaw;
  runtimePaths.outputDir = outputDirRaw;
  runtimePaths.registryPath = registryPath;
  if (!String(runtimePaths.reviewQueuePath || '').trim()) {
    runtimePaths.reviewQueuePath = 'output/memory-review-queue.jsonl';
  }

  if (capture.enabled === undefined) capture.enabled = true;
  if (capture.requireMemoryNote === undefined) capture.requireMemoryNote = true;
  if (rememberIntent.enabled === undefined) rememberIntent.enabled = true;
  if (!Array.isArray(rememberIntent.phrasesBase) || rememberIntent.phrasesBase.length === 0) {
    rememberIntent.phrasesBase = [
      'remember this',
      'remember that',
      'merk dir',
      'note this',
      'note that',
      'note this down',
      'save this',
      'save this preference',
    ];
  }
  if (rememberIntent.writeNative === undefined) rememberIntent.writeNative = true;
  if (rememberIntent.writeRegistry === undefined) rememberIntent.writeRegistry = true;

  if (nativePromotion.enabled === undefined) nativePromotion.enabled = true;
  if (nativePromotion.promoteFromDaily === undefined) nativePromotion.promoteFromDaily = true;
  if (nativePromotion.promoteFromMemoryMd === undefined) nativePromotion.promoteFromMemoryMd = true;
  if (nativePromotion.minConfidence === undefined) nativePromotion.minConfidence = 0.72;
  if (memory.citations === undefined) memory.citations = 'off';
  if (orchestrator.allowDeepLookup === undefined) orchestrator.allowDeepLookup = true;
  if (!Array.isArray(orchestrator.deepLookupRequires) || orchestrator.deepLookupRequires.length === 0) {
    orchestrator.deepLookupRequires = ['explicit', 'exact_date', 'source_request', 'exact_wording', 'low_confidence_no_brief'];
  }
  if (orchestrator.profileFirst === undefined) orchestrator.profileFirst = true;
  if (orchestrator.entityLockEnabled === undefined) orchestrator.entityLockEnabled = true;
  if (orchestrator.strategyRerankEnabled === undefined) orchestrator.strategyRerankEnabled = true;
  if (orchestrator.lowConfidenceNoBriefThreshold === undefined) orchestrator.lowConfidenceNoBriefThreshold = 0.62;
  if (orchestrator.entityLockMinScore === undefined) orchestrator.entityLockMinScore = 0.58;
  if (!Array.isArray(orchestrator.temporalEntityPenaltyKinds) || orchestrator.temporalEntityPenaltyKinds.length === 0) {
    orchestrator.temporalEntityPenaltyKinds = ['topic'];
  }
  if (worldModel.enabled === undefined) worldModel.enabled = true;
  if (!Array.isArray(worldModel.entityKinds) || worldModel.entityKinds.length === 0) {
    worldModel.entityKinds = ['person', 'project', 'organization', 'place', 'topic'];
  }
  if (worldModel.surfaceEntityMinConfidence === undefined) worldModel.surfaceEntityMinConfidence = 0.78;
  if (worldModel.surfaceEntityMinEvidence === undefined) worldModel.surfaceEntityMinEvidence = 2;
  if (!Array.isArray(worldModel.surfaceEntityKinds) || worldModel.surfaceEntityKinds.length === 0) {
    worldModel.surfaceEntityKinds = ['person', 'project', 'organization'];
  }
  if (!String(topicEntities.mode || '').trim()) topicEntities.mode = 'strict_hidden';
  if (topicEntities.minEvidenceCount === undefined) topicEntities.minEvidenceCount = 2;
  if (topicEntities.requireCuratedOrMemoryMd === undefined) topicEntities.requireCuratedOrMemoryMd = true;
  if (topicEntities.minAliasLength === undefined) topicEntities.minAliasLength = 4;
  if (topicEntities.exportToSurface === undefined) topicEntities.exportToSurface = false;
  if (topicEntities.allowForRecall === undefined) topicEntities.allowForRecall = true;
  if (topicEntities.maxGenerated === undefined) topicEntities.maxGenerated = 80;

  if (skipVault) {
    vault.enabled = false;
  } else if (vault.enabled === undefined) {
    vault.enabled = true;
  }
  if (requestedVaultPath) {
    vault.path = requestedVaultPath;
  } else if (!String(vault.path || '').trim()) {
    vault.path = 'obsidian-vault';
  }
  if (requestedVaultSubdir) {
    vault.subdir = requestedVaultSubdir;
  } else if (!String(vault.subdir || '').trim()) {
    vault.subdir = 'Gigabrain';
  }
  if (vault.clean === undefined) vault.clean = true;
  if (!String(vault.homeNoteName || '').trim()) vault.homeNoteName = 'Home';
  if (vault.exportActiveNodes === undefined) vault.exportActiveNodes = false;
  if (vault.exportRecentArchivesLimit === undefined) vault.exportRecentArchivesLimit = 200;
  if (!Array.isArray(vault.manualFolders) || vault.manualFolders.length === 0) {
    vault.manualFolders = ['Inbox', 'Manual'];
  }
  if (vaultViews.enabled === undefined) vaultViews.enabled = true;
  if (vaultReports.enabled === undefined) vaultReports.enabled = true;
  const surface = ensureObject(gigabrainConfig, 'surface');
  const obsidian = ensureObject(surface, 'obsidian');
  if (!String(obsidian.mode || '').trim()) obsidian.mode = 'curated';
  if (obsidian.exportDiagnostics === undefined) obsidian.exportDiagnostics = false;
  if (!String(obsidian.exportEntityPages || '').trim()) obsidian.exportEntityPages = 'stable_only';

  ensureDir(workspaceRoot);
  ensureDir(memoryRootPath);
  ensureDir(outputDirPath);
  ensureDir(path.dirname(registryPath));

  writeJsonPretty(configPath, openclawConfig);
  const bootstrap = bootstrapDatabase({
    configPath,
    workspaceRoot,
  });
  const resolved = loadResolvedConfig({
    configPath,
    workspaceRoot,
  });

  let vaultResult = {
    enabled: resolved.config?.vault?.enabled === true,
    built: false,
    surfacePath: '',
    homeNotePath: '',
    activeNodes: 0,
    sourceFiles: 0,
  };
  if (resolved.config?.vault?.enabled === true) {
    const db = openDatabase(bootstrap.dbPath);
    try {
      const surface = buildVaultSurface({
        db,
        dbPath: bootstrap.dbPath,
        config: resolved.config,
        dryRun: false,
        runId: 'setup-first-run',
      });
      const surfacePath = path.join(
        String(surface.vault_root || resolved.config.vault.path || ''),
        String(surface.subdir || resolved.config.vault.subdir || 'Gigabrain'),
      );
      vaultResult = {
        enabled: true,
        built: true,
        surfacePath,
        homeNotePath: path.join(surfacePath, '00 Home', `${String(resolved.config.vault.homeNoteName || 'Home')}.md`),
        activeNodes: Number(surface.active_nodes || 0),
        sourceFiles: Number(surface.source_files || 0),
      };
    } finally {
      db.close();
    }
  }

  let agentsResult = { changed: false, path: '' };
  if (!skipAgents) {
    const agentsPath = resolveAbsolute(readFlag('--agents-path', path.join(workspaceRoot, 'AGENTS.md')));
    agentsResult = upsertAgentsBlock(agentsPath);
  }

  let restartOk = true;
  if (!skipRestart) {
    restartOk = run('openclaw', ['gateway', 'restart']);
  }

  const nextSteps = [];
  if (restartOk || skipRestart) {
    nextSteps.push('Run a chat and try: "Remember that my preference is concise status updates."');
  } else {
    nextSteps.push("Run 'openclaw gateway restart' manually, then test memory capture.");
  }
  if (vaultResult.enabled) {
    nextSteps.push(`Install Obsidian (recommended) and open ${vaultResult.surfacePath}. Start at ${vaultResult.homeNotePath}.`);
    nextSteps.push('If the surface looks sparse, that is normal on a fresh install: add native notes or save a few memories first.');
  }

  const summary = {
    ok: restartOk || skipRestart,
    configPath,
    workspaceRoot,
    registryPath: bootstrap.dbPath,
    bootstrap,
    vault: vaultResult,
    agents: skipAgents ? 'skipped' : (agentsResult.changed ? `updated:${agentsResult.path}` : `already_present:${agentsResult.path}`),
    gatewayRestart: skipRestart ? 'skipped' : (restartOk ? 'ok' : 'failed'),
    nextStep: nextSteps[0] || '',
    nextSteps,
  };
  console.log(JSON.stringify(summary, null, 2));
};

main();
