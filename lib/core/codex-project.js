import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

import {
  DEFAULT_GLOBAL_STANDALONE_STORE,
  defaultUserOverlayPathForStore,
  expandHome,
  normalizeStandaloneStoreMode,
  shellEscape,
  upsertMarkedBlock,
  ensureGitIgnoreEntry,
  writeExecutableFile,
  buildNodeOptionsExportSnippet,
  buildGigabrainCliResolverSnippet,
} from './standalone-client.js';

const CODEX_AGENTS_START = '<!-- GIGABRAIN_CODEX_MEMORY_START -->';
const CODEX_AGENTS_END = '<!-- GIGABRAIN_CODEX_MEMORY_END -->';

const normalizeStoreMode = (value = '') => {
  return normalizeStandaloneStoreMode(value);
};

const slugify = (value = '') => {
  const input = String(value || '').toLowerCase();
  let out = '';
  let lastWasDash = false;
  for (const char of input) {
    const code = char.charCodeAt(0);
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (isLower || isDigit) {
      out += char;
      lastWasDash = false;
      continue;
    }
    if (!lastWasDash && out) {
      out += '-';
      lastWasDash = true;
    }
  }
  if (out.endsWith('-')) out = out.slice(0, -1);
  return out.slice(0, 40);
};

const deriveProjectScope = (projectRoot = '') => {
  const resolved = path.resolve(String(projectRoot || process.cwd()));
  const base = slugify(path.basename(resolved)) || 'workspace';
  const hash = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 8);
  return `project:${base}:${hash}`;
};

const createStandaloneCodexConfig = ({
  projectRoot,
  storeMode = 'global',
  projectStorePath = '',
  userProfilePath = '',
  remoteBridge = {},
} = {}) => {
  const resolvedProjectRoot = path.resolve(String(projectRoot || process.cwd()));
  const normalizedStoreMode = normalizeStoreMode(storeMode);
  const defaultStoreRoot = normalizedStoreMode === 'project_local'
    ? path.join(resolvedProjectRoot, '.gigabrain')
    : DEFAULT_GLOBAL_STANDALONE_STORE;
  const resolvedProjectStorePath = path.resolve(expandHome(projectStorePath || defaultStoreRoot));
  const resolvedUserProfilePath = userProfilePath
    ? path.resolve(expandHome(String(userProfilePath)))
    : defaultUserOverlayPathForStore(resolvedProjectStorePath);
  const projectScope = deriveProjectScope(resolvedProjectRoot);
  const recallOrder = ['project', 'user', 'remote'];

  return {
    enabled: true,
    runtime: {
      cleanupVersion: 'v3.0.0-codex',
      paths: {
        workspaceRoot: resolvedProjectStorePath,
        memoryRoot: 'memory',
        registryPath: 'memory/registry.sqlite',
        outputDir: 'output',
        reviewQueuePath: 'output/memory-review-queue.jsonl',
      },
    },
    llm: {
      provider: 'none',
      review: {
        enabled: false,
      },
    },
    vault: {
      enabled: false,
    },
    codex: {
      enabled: true,
      storeMode: normalizedStoreMode,
      projectRoot: resolvedProjectRoot,
      projectStorePath: resolvedProjectStorePath,
      userProfilePath: resolvedUserProfilePath,
      projectScope,
      defaultProjectScope: projectScope,
      defaultUserScope: 'profile:user',
      defaultTarget: 'project',
      recallOrder,
      userOverlayTypes: ['PREFERENCE', 'USER_FACT', 'AGENT_IDENTITY', 'DECISION'],
    },
    remoteBridge: {
      enabled: remoteBridge?.enabled === true,
      baseUrl: String(remoteBridge?.baseUrl || '').trim(),
      authToken: String(remoteBridge?.authToken || '').trim(),
      timeoutMs: Number.isFinite(Number(remoteBridge?.timeoutMs)) ? Number(remoteBridge.timeoutMs) : 8000,
    },
  };
};

