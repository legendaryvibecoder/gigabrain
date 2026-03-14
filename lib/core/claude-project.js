import fs from 'node:fs';
import path from 'node:path';

import {
  shellEscape,
  upsertMarkedBlock,
  writeExecutableFile,
  upsertMcpServerEntry,
} from './standalone-client.js';

const CLAUDE_MEMORY_START = '<!-- GIGABRAIN_CLAUDE_MEMORY_START -->';
const CLAUDE_MEMORY_END = '<!-- GIGABRAIN_CLAUDE_MEMORY_END -->';

const createClaudeMemoryBlock = ({
  projectScope = '',
  storeMode = 'global',
  storePath = '',
  userStorePath = '',
} = {}) => `${CLAUDE_MEMORY_START}
## Gigabrain Memory

- Repo memory uses the ${storeMode === 'project_local' ? 'repo-local' : 'shared'} Gigabrain store${storePath ? ` at \`${storePath}\`` : ''}.
- Personal memory uses the durable user store${userStorePath ? ` at \`${userStorePath}\`` : ''}.
- Use \`gigabrain_recall\` first for continuity, people, project decisions, and prior context in this workspace.${projectScope ? ` Repo-specific continuity here should normally use \`target: "project"\` with \`scope: "${projectScope}"\`.` : ''}
- Use \`gigabrain_provenance\` when you want exact grounding for a memory.
- Use \`gigabrain_remember\` with \`target: "user"\` for stable personal preferences/facts and with \`target: "project"\` for repo-specific decisions, conventions, and active project context.
- Use \`gigabrain_checkpoint\` at task end for substantial completed work, especially after implementation, debugging, or planning summaries.${projectScope ? ` In this workspace, checkpoints should usually use \`scope: "${projectScope}"\`.` : ''}
- Do not grep Gigabrain store files directly unless the MCP server is unavailable.

${CLAUDE_MEMORY_END}
`;

const upsertClaudeMarkdownBlock = (claudePath, options = {}) => {
  const existing = fs.existsSync(claudePath) ? fs.readFileSync(claudePath, 'utf8') : '';
  const next = upsertMarkedBlock({
    existing,
    startMarker: CLAUDE_MEMORY_START,
    endMarker: CLAUDE_MEMORY_END,
    block: createClaudeMemoryBlock(options),
  });
  fs.mkdirSync(path.dirname(claudePath), { recursive: true });
  if (next !== existing) fs.writeFileSync(claudePath, next, 'utf8');
  return { changed: next !== existing, path: claudePath };
};

const buildClaudeMcpServerConfig = ({ packageRoot, configPath }) => ({
  command: 'node',
  args: [
    path.join(packageRoot, 'scripts', 'gigabrain-mcp.js'),
    '--config',
    configPath,
  ],
});

const upsertClaudeMcpConfig = ({ mcpPath, packageRoot, configPath }) => upsertMcpServerEntry({
  mcpPath,
  serverName: 'gigabrain',
  serverConfig: buildClaudeMcpServerConfig({ packageRoot, configPath }),
});

const writeClaudeSupportFiles = ({
  projectRoot,
  packageRoot,
  configPath,
  storeMode = 'global',
  projectScope = '',
  userStorePath = '',
  claudePath = '',
  mcpPath = '',
} = {}) => {
  const claudeRoot = path.join(projectRoot, '.claude');
  const actionsDir = path.join(claudeRoot, 'actions');
  const projectRootEsc = shellEscape(projectRoot);
  const packageRootEsc = shellEscape(packageRoot);
  const configPathEsc = shellEscape(configPath);
  const storeModeEsc = shellEscape(storeMode);
  const projectScopeEsc = shellEscape(projectScope);
  const claudeMdPathEsc = shellEscape(claudePath);
  const mcpPathEsc = shellEscape(mcpPath);
  const nodeOptionsPrefix = 'NODE_WARNING_FLAGS="--no-warnings=ExperimentalWarning"\nexport NODE_OPTIONS="${NODE_WARNING_FLAGS}${NODE_OPTIONS:+ ${NODE_OPTIONS}}"';

  const setupScript = `#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT=${projectRootEsc}
PACKAGE_ROOT=${packageRootEsc}

cd "$PROJECT_ROOT"
if [ -f package.json ]; then
  npm install
