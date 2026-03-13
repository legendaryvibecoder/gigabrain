#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { bootstrapStandaloneStore } from '../lib/core/codex-service.js';
import {
  buildCodexMcpAddCommand,
  buildMcpLaunchArgs,
  createStandaloneCodexConfig,
  deriveProjectScope,
  ensureGitIgnoreEntry,
  normalizeStoreMode,
  upsertCodexAgentsBlock,
  writeCodexSupportFiles,
} from '../lib/core/codex-project.js';

const THIS_FILE = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(THIS_FILE), '..');

const HELP = `Gigabrain Codex setup

Usage:
  node scripts/gigabrain-codex-setup.js
  node scripts/gigabrain-codex-setup.js --project-root /path/to/repo
  node scripts/gigabrain-codex-setup.js --install-mcp

Flags:
  --project-root <path>      Repo root to wire for Codex (default: cwd)
  --config <path>            Standalone Gigabrain config path (default: ~/.codex/gigabrain/config.json)
  --store-mode <mode>        Store mode: global (default) or project-local
  --agents-path <path>       Project AGENTS.md path (default: <project>/AGENTS.md)
  --user-overlay-path <path> Optional personal user-store path (default: <store>/profile)
  --install-mcp             Run 'codex mcp add gigabrain ...' after setup
  --help                    Print this help
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

const expandHome = (value = '') => {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  if (raw === '~') return process.env.HOME || raw;
  if (raw.startsWith('~/')) return path.join(process.env.HOME || '', raw.slice(2));
  return raw;
};

const readJson = (filePath, fallback = {}) => {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
};

const mergeSetupConfig = ({
  projectRoot,
  storeRoot,
  storeMode = 'global',
  userOverlayPath,
  existing = {},
} = {}) => {
  const template = createStandaloneCodexConfig({
    projectRoot,
    storeMode,
    projectStorePath: storeRoot,
    userProfilePath: userOverlayPath,
    remoteBridge: existing?.remoteBridge || {},
  });
  return {
    ...template,
    ...existing,
    runtime: {
      ...template.runtime,
      ...(existing.runtime || {}),
      paths: {
        ...template.runtime.paths,
        ...(existing?.runtime?.paths || {}),
        workspaceRoot: template.runtime.paths.workspaceRoot,
        memoryRoot: template.runtime.paths.memoryRoot,
        registryPath: template.runtime.paths.registryPath,
        outputDir: template.runtime.paths.outputDir,
        reviewQueuePath: template.runtime.paths.reviewQueuePath,
      },
    },
    llm: {
      ...template.llm,
      ...(existing.llm || {}),
      review: {
        ...template.llm.review,
        ...(existing?.llm?.review || {}),
      },
    },
    vault: {
      ...template.vault,
      ...(existing.vault || {}),
    },
    codex: {
      ...template.codex,
      ...(existing.codex || {}),
      storeMode: template.codex.storeMode,
      projectRoot: template.codex.projectRoot,
      projectStorePath: template.codex.projectStorePath,
      userProfilePath: template.codex.userProfilePath,
      projectScope: template.codex.projectScope,
      defaultProjectScope: template.codex.defaultProjectScope,
      defaultUserScope: template.codex.defaultUserScope,
      defaultTarget: template.codex.defaultTarget,
      recallOrder: template.codex.recallOrder,
      userOverlayTypes: template.codex.userOverlayTypes,
    },
    remoteBridge: {
      ...template.remoteBridge,
      ...(existing.remoteBridge || {}),
    },
  };
};

const writeJsonPretty = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

const runMcpInstall = (configPath) => {
  const launchArgs = buildMcpLaunchArgs({
    packageRoot: PACKAGE_ROOT,
    configPath,
  });
  return spawnSync('codex', ['mcp', 'add', 'gigabrain', '--', ...launchArgs], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
  });
};

const main = async () => {
  if (hasFlag('--help') || hasFlag('-h')) {
    console.log(HELP.trim());
    return;
  }

  const projectRoot = path.resolve(expandHome(readFlag('--project-root', process.cwd())));
  const storeMode = normalizeStoreMode(readFlag('--store-mode', 'global'));
  const defaultConfigPath = storeMode === 'project_local'
    ? path.join(projectRoot, '.gigabrain', 'config.json')
    : path.join(process.env.HOME || '', '.codex', 'gigabrain', 'config.json');
  const configPath = path.resolve(expandHome(readFlag('--config', defaultConfigPath)));
  const agentsPath = path.resolve(expandHome(readFlag('--agents-path', path.join(projectRoot, 'AGENTS.md'))));
  const storeRoot = path.dirname(configPath);
  const userOverlayFlag = readFlag('--user-overlay-path', '');
  const userOverlayPath = userOverlayFlag ? path.resolve(expandHome(userOverlayFlag)) : '';
  const projectScope = deriveProjectScope(projectRoot);

  const existingConfig = readJson(configPath, {});
  const mergedConfig = mergeSetupConfig({
    projectRoot,
    storeRoot,
    storeMode,
    userOverlayPath,
    existing: existingConfig,
  });
  writeJsonPretty(configPath, mergedConfig);

  const gitignore = storeMode === 'project_local'
    ? ensureGitIgnoreEntry(projectRoot)
    : { changed: false, path: path.join(projectRoot, '.gitignore') };
  const agents = upsertCodexAgentsBlock(agentsPath, {
    projectScope,
    storeMode,
    storePath: storeRoot,
    userStorePath: mergedConfig.codex.userProfilePath,
  });
  const codexFiles = writeCodexSupportFiles({
    projectRoot,
    packageRoot: PACKAGE_ROOT,
    configPath,
    storeMode,
    projectScope,
    userStorePath: mergedConfig.codex.userProfilePath,
  });
  const bootstrap = bootstrapStandaloneStore({
    configPath,
  });
  const mcpCommand = buildCodexMcpAddCommand({
    packageRoot: PACKAGE_ROOT,
    configPath,
  });

  let mcpInstall = {
    status: 'skipped',
  };
  if (hasFlag('--install-mcp')) {
    const install = runMcpInstall(configPath);
    mcpInstall = {
      status: install.status === 0 ? 'installed' : 'failed',
      exitCode: Number(install.status ?? 1),
      stdout: String(install.stdout || '').trim(),
      stderr: String(install.stderr || '').trim(),
    };
  }

  console.log(JSON.stringify({
    ok: true,
    projectRoot,
    configPath,
    storeRoot,
    projectStorePath: mergedConfig.codex.projectStorePath,
    storeMode,
    projectScope,
    defaultProjectScope: mergedConfig.codex.defaultProjectScope,
    userOverlayPath: mergedConfig.codex.userProfilePath,
    userStorePath: mergedConfig.codex.userProfilePath,
    bootstrap,
    gitignore,
    agents,
    codex: codexFiles,
    mcpCommand,
    mcpInstall,
    nextSteps: [
      `Run ${mcpCommand}`,
      `Use gigabrain_recall for continuity, gigabrain_remember for explicit durable saves, and gigabrain_checkpoint at task end in Codex App.`,
      `Run npx gigabrain-codex-checkpoint --config ${configPath} --summary "Completed ..." after meaningful work if you want episodic session capture.`,
      `Run npx gigabrainctl doctor --config ${configPath} --target both to verify the repo store and personal user store.`,
      `Run npx gigabrainctl maintain --config ${configPath} when you want manual consolidation in Codex mode.`,
    ],
  }, null, 2));
};

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
