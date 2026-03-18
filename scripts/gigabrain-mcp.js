#!/usr/bin/env node
import { resolveRuntimeStandaloneConfigPath } from '../lib/core/standalone-client.js';

const HELP = `Gigabrain MCP server

Usage:
  node scripts/gigabrain-mcp.js --config /path/to/.gigabrain/config.json

Flags:
  --config <path>         Gigabrain config path
  --workspace-root <path> Optional workspace override for config loading
  --mode <mode>           Config loading mode (auto|standalone|openclaw)
  --help                  Print this help
`;

const args = process.argv.slice(2);

const readFlag = (name, fallback = '') => {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1] && !String(args[idx + 1]).startsWith('--')) return String(args[idx + 1]);
  const withEq = args.find((item) => String(item || '').startsWith(`${name}=`));
  if (withEq) return String(withEq.split('=').slice(1).join('='));
  return fallback;
};

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`${HELP.trim()}\n`);
  process.exit(0);
}

const rawConfigPath = readFlag('--config', '');
const rawMode = readFlag('--mode', '');
const runtimeConfig = resolveRuntimeStandaloneConfigPath(rawConfigPath);
if (rawConfigPath && !runtimeConfig.attemptedPath) {
  console.error('Gigabrain MCP requires a valid standalone config path. Run gigabrain-codex-setup or gigabrain-claude-setup first.');
  process.exit(1);
}
if (rawConfigPath && runtimeConfig.fallbackKind === 'missing') {
  console.error([
    `Gigabrain MCP could not find a standalone config at ${runtimeConfig.attemptedPath}.`,
    'Run gigabrain-codex-setup or gigabrain-claude-setup first, or point --config at an existing standalone config.',
  ].join('\n'));
  process.exit(1);
}

const defaults = {
  configPath: runtimeConfig.resolvedPath,
  workspaceRoot: readFlag('--workspace-root', ''),
  mode: rawMode || (rawConfigPath ? 'standalone' : ''),
};

let activeServer = null;

const shutdown = async (exitCode = 0) => {
  try {
    if (activeServer?.server) {
      await activeServer.server.close();
    }
  } catch {
    // Best effort shutdown.
  }
  process.exit(exitCode);
};

process.on('SIGINT', () => {
  void shutdown(0);
});

process.on('SIGTERM', () => {
  void shutdown(0);
});

const main = async () => {
  const { startMcpServer } = await import('../lib/core/codex-mcp.js');
  const started = await startMcpServer(defaults);
  activeServer = started;
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
