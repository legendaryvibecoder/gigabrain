#!/usr/bin/env node
import { runCheckpoint } from '../lib/core/codex-service.js';

const HELP = `Gigabrain Codex checkpoint

Usage:
  node scripts/gigabrain-codex-checkpoint.js --config /path/to/.gigabrain/config.json --summary "Implemented the MCP server"

Flags:
  --config <path>               Gigabrain config path
  --workspace-root <path>       Optional workspace override for config loading
  --mode <mode>                 Config loading mode (auto|standalone|openclaw)
  --scope <scope>               Optional scope override (default: project:main)
  --session-label <label>       Optional short label for the session checkpoint
  --summary <text>              Short summary of the completed work
  --decision <text>             Repeatable decision entry
  --open-loop <text>            Repeatable open loop entry
  --touched-file <path>         Repeatable touched file entry
  --durable-candidate <text>    Repeatable durable candidate entry
  --help                        Print this help
`;

const args = process.argv.slice(2);

const readFlag = (name, fallback = '') => {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1] && !String(args[idx + 1]).startsWith('--')) return String(args[idx + 1]);
  const withEq = args.find((item) => String(item || '').startsWith(`${name}=`));
  if (withEq) return String(withEq.split('=').slice(1).join('='));
  return fallback;
};

const readMultiFlag = (name) => {
  const out = [];
  for (let index = 0; index < args.length; index += 1) {
    const item = String(args[index] || '');
    if (item === name && args[index + 1] && !String(args[index + 1]).startsWith('--')) {
      out.push(String(args[index + 1]));
      index += 1;
      continue;
    }
    if (item.startsWith(`${name}=`)) {
      out.push(String(item.split('=').slice(1).join('=')));
    }
  }
  return out;
};

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`${HELP.trim()}\n`);
  process.exit(0);
}

try {
  const result = runCheckpoint({
    configPath: readFlag('--config', ''),
    workspaceRoot: readFlag('--workspace-root', ''),
    mode: readFlag('--mode', ''),
    scope: readFlag('--scope', ''),
    sessionLabel: readFlag('--session-label', ''),
    summary: readFlag('--summary', ''),
    decisions: readMultiFlag('--decision'),
    openLoops: readMultiFlag('--open-loop'),
    touchedFiles: readMultiFlag('--touched-file'),
    durableCandidates: readMultiFlag('--durable-candidate'),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
