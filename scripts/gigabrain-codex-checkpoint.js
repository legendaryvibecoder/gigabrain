#!/usr/bin/env node
import fs from 'node:fs';
import { runCheckpoint } from '../lib/core/codex-service.js';

const HELP = `Gigabrain session checkpoint

Usage:
  node scripts/gigabrain-codex-checkpoint.js --config /path/to/.gigabrain/config.json --summary "Implemented the MCP server"

Flags:
  --config <path>               Gigabrain config path
  --workspace-root <path>       Optional workspace override for config loading
  --mode <mode>                 Config loading mode (auto|standalone|openclaw)
  --scope <scope>               Optional scope override (default: project:main)
  --surface <surface>           Optional host surface hint (codex|claude|openclaw|agent)
  --session-label <label>       Optional short label for the session checkpoint
  --session-id <id>            Stable host session id (enforces one checkpoint per session)
  --summary <text>              Short summary of the completed work
  --decision <text>             Repeatable decision entry
  --open-loop <text>            Repeatable open loop entry
  --touched-file <path>         Repeatable touched file entry
  --durable-candidate <text>    Repeatable durable candidate entry
  --claude-hook-input          Read bounded Claude hook JSON from stdin
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
const MAX_CLAUDE_HOOK_INPUT_BYTES = 64 * 1024;

const readClaudeHookInput = () => {
  if (!args.includes('--claude-hook-input')) return null;
  const buffer = Buffer.allocUnsafe(MAX_CLAUDE_HOOK_INPUT_BYTES + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const bytesRead = fs.readSync(0, buffer, offset, buffer.length - offset, null);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  if (offset > MAX_CLAUDE_HOOK_INPUT_BYTES) {
    throw new Error(`Claude hook input exceeds ${MAX_CLAUDE_HOOK_INPUT_BYTES} bytes`);
  }
  const raw = buffer.toString('utf8', 0, offset).trim();
  if (!raw) throw new Error('Claude hook input is required');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Claude hook input must be valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Claude hook input must be a JSON object');
  }
  return parsed;
};

const hookSessionId = (input) => {
  const value = input?.session_id ?? input?.conversation_id ?? '';
  return typeof value === 'string' ? value.trim().slice(0, 256) : '';
};

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write(`${HELP.trim()}\n`);
  process.exit(0);
}

try {
  const hookInput = readClaudeHookInput();
  const sessionId = readFlag(
    '--session-id',
    process.env.GIGABRAIN_SESSION_ID || process.env.CLAUDE_SESSION_ID || hookSessionId(hookInput),
  );
  if (hookInput && !sessionId) throw new Error('Claude hook input requires session_id or conversation_id');
  const result = runCheckpoint({
    configPath: readFlag('--config', ''),
    workspaceRoot: readFlag('--workspace-root', ''),
    mode: readFlag('--mode', ''),
    scope: readFlag('--scope', ''),
    surface: readFlag('--surface', ''),
    sessionLabel: readFlag('--session-label', ''),
    sessionId,
    summary: readFlag('--summary', hookInput ? 'Claude lifecycle checkpoint.' : ''),
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
