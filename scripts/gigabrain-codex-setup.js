#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { bootstrapStandaloneStore } from '../lib/core/codex-service.js';
import {
  buildCodexMcpAddCommand,
  createStandaloneCodexConfig,
  deriveProjectScope,
  ensureGitIgnoreEntry,
  normalizeStoreMode,
  upsertCodexAgentsBlock,
  writeCodexSupportFiles,
} from '../lib/core/codex-project.js';
import {
  describeStandaloneConfigPath,
  expandHome,
  readJson,
  resolveStandaloneConfigPath,
  writeJsonPretty,
} from '../lib/core/standalone-client.js';

const THIS_FILE = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(THIS_FILE), '..');

const HELP = `Gigabrain Codex setup

Usage:
  node scripts/gigabrain-codex-setup.js
  node scripts/gigabrain-codex-setup.js --project-root /path/to/repo
  node scripts/gigabrain-codex-setup.js --install-mcp

Flags:
  --project-root <path>      Repo root to wire for Codex (default: cwd)
  --config <path>            Standalone Gigabrain config path (default: ~/.gigabrain/config.json, legacy ~/.codex/gigabrain/config.json reused if present)
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

const runMcpInstall = (projectRoot) => {
  return spawnSync('codex', ['mcp', 'add', 'gigabrain', '--', '/bin/sh', path.join(projectRoot, '.codex', 'actions', 'launch-gigabrain-mcp.sh')], {
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
  const resolvedPath = resolveStandaloneConfigPath({
    explicitConfigPath: readFlag('--config', ''),
    projectRoot,
    storeMode,
  });
  const configPath = resolvedPath.configPath;
  const agentsPath = path.resolve(expandHome(readFlag('--agents-path', path.join(projectRoot, 'AGENTS.md'))));
  const storeRoot = resolvedPath.storeRoot;
  const userOverlayFlag = readFlag('--user-overlay-path', '');
  const userOverlayPath = userOverlayFlag ? path.resolve(expandHome(userOverlayFlag)) : '';
  const projectScope = deriveProjectScope(projectRoot);

  const existingConfig = readJson(configPath, {}, {
    failOnMalformed: true,
    label: 'standalone Gigabrain config',
  });
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
  const standalonePath = describeStandaloneConfigPath({
    configPath,
    projectRoot,
    storeMode,
  });
  const mcpCommand = buildCodexMcpAddCommand({
    projectRoot,
  });

  let mcpInstall = {
    status: 'skipped',
  };
  if (hasFlag('--install-mcp')) {
    const install = runMcpInstall(projectRoot);
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
    sharingMode: standalonePath.sharingMode,
    standalonePathKind: standalonePath.pathKind,
    standaloneConfigPath: configPath,
    standaloneStoreRoot: storeRoot,
    legacyStandalonePath: standalonePath.legacyConfigPath,
    canonicalStandalonePath: standalonePath.canonicalConfigPath,
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
      `Shared standalone mode is ${standalonePath.sharingMode}; Codex and Claude will share ${storeRoot} only when they point at the same config.`,
      `Repo memory stays separated by scope (${projectScope}); personal memory is shared through ${mergedConfig.codex.userProfilePath}.`,
      `Use --store-mode project-local if you want this repo isolated from other Codex/Claude workspaces.`,
      `Run ${path.join(projectRoot, '.codex', 'actions', 'install-gigabrain-mcp.sh')} or ${mcpCommand}.`,
      'Use Gigabrain through MCP first once it is registered in Codex. Do not hardcode node ~/.npm/_npx/.../scripts/gigabrainctl.js cache paths.',
      `Run ${path.join(projectRoot, '.codex', 'actions', 'verify-gigabrain.sh')} before hand-editing config. Absolute fallback: npx gigabrainctl doctor --config ${configPath} --target both.`,
      `Run npx gigabrain-codex-checkpoint --config ${configPath} --summary "Completed ..." after meaningful work if you want episodic session capture.`,
      `Run npx gigabrainctl maintain --config ${configPath} when you want manual consolidation in Codex mode.`,
    ],
  }, null, 2));
};

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