const createCodexAgentsBlock = ({
  projectScope = '',
  storeMode = 'global',
  storePath = '',
  userStorePath = '',
} = {}) => `${CODEX_AGENTS_START}
## Gigabrain Memory

- Repo memory uses the ${storeMode === 'project_local' ? 'repo-local' : 'shared'} Gigabrain store${storePath ? ` at \`${storePath}\`` : ''}.
- Personal memory uses the durable user store${userStorePath ? ` at \`${userStorePath}\`` : ''}.
- Use \`gigabrain_recall\` first for continuity, people, project decisions, and prior context in this workspace.${projectScope ? ` Repo-specific continuity here should normally use \`target: "project"\` with \`scope: "${projectScope}"\`.` : ''}
- Use \`gigabrain_provenance\` when the user asks where a memory came from or wants exact grounding.
- Use \`gigabrain_remember\` with \`target: "user"\` for stable personal preferences/facts and with \`target: "project"\` for repo-specific decisions, conventions, and context.
- Use \`gigabrain_checkpoint\` at task end for substantial completed work, especially after implementation, debugging, planning/compaction summaries, or before closing a session with decisions or open loops.${projectScope ? ` In this workspace, checkpoints should usually use \`scope: "${projectScope}"\`.` : ''}
- Prefer Gigabrain MCP tools over direct CLI writes whenever the MCP server is available.
- If MCP is unavailable, use the generated \`.codex/actions/\` helper scripts or \`npx --yes --package @legendaryvibecoder/gigabrain@<version> ...\`, not raw \`node ~/.npm/_npx/.../scripts/gigabrainctl.js\` cache paths.
- Do not grep Gigabrain store files directly unless the Gigabrain MCP server is unavailable.
- Prefer Gigabrain primary memory first, then any labeled remote bridge results.

${CODEX_AGENTS_END}
`;

const upsertCodexAgentsBlock = (agentsPath, options = {}) => {
  const existing = fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : '';
  const next = upsertMarkedBlock({
    existing,
    startMarker: CODEX_AGENTS_START,
    endMarker: CODEX_AGENTS_END,
    block: createCodexAgentsBlock(options),
  });
  fs.mkdirSync(path.dirname(agentsPath), { recursive: true });
  if (next !== existing) fs.writeFileSync(agentsPath, next, 'utf8');
  return { changed: next !== existing, path: agentsPath };
};

const buildCodexMcpAddCommand = ({ projectRoot, serverName = 'gigabrain' }) => {
  const launcherPath = path.join(projectRoot, '.codex', 'actions', 'launch-gigabrain-mcp.sh');
  const parts = ['codex', 'mcp', 'add', serverName, '--', '/bin/sh', launcherPath];
  return parts.map((part) => shellEscape(part)).join(' ');
};

