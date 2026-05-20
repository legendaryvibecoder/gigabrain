#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(THIS_FILE), '..');

const HELP = `Gigabrain Hermes setup

Usage:
  node scripts/gigabrain-hermes-setup.js [flags]

Flags:
  --config <path>          Gigabrain config path (default: ~/.gigabrain/config.json, or legacy ~/.codex/gigabrain/config.json when present)
  --workspace-root <path>  Workspace root passed to Gigabrain MCP (default: cwd)
  --hermes-bin <path>      Hermes executable (default: hermes)
  --server-script <path>   Gigabrain MCP entrypoint (default: this package's scripts/gigabrain-mcp.js)
  --install                Run hermes mcp add gigabrain
  --test                   Run hermes mcp test gigabrain after install
  --json                   Print JSON only
  --help                   Print this help
`;

const args = process.argv.slice(2);

const expandHome = (value = '') => {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text === '~') return os.homedir();
  if (text.startsWith('~/')) return path.join(os.homedir(), text.slice(2));
  return text;
};

const readFlag = (name, fallback = '') => {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1] && !String(args[idx + 1]).startsWith('--')) return String(args[idx + 1]);
  const withEq = args.find((item) => String(item || '').startsWith(`${name}=`));
  if (withEq) return String(withEq.split('=').slice(1).join('='));
  return fallback;
};

const hasFlag = (name) => args.includes(name);

const defaultConfigPath = () => {
  const canonical = path.join(os.homedir(), '.gigabrain', 'config.json');
  const legacy = path.join(os.homedir(), '.codex', 'gigabrain', 'config.json');
  if (fs.existsSync(canonical)) return canonical;
  if (fs.existsSync(legacy)) return legacy;
  return canonical;
};

const run = (cmd, commandArgs, options = {}) => {
  const result = spawnSync(cmd, commandArgs, {
    cwd: options.cwd || process.cwd(),
    env: process.env,
    input: options.input || undefined,
    encoding: 'utf8',
  });
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  const combined = `${stdout}\n${stderr}`;
  return {
    ok: result.status === 0 && !/\b(Cancelled|not found in config)\b/i.test(combined),
    status: Number(result.status ?? 1),
    stdout,
    stderr,
  };
};

const shellQuote = (value = '') => {
  const text = String(value || '');
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
};

const main = () => {
  if (hasFlag('--help') || hasFlag('-h')) {
    console.log(HELP.trim());
    return;
  }

  const configPath = path.resolve(expandHome(readFlag('--config', defaultConfigPath())));
  const workspaceRoot = path.resolve(expandHome(readFlag('--workspace-root', process.cwd())));
  const hermesBin = expandHome(readFlag('--hermes-bin', 'hermes'));
  const serverScript = path.resolve(expandHome(readFlag('--server-script', path.join(PACKAGE_ROOT, 'scripts', 'gigabrain-mcp.js'))));
  const mcpArgs = [
    'mcp',
    'add',
    'gigabrain',
    '--env',
    `GIGABRAIN_CONFIG=${configPath}`,
    'GIGABRAIN_MODE=standalone',
    `GIGABRAIN_WORKSPACE_ROOT=${workspaceRoot}`,
    '--command',
    'node',
    '--args',
    serverScript,
  ];
  const commandText = [hermesBin, ...mcpArgs].map(shellQuote).join(' ');
  const result = {
    ok: true,
    command: 'gigabrain-hermes-setup',
    configPath,
    workspaceRoot,
    hermesBin,
    serverScript,
    mcpAddCommand: commandText,
    installed: false,
    install: { status: 'skipped' },
    test: { status: 'skipped' },
    nextSteps: [
      commandText,
      `${hermesBin} mcp test gigabrain`,
      `${hermesBin} gateway restart`,
    ],
  };

  if (!fs.existsSync(configPath)) {
    result.ok = false;
    result.error = `Gigabrain config does not exist at ${configPath}. Run gigabrain-codex-setup or pass --config.`;
  }
  if (!fs.existsSync(serverScript)) {
    result.ok = false;
    result.error = `Gigabrain MCP server script does not exist at ${serverScript}.`;
  }

  if (result.ok && hasFlag('--install')) {
    const install = run(hermesBin, mcpArgs, { input: 'Y\n' });
    result.install = install;
    result.installed = install.ok;
    result.ok = install.ok;
  }

  if (result.ok && hasFlag('--test')) {
    const test = run(hermesBin, ['mcp', 'test', 'gigabrain']);
    result.test = test;
    result.ok = test.ok;
  }

  if (hasFlag('--json')) {
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exit(1);
    return;
  }

  if (result.ok) {
    console.log('Gigabrain Hermes setup command:');
    console.log(`  ${commandText}`);
    if (result.installed) console.log('Installed Hermes MCP server: gigabrain');
    if (result.test.ok) console.log('Hermes MCP test passed: gigabrain');
    console.log('\nNext:');
    for (const step of result.nextSteps) console.log(`  ${step}`);
  } else {
    console.error(result.error || result.install.stderr || result.test.stderr || 'Gigabrain Hermes setup failed');
    process.exit(1);
  }
};

main();
