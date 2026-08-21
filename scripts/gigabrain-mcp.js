#!/usr/bin/env node
import { resolveRuntimeStandaloneConfigPath } from '../lib/core/standalone-client.js';

const HELP = `Gigabrain MCP server

Usage:
  node scripts/gigabrain-mcp.js --config /path/to/.gigabrain/config.json
  node scripts/gigabrain-mcp.js --transport http --config /path/to/.gigabrain/config.json --allowed-scope project:example

Flags:
  --config <path>                 Gigabrain config path
  --workspace-root <path>         Optional workspace override for config loading
  --mode <mode>                   Config loading mode (auto|standalone|openclaw)
  --transport <stdio|http>        MCP transport (default: stdio)
  --host <host>                   HTTP bind host (default: 127.0.0.1)
  --port <port>                   HTTP bind port (default: 8788; 0 selects an ephemeral port)
  --mcp-path <path>               Streamable HTTP endpoint (default: /mcp)
  --resource-url <url>            Public OAuth resource URL
  --authorization-server <url>    OAuth authorization-server issuer/base URL
  --auth-issuer <url>             Expected access-token issuer
  --jwks-url <url>                OAuth authorization server JWKS URL
  --allowed-scope <scope>         Exact memory scope allowlist; repeat as needed
  --allowed-host <host>           Accepted Host header; repeat as needed
  --allowed-origin <origin>       Accepted browser Origin; repeat as needed
  --enable-writes                 Expose write tools granted by token scopes
  --allow-no-auth                 Loopback development only; still requires --allowed-scope
  --rate-limit <requests/minute>  Per-IP and per-subject request ceiling
  --help                          Print this help

Secrets are accepted through environment variables only. For private testing set
GIGABRAIN_MCP_BEARER_TOKEN; production connectors should configure OAuth issuer/JWKS.
`;

const args = process.argv.slice(2);

const readFlag = (name, fallback = '') => {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1] && !String(args[idx + 1]).startsWith('--')) return String(args[idx + 1]);
  const withEq = args.find((item) => String(item || '').startsWith(`${name}=`));
  if (withEq) return String(withEq.split('=').slice(1).join('='));
  return fallback;
};

const readFlags = (name) => {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const item = String(args[index] || '');
    if (item === name && args[index + 1] && !String(args[index + 1]).startsWith('--')) {
      values.push(String(args[index + 1]));
      index += 1;
      continue;
    }
    if (item.startsWith(`${name}=`)) values.push(item.split('=').slice(1).join('='));
  }
  return values.filter((value) => String(value || '').trim());
};

const hasFlag = (name) => args.includes(name);

const readBooleanFlag = (name, fallback = '') => {
  const explicit = readFlag(name, '');
  if (explicit !== '') return explicit;
  if (hasFlag(name)) return true;
  return fallback;
};

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`${HELP.trim()}\n`);
  process.exit(0);
}

const rawConfigPath = readFlag('--config', process.env.GIGABRAIN_CONFIG || process.env.GIGABRAIN_CONFIG_PATH || '');
const rawMode = readFlag('--mode', process.env.GIGABRAIN_MODE || '');
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
  workspaceRoot: readFlag('--workspace-root', process.env.GIGABRAIN_WORKSPACE_ROOT || ''),
  mode: rawMode || (rawConfigPath ? 'standalone' : ''),
};
const transportKind = readFlag('--transport', process.env.GIGABRAIN_MCP_TRANSPORT || 'stdio').trim().toLowerCase();
if (!['stdio', 'http'].includes(transportKind)) {
  console.error('--transport must be either stdio or http.');
  process.exit(1);
}

let activeServer = null;
let shuttingDown = false;

const shutdown = async (exitCode = 0) => {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (typeof activeServer?.close === 'function') {
      await activeServer.close();
    } else if (activeServer?.server) {
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

if (transportKind === 'stdio') {
  process.stdin.once('end', () => {
    void shutdown(0);
  });
  process.stdin.once('close', () => {
    void shutdown(0);
  });
  const parentPid = process.ppid;
  const parentWatch = setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      clearInterval(parentWatch);
      void shutdown(0);
    }
  }, 2000);
  parentWatch.unref();
}

const main = async () => {
  if (transportKind === 'stdio') {
    const { startMcpServer } = await import('../lib/core/codex-mcp.js');
    activeServer = await startMcpServer(defaults);
    return;
  }

  const { startRemoteMcpServer } = await import('../lib/core/remote-mcp.js');
  const allowedScopes = readFlags('--allowed-scope');
  const allowedHosts = readFlags('--allowed-host');
  const allowedOrigins = readFlags('--allowed-origin');
  const remoteOptions = {
    host: readFlag('--host', process.env.GIGABRAIN_MCP_HOST || ''),
    port: readFlag('--port', process.env.GIGABRAIN_MCP_PORT || ''),
    mcpPath: readFlag('--mcp-path', process.env.GIGABRAIN_MCP_PATH || ''),
    resourceUrl: readFlag('--resource-url', process.env.GIGABRAIN_MCP_RESOURCE_URL || ''),
    authorizationServer: readFlag('--authorization-server', process.env.GIGABRAIN_MCP_AUTHORIZATION_SERVER || ''),
    issuer: readFlag('--auth-issuer', process.env.GIGABRAIN_MCP_AUTH_ISSUER || ''),
    jwksUrl: readFlag('--jwks-url', process.env.GIGABRAIN_MCP_JWKS_URL || ''),
    enableWrites: readBooleanFlag('--enable-writes', process.env.GIGABRAIN_MCP_ENABLE_WRITES),
    allowNoAuth: readBooleanFlag('--allow-no-auth', process.env.GIGABRAIN_MCP_ALLOW_NO_AUTH),
    maxRequestsPerMinute: readFlag('--rate-limit', process.env.GIGABRAIN_MCP_RATE_LIMIT || ''),
    ...(allowedScopes.length > 0 ? { allowedScopes } : {}),
    ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
    ...(allowedOrigins.length > 0 ? { allowedOrigins } : {}),
  };
  activeServer = await startRemoteMcpServer(defaults, remoteOptions);
  const address = activeServer.address;
  const addressHost = typeof address === 'object' && address ? address.address : activeServer.options.host;
  const addressPort = typeof address === 'object' && address ? address.port : activeServer.options.port;
  console.error(`Gigabrain MCP listening on ${addressHost}:${addressPort}${activeServer.options.mcpPath}`);
};

main().catch((error) => {
  if (transportKind === 'stdio' && (shuttingDown || process.stdin.readableEnded)) {
    void shutdown(0);
    return;
  }
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