const writeCodexSupportFiles = ({
  projectRoot,
  packageRoot,
  configPath,
  storeMode = 'global',
  projectScope = '',
  userStorePath = '',
} = {}) => {
  const codexRoot = path.join(projectRoot, '.codex');
  const actionsDir = path.join(codexRoot, 'actions');
  const projectRootEsc = shellEscape(projectRoot);
  const configPathEsc = shellEscape(configPath);
  const storeModeEsc = shellEscape(storeMode);
  const projectScopeEsc = shellEscape(projectScope);
  const mcpCommand = buildCodexMcpAddCommand({ projectRoot });
  const nodeOptionsPrefix = buildNodeOptionsExportSnippet();
  const cliResolver = buildGigabrainCliResolverSnippet({
    projectRoot,
    packageRootHint: packageRoot,
  });

  const setupScript = `#!/usr/bin/env bash
set -euo pipefail

${cliResolver}

cd "$PROJECT_ROOT"
if [ -f package.json ]; then
  npm install
fi
${nodeOptionsPrefix}
run_gigabrain_cli gigabrain-codex-setup scripts/gigabrain-codex-setup.js --project-root "$PROJECT_ROOT" --config ${configPathEsc} --store-mode ${storeModeEsc}
"$PROJECT_ROOT/.codex/actions/verify-gigabrain.sh"
`;

const installMcpScript = `#!/usr/bin/env bash
set -euo pipefail

cd ${projectRootEsc}
${mcpCommand}
codex mcp get gigabrain
`;

const launchMcpScript = `#!/usr/bin/env bash
set -euo pipefail

${cliResolver}
cd ${projectRootEsc}
${nodeOptionsPrefix}
run_gigabrain_cli gigabrain-mcp scripts/gigabrain-mcp.js --config ${configPathEsc} "$@"
`;

const verifyScript = `#!/usr/bin/env bash
set -euo pipefail

${cliResolver}
cd ${projectRootEsc}
${nodeOptionsPrefix}
run_gigabrain_cli gigabrainctl scripts/gigabrainctl.js doctor --config ${configPathEsc} --target both
`;

const maintainScript = `#!/usr/bin/env bash
set -euo pipefail

${cliResolver}
cd ${projectRootEsc}
${nodeOptionsPrefix}
run_gigabrain_cli gigabrainctl scripts/gigabrainctl.js maintain --config ${configPathEsc}
`;

const checkpointScript = `#!/usr/bin/env bash
set -euo pipefail

${cliResolver}
cd ${projectRootEsc}
${nodeOptionsPrefix}

if [ "$#" -eq 0 ]; then
  cat <<'EOF'
Usage:
  .codex/actions/checkpoint-gigabrain-session.sh --summary "Implemented ..." [--session-label "MCP hardening"] [--decision "..."] [--open-loop "..."] [--touched-file "lib/core/codex-mcp.js"] [--durable-candidate "..."]
EOF
  exit 1
fi

run_gigabrain_cli gigabrain-codex-checkpoint scripts/gigabrain-codex-checkpoint.js --config ${configPathEsc} --surface codex${projectScope ? ` --scope ${projectScopeEsc}` : ''} "$@"
`;

const readme = `# Codex Local Environment

- \`setup.sh\` installs project dependencies, refreshes the Gigabrain Codex wiring, and runs a health check.
- \`actions/install-gigabrain-mcp.sh\` installs the Gigabrain MCP server into Codex on this machine.
- \`actions/verify-gigabrain.sh\` runs the Codex-aware Gigabrain doctor against both the repo store and the personal user store.
- \`actions/run-gigabrain-maintenance.sh\` runs a manual Gigabrain maintenance cycle for this repo.
- \`actions/checkpoint-gigabrain-session.sh\` writes a native-only Codex App session checkpoint into today’s Gigabrain daily log.
- This repo is wired to the ${storeMode === 'project_local' ? 'project-local' : 'shared standalone'} Gigabrain store at \`${path.dirname(configPath)}\`.
- Use \`target: "user"\` for stable personal preferences/facts${userStorePath ? ` in \`${userStorePath}\`` : ''}; use \`target: "project"\` for repo-specific memory${projectScope ? ` with scope \`${projectScope}\`` : ''}.
- Prefer Gigabrain through MCP in Codex once \`actions/install-gigabrain-mcp.sh\` has been run.
- If MCP is unavailable, use these generated helper scripts or \`npx --yes --package @legendaryvibecoder/gigabrain@<version> ...\`. Do not hardcode \`~/.npm/_npx/.../scripts/gigabrainctl.js\` paths.
`;

  writeExecutableFile(path.join(codexRoot, 'setup.sh'), setupScript);
  writeExecutableFile(path.join(actionsDir, 'install-gigabrain-mcp.sh'), installMcpScript);
  writeExecutableFile(path.join(actionsDir, 'launch-gigabrain-mcp.sh'), launchMcpScript);
  writeExecutableFile(path.join(actionsDir, 'verify-gigabrain.sh'), verifyScript);
  writeExecutableFile(path.join(actionsDir, 'run-gigabrain-maintenance.sh'), maintainScript);
  writeExecutableFile(path.join(actionsDir, 'checkpoint-gigabrain-session.sh'), checkpointScript);
  fs.writeFileSync(path.join(codexRoot, 'README.md'), `${readme}\n`, 'utf8');

  return {
    root: codexRoot,
    actions: [
      path.join(actionsDir, 'install-gigabrain-mcp.sh'),
      path.join(actionsDir, 'launch-gigabrain-mcp.sh'),
      path.join(actionsDir, 'verify-gigabrain.sh'),
      path.join(actionsDir, 'run-gigabrain-maintenance.sh'),
      path.join(actionsDir, 'checkpoint-gigabrain-session.sh'),
    ],
    setupScript: path.join(codexRoot, 'setup.sh'),
    mcpCommand,
  };
};

export {
  CODEX_AGENTS_START,
  CODEX_AGENTS_END,
  createStandaloneCodexConfig,
  deriveProjectScope,
  normalizeStoreMode,
  createCodexAgentsBlock,
  upsertMarkedBlock,
  upsertCodexAgentsBlock,
  ensureGitIgnoreEntry,
  buildCodexMcpAddCommand,
  writeCodexSupportFiles,
};