fi
${nodeOptionsPrefix}
node "$PACKAGE_ROOT/scripts/gigabrain-claude-setup.js" --project-root "$PROJECT_ROOT" --config ${configPathEsc} --store-mode ${storeModeEsc} --claude-md-path ${claudeMdPathEsc} --mcp-path ${mcpPathEsc}
"$PROJECT_ROOT/.claude/actions/verify-gigabrain.sh"
`;

const verifyScript = `#!/usr/bin/env bash
set -euo pipefail

PACKAGE_ROOT=${packageRootEsc}
cd ${projectRootEsc}
${nodeOptionsPrefix}
node "$PACKAGE_ROOT/scripts/gigabrainctl.js" doctor --config ${configPathEsc} --target both
`;

const maintainScript = `#!/usr/bin/env bash
set -euo pipefail

PACKAGE_ROOT=${packageRootEsc}
cd ${projectRootEsc}
${nodeOptionsPrefix}
node "$PACKAGE_ROOT/scripts/gigabrainctl.js" maintain --config ${configPathEsc}
`;

const checkpointScript = `#!/usr/bin/env bash
set -euo pipefail

PACKAGE_ROOT=${packageRootEsc}
cd ${projectRootEsc}
${nodeOptionsPrefix}

if [ "$#" -eq 0 ]; then
  cat <<'EOF'
Usage:
  .claude/actions/checkpoint-gigabrain-session.sh --summary "Implemented ..." [--session-label "Claude MCP wiring"] [--decision "..."] [--open-loop "..."] [--touched-file "lib/core/codex-mcp.js"] [--durable-candidate "..."]
EOF
  exit 1
fi

node "$PACKAGE_ROOT/scripts/gigabrain-codex-checkpoint.js" --config ${configPathEsc}${projectScope ? ` --scope ${projectScopeEsc}` : ''} "$@"
`;

const readme = `# Claude Local Environment

- \`setup.sh\` installs project dependencies, refreshes the Gigabrain Claude wiring, and runs a health check.
- \`actions/verify-gigabrain.sh\` runs the Gigabrain doctor against both the repo store and the personal user store.
- \`actions/run-gigabrain-maintenance.sh\` runs a manual Gigabrain maintenance cycle for this repo.
- \`actions/checkpoint-gigabrain-session.sh\` writes a native-only session checkpoint into today’s Gigabrain daily log.
- \`CLAUDE.md\` contains the Gigabrain memory instructions for Claude in this repo.
- \`.mcp.json\` registers the local Gigabrain MCP server for Claude Code.
- This repo is wired to the ${storeMode === 'project_local' ? 'project-local' : 'shared standalone'} Gigabrain store at \`${path.dirname(configPath)}\`.
- Use \`target: "user"\` for stable personal preferences/facts${userStorePath ? ` in \`${userStorePath}\`` : ''}; use \`target: "project"\` for repo-specific memory${projectScope ? ` with scope \`${projectScope}\`` : ''}.
`;

  writeExecutableFile(path.join(claudeRoot, 'setup.sh'), setupScript);
  writeExecutableFile(path.join(actionsDir, 'verify-gigabrain.sh'), verifyScript);
  writeExecutableFile(path.join(actionsDir, 'run-gigabrain-maintenance.sh'), maintainScript);
  writeExecutableFile(path.join(actionsDir, 'checkpoint-gigabrain-session.sh'), checkpointScript);
  fs.writeFileSync(path.join(claudeRoot, 'README.md'), `${readme}\n`, 'utf8');

  return {
    root: claudeRoot,
    actions: [
      path.join(actionsDir, 'verify-gigabrain.sh'),
      path.join(actionsDir, 'run-gigabrain-maintenance.sh'),
      path.join(actionsDir, 'checkpoint-gigabrain-session.sh'),
    ],
    setupScript: path.join(claudeRoot, 'setup.sh'),
    claudePath,
    mcpPath,
  };
};

export {
  CLAUDE_MEMORY_START,
  CLAUDE_MEMORY_END,
  createClaudeMemoryBlock,
  upsertClaudeMarkdownBlock,
  buildClaudeMcpServerConfig,
  upsertClaudeMcpConfig,
  writeClaudeSupportFiles,
};
