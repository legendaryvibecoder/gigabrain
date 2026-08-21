import fs from 'node:fs';
import path from 'node:path';

import {
  shellEscape,
  upsertMarkedBlock,
  writeExecutableFile,
  upsertMcpServerEntry,
  buildNodeOptionsExportSnippet,
  buildGigabrainCliResolverSnippet,
} from './standalone-client.js';
import { atomicWriteFileSync, readFileIfExistsSync } from './safe-fs.js';
import { createAgentMemoryPolicyBody } from './agent-memory-policy.js';

const CLAUDE_MEMORY_START = '<!-- GIGABRAIN_CLAUDE_MEMORY_START -->';
const CLAUDE_MEMORY_END = '<!-- GIGABRAIN_CLAUDE_MEMORY_END -->';

const createClaudeMemoryBlock = (options = {}) => `${CLAUDE_MEMORY_START}
${createAgentMemoryPolicyBody(options).trim()}

${CLAUDE_MEMORY_END}
`;

const upsertClaudeMarkdownBlock = (claudePath, options = {}) => {
  const existing = readFileIfExistsSync(claudePath, 'utf8').data;
  const next = upsertMarkedBlock({
    existing,
    startMarker: CLAUDE_MEMORY_START,
    endMarker: CLAUDE_MEMORY_END,
    block: createClaudeMemoryBlock(options),
  });
  fs.mkdirSync(path.dirname(claudePath), { recursive: true });
  if (next !== existing) atomicWriteFileSync(claudePath, next, { mode: 0o644 });
  return { changed: next !== existing, path: claudePath };
};

const buildClaudeMcpServerConfig = ({ projectRoot }) => ({
  command: '/bin/sh',
  args: [
    path.join(projectRoot, '.claude', 'actions', 'launch-gigabrain-mcp.sh'),
  ],
});

const upsertClaudeMcpConfig = ({ mcpPath, projectRoot }) => upsertMcpServerEntry({
  mcpPath,
  serverName: 'gigabrain',
  serverConfig: buildClaudeMcpServerConfig({ projectRoot }),
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
  const configPathEsc = shellEscape(configPath);
  const storeModeEsc = shellEscape(storeMode);
  const projectScopeEsc = shellEscape(projectScope);
  const claudeMdPathEsc = shellEscape(claudePath);
  const mcpPathEsc = shellEscape(mcpPath);
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
run_gigabrain_cli gigabrain-claude-setup scripts/gigabrain-claude-setup.js --project-root "$PROJECT_ROOT" --config ${configPathEsc} --store-mode ${storeModeEsc} --claude-md-path ${claudeMdPathEsc} --mcp-path ${mcpPathEsc}
"$PROJECT_ROOT/.claude/actions/verify-gigabrain.sh"
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
  .claude/actions/checkpoint-gigabrain-session.sh --summary "Implemented ..." [--session-label "Claude MCP wiring"] [--decision "..."] [--open-loop "..."] [--touched-file "lib/core/codex-mcp.js"] [--durable-candidate "..."]
EOF
  exit 1
fi

run_gigabrain_cli gigabrain-codex-checkpoint scripts/gigabrain-codex-checkpoint.js --config ${configPathEsc} --surface claude${projectScope ? ` --scope ${projectScopeEsc}` : ''} "$@"
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
- Prefer Gigabrain through MCP in Claude Code/Desktop once the local launcher has been registered.
- If MCP is unavailable, use these generated helper scripts or \`npx --yes --package @legendaryvibecoder/gigabrain@<version> ...\`. Do not hardcode \`~/.npm/_npx/.../scripts/gigabrainctl.js\` paths.
`;

  writeExecutableFile(path.join(claudeRoot, 'setup.sh'), setupScript);
  writeExecutableFile(path.join(actionsDir, 'launch-gigabrain-mcp.sh'), launchMcpScript);
  writeExecutableFile(path.join(actionsDir, 'verify-gigabrain.sh'), verifyScript);
  writeExecutableFile(path.join(actionsDir, 'run-gigabrain-maintenance.sh'), maintainScript);
  writeExecutableFile(path.join(actionsDir, 'checkpoint-gigabrain-session.sh'), checkpointScript);
  fs.writeFileSync(path.join(claudeRoot, 'README.md'), `${readme}\n`, 'utf8');

  return {
    root: claudeRoot,
    actions: [
      path.join(actionsDir, 'verify-gigabrain.sh'),
      path.join(actionsDir, 'launch-gigabrain-mcp.sh'),
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
