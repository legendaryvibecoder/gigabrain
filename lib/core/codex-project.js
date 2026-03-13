import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const CODEX_AGENTS_START = '<!-- GIGABRAIN_CODEX_MEMORY_START -->';
const CODEX_AGENTS_END = '<!-- GIGABRAIN_CODEX_MEMORY_END -->';
const DEFAULT_GLOBAL_CODEX_STORE = path.join(os.homedir(), '.codex', 'gigabrain');
const defaultUserOverlayPathForStore = (storeRoot = '') => path.join(path.resolve(expandHome(storeRoot || DEFAULT_GLOBAL_CODEX_STORE)), 'profile');

const shellEscape = (value = '') => `'${String(value || '').replace(/'/g, `'\\''`)}'`;
const expandHome = (value = '') => {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return raw;
};

const normalizeStoreMode = (value = '') => {
  const key = String(value || '').trim().toLowerCase();
  if (['project-local', 'project_local', 'local', 'repo', 'repo-local'].includes(key)) return 'project_local';
  return 'global';
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
    : DEFAULT_GLOBAL_CODEX_STORE;
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
- Do not grep Gigabrain store files directly unless the Gigabrain MCP server is unavailable.
- Prefer Gigabrain primary memory first, then any labeled remote bridge results.

${CODEX_AGENTS_END}
`;

const upsertMarkedBlock = ({ existing = '', startMarker, endMarker, block }) => {
  const start = existing.indexOf(startMarker);
  const end = existing.indexOf(endMarker);
  if (start !== -1 && end !== -1 && end >= start) {
    const before = existing.slice(0, start).trimEnd();
    const after = existing.slice(end + endMarker.length).trimStart();
    return [before, block.trim(), after].filter(Boolean).join('\n\n').concat('\n');
  }
  if (!String(existing || '').trim()) return `${block.trim()}\n`;
  return `${String(existing).trimEnd()}\n\n${block.trim()}\n`;
};

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

const ensureGitIgnoreEntry = (projectRoot, entry = '.gigabrain/') => {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const lines = existing.replace(/\r/g, '').split('\n').filter(Boolean);
  if (lines.includes(entry)) return { changed: false, path: gitignorePath };
  const next = existing.trim().length > 0
    ? `${existing.trimEnd()}\n${entry}\n`
    : `${entry}\n`;
  fs.writeFileSync(gitignorePath, next, 'utf8');
  return { changed: true, path: gitignorePath };
};

const writeExecutableFile = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  fs.chmodSync(filePath, 0o755);
};

const buildMcpLaunchArgs = ({ packageRoot, configPath }) => [
  process.execPath,
  path.join(packageRoot, 'scripts', 'gigabrain-mcp.js'),
  '--config',
  configPath,
];

const buildCodexMcpAddCommand = ({ packageRoot, configPath, serverName = 'gigabrain' }) => {
  const parts = ['codex', 'mcp', 'add', serverName, '--', ...buildMcpLaunchArgs({ packageRoot, configPath })];
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
  const packageRootEsc = shellEscape(packageRoot);
  const configPathEsc = shellEscape(configPath);
  const storeModeEsc = shellEscape(storeMode);
  const projectScopeEsc = shellEscape(projectScope);
  const mcpCommand = buildCodexMcpAddCommand({ packageRoot, configPath });

  const setupScript = `#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=${projectRootEsc}
PACKAGE_ROOT=${packageRootEsc}

cd "$PROJECT_ROOT"
if [ -f package.json ]; then
  npm install
fi
node "$PACKAGE_ROOT/scripts/gigabrain-codex-setup.js" --project-root "$PROJECT_ROOT" --config ${configPathEsc} --store-mode ${storeModeEsc}
node "$PACKAGE_ROOT/scripts/gigabrainctl.js" doctor --config ${configPathEsc} --target both
`;

  const installMcpScript = `#!/usr/bin/env bash
set -euo pipefail

cd ${projectRootEsc}
${mcpCommand}
codex mcp get gigabrain
`;

  const verifyScript = `#!/usr/bin/env bash
set -euo pipefail

PACKAGE_ROOT=${packageRootEsc}
cd ${projectRootEsc}
node "$PACKAGE_ROOT/scripts/gigabrainctl.js" doctor --config ${configPathEsc} --target both
`;

  const maintainScript = `#!/usr/bin/env bash
set -euo pipefail

PACKAGE_ROOT=${packageRootEsc}
cd ${projectRootEsc}
node "$PACKAGE_ROOT/scripts/gigabrainctl.js" maintain --config ${configPathEsc}
`;

  const checkpointScript = `#!/usr/bin/env bash
set -euo pipefail

PACKAGE_ROOT=${packageRootEsc}
cd ${projectRootEsc}

if [ "$#" -eq 0 ]; then
  cat <<'EOF'
Usage:
  .codex/actions/checkpoint-gigabrain-session.sh --summary "Implemented ..." [--session-label "MCP hardening"] [--decision "..."] [--open-loop "..."] [--touched-file "lib/core/codex-mcp.js"] [--durable-candidate "..."]
EOF
  exit 1
fi

node "$PACKAGE_ROOT/scripts/gigabrain-codex-checkpoint.js" --config ${configPathEsc}${projectScope ? ` --scope ${projectScopeEsc}` : ''} "$@"
`;

const readme = `# Codex Local Environment

- \`setup.sh\` installs project dependencies, refreshes the Gigabrain Codex wiring, and runs a health check.
- \`actions/install-gigabrain-mcp.sh\` installs the Gigabrain MCP server into Codex on this machine.
- \`actions/verify-gigabrain.sh\` runs the Codex-aware Gigabrain doctor against both the repo store and the personal user store.
- \`actions/run-gigabrain-maintenance.sh\` runs a manual Gigabrain maintenance cycle for this repo.
- \`actions/checkpoint-gigabrain-session.sh\` writes a native-only Codex App session checkpoint into today’s Gigabrain daily log.
- Use \`target: "user"\` for stable personal preferences/facts${userStorePath ? ` in \`${userStorePath}\`` : ''}; use \`target: "project"\` for repo-specific memory${projectScope ? ` with scope \`${projectScope}\`` : ''}.
`;

  writeExecutableFile(path.join(codexRoot, 'setup.sh'), setupScript);
  writeExecutableFile(path.join(actionsDir, 'install-gigabrain-mcp.sh'), installMcpScript);
  writeExecutableFile(path.join(actionsDir, 'verify-gigabrain.sh'), verifyScript);
  writeExecutableFile(path.join(actionsDir, 'run-gigabrain-maintenance.sh'), maintainScript);
  writeExecutableFile(path.join(actionsDir, 'checkpoint-gigabrain-session.sh'), checkpointScript);
  fs.writeFileSync(path.join(codexRoot, 'README.md'), `${readme}\n`, 'utf8');

  return {
    root: codexRoot,
    actions: [
      path.join(actionsDir, 'install-gigabrain-mcp.sh'),
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
  buildMcpLaunchArgs,
  writeCodexSupportFiles,
};
