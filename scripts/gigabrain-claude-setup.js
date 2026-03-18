#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bootstrapStandaloneStore } from '../lib/core/codex-service.js';
import {
  createStandaloneCodexConfig,
  deriveProjectScope,
  ensureGitIgnoreEntry,
  normalizeStoreMode,
} from '../lib/core/codex-project.js';
import {
  upsertClaudeMarkdownBlock,
  upsertClaudeMcpConfig,
  writeClaudeSupportFiles,
} from '../lib/core/claude-project.js';
import {
  describeStandaloneConfigPath,
  expandHome,
  readJson,
  resolveStandaloneConfigPath,
  writeJsonPretty,
} from '../lib/core/standalone-client.js';

const THIS_FILE = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(THIS_FILE), '..');

const HELP = `Gigabrain Claude setup

Usage:
  node scripts/gigabrain-claude-setup.js
  node scripts/gigabrain-claude-setup.js --project-root /path/to/repo

Flags:
  --project-root <path>      Repo root to wire for Claude Code/Desktop (default: cwd)
  --config <path>            Standalone Gigabrain config path (default: ~/.gigabrain/config.json, legacy ~/.codex/gigabrain/config.json reused if present)
  --store-mode <mode>        Store mode: global (default) or project-local
  --claude-md-path <path>    Claude instructions file (default: <project>/CLAUDE.md)
  --mcp-path <path>          Claude MCP config file (default: <project>/.mcp.json)
  --user-overlay-path <path> Optional personal user-store path (default: <store>/profile)
  --help                     Print this help
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
  const claudePath = path.resolve(expandHome(readFlag('--claude-md-path', path.join(projectRoot, 'CLAUDE.md'))));
  const mcpPath = path.resolve(expandHome(readFlag('--mcp-path', path.join(projectRoot, '.mcp.json'))));
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
  const claude = upsertClaudeMarkdownBlock(claudePath, {
    projectScope,
    storeMode,
    storePath: storeRoot,
    userStorePath: mergedConfig.codex.userProfilePath,
  });
  const mcp = upsertClaudeMcpConfig({
    mcpPath,
    projectRoot,
  });
  const claudeFiles = writeClaudeSupportFiles({
    projectRoot,
    packageRoot: PACKAGE_ROOT,
    configPath,
    storeMode,
    projectScope,
    userStorePath: mergedConfig.codex.userProfilePath,
    claudePath,
    mcpPath,
  });
  const bootstrap = bootstrapStandaloneStore({
    configPath,
  });
  const standalonePath = describeStandaloneConfigPath({
    configPath,
    projectRoot,
    storeMode,
  });

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
    claude,
    mcp,
    claudeFiles,
    nextSteps: [
      `Shared standalone mode is ${standalonePath.sharingMode}; Claude and Codex will share ${storeRoot} only when they point at the same config.`,
      `Repo memory stays separated by scope (${projectScope}); personal memory is shared through ${mergedConfig.codex.userProfilePath}.`,
      `Use --store-mode project-local if you want this repo isolated from other Claude/Codex workspaces.`,
      `Open ${claudePath} to review the Gigabrain Claude memory block.`,
      `Open ${mcpPath} to confirm the local Gigabrain MCP entry for Claude Code.`,
      'Use Gigabrain through MCP first once Claude is reading the local launcher. Do not hardcode node ~/.npm/_npx/.../scripts/gigabrainctl.js cache paths.',
      `Run ${path.join(projectRoot, '.claude', 'actions', 'verify-gigabrain.sh')} before hand-editing config. Absolute fallback: npx gigabrainctl doctor --config ${configPath} --target both.`,
      `Run .claude/actions/checkpoint-gigabrain-session.sh --summary "Completed ..." after meaningful work if you want episodic session capture.`,
      `Run npm run claude:desktop:bundle to build the local Claude Desktop extension bundle.`,
    ],
  }, null, 2));
};

main().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
