// Optional checkpoints via real host lifecycle hooks.
//
// The git pre-push hook (scripts/gigabrainctl.js) fires on a `git push`; this
// optional session hook fires on Claude Code's SessionEnd and PreCompact events.
// It records one structured lifecycle checkpoint per stable host session. It
// does not promote durable facts or infer memory from the transcript.
//
// SAFETY mirrors the pre-push hook EXACTLY:
//   * marker-KEY ownership — we only ever touch our own marker-owned hook entry
//   * REFUSE to clobber a foreign hook entry targeting our checkpoint command
//   * idempotent install + uninstall removes ONLY our entry
//   * never throws back across the exit-0 boundary — refusals are returned data
//   * never corrupt a settings.json with other content (parse/merge, no overwrite)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFileSync, readFileIfExistsSync } from './safe-fs.js';

// Marker key stamped onto the Gigabrain-owned hook GROUP object inside
// settings.json. This is the settings.json analogue of the pre-push
// WATCH_HOOK_MARKER comment: it is how install/uninstall identify the one entry
// Gigabrain owns, and the reason we can merge into a file with other content.
export const SESSION_HOOK_MARKER_KEY = 'gigabrainSessionHook';
export const SESSION_HOOK_MARKER_VALUE = 'v1';

// Claude Code lifecycle events we attach to. SessionEnd always; PreCompact too
// (fires before a compaction/auto-summary truncates the live session).
export const SESSION_HOOK_EVENTS = ['SessionEnd', 'PreCompact'];

const THIS_FILE = fileURLToPath(import.meta.url);
// scripts/gigabrain-codex-checkpoint.js relative to lib/core/lifecycle-hooks.js
export const CHECKPOINT_SCRIPT = path.resolve(path.dirname(THIS_FILE), '..', '..', 'scripts', 'gigabrain-codex-checkpoint.js');

// Codex equivalent: as of this writing Codex CLI exposes NO documented
// session-end / pre-compact lifecycle hook surface (its config supports MCP
// servers and notify, not a SessionEnd event). We therefore do NOT fake one —
// the lifecycle checkpoint hook is Claude-Code-only until Codex ships one.
export const CODEX_SESSION_HOOK_SUPPORTED = false;

const ensureDirFor = (filePath) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
};

// Resolve the settings.json target. Prefer an explicit path, then the
// project-local ./.claude/settings.json, then ~/.claude/settings.json. The
// project file is preferred (matches Claude Code's own precedence) but we only
// fall back to the user file when no project .claude dir exists.
export const resolveSessionSettingsPath = ({ explicit = '', cwd = process.cwd(), homeDir = os.homedir() } = {}) => {
  if (explicit) return path.resolve(explicit);
  const projectClaudeDir = path.join(cwd, '.claude');
  const projectSettings = path.join(projectClaudeDir, 'settings.json');
  if (fs.existsSync(projectSettings) || fs.existsSync(projectClaudeDir)) {
    return projectSettings;
  }
  return path.join(homeDir, '.claude', 'settings.json');
};

// Read settings.json as a plain object. A missing/empty file is an empty object;
// a corrupt or non-object file THROWS so we never silently overwrite real
// content. Callers that must stay exit-0 wrap this (or use install/uninstall,
// which convert the throw into refusal data only for foreign-hook cases).
const readSettingsJsonState = (settingsPath) => {
  const state = readFileIfExistsSync(settingsPath, 'utf8');
  if (!state.exists) return { exists: false, settings: {} };
  const raw = state.data;
  if (!raw.trim()) return { exists: true, settings: {} };
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Refusing to touch a settings.json that is not valid JSON: ${settingsPath} (${String(err?.message || err)})`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Refusing to touch a settings.json that is not a JSON object: ${settingsPath}`);
  }
  return { exists: true, settings: parsed };
};

export const readSettingsJson = (settingsPath) => {
  const state = readSettingsJsonState(settingsPath);
  return state.settings || {};
};

const shq = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

// The exact command the SessionEnd/PreCompact hook runs: shell-quoted absolute
// node + checkpoint script. A failed checkpoint stays advisory during teardown,
// but leaves a durable marker instead of disappearing silently.
export const buildSessionHookCommand = ({ configPath = '', nodeBin = process.execPath, checkpointScript = CHECKPOINT_SCRIPT } = {}) => {
  const parts = [
    shq(nodeBin),
    shq(checkpointScript),
    '--surface', 'claude',
    '--session-label', shq('host-lifecycle-autoflush'),
    '--claude-hook-input',
  ];
  if (configPath) parts.push('--config', shq(configPath));
  const failureLog = configPath
    ? `${String(configPath).replace(/\/[^/]+$/, '')}/logs/hook-failures.log`
    : '/tmp/gigabrain-hook-failures.log';
  return `${parts.join(' ')} || { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) gigabrain checkpoint hook failed" >> ${shq(failureLog)} 2>/dev/null || true; }`;
};

// A single Gigabrain-owned hook GROUP, marker-stamped. Shape matches Claude
// Code: { matcher, hooks:[{type:'command', command}], <marker>:value }.
export const buildSessionHookGroup = (opts = {}) => ({
  matcher: '*',
  hooks: [
    { type: 'command', command: buildSessionHookCommand(opts) },
  ],
  [SESSION_HOOK_MARKER_KEY]: SESSION_HOOK_MARKER_VALUE,
});

export const isGigabrainHookGroup = (group) => Boolean(
  group
  && typeof group === 'object'
  && !Array.isArray(group)
  && group[SESSION_HOOK_MARKER_KEY] === SESSION_HOOK_MARKER_VALUE,
);

// A foreign group is "ours to refuse" when it is NOT marker-owned yet its
// command targets our checkpoint script — i.e. a hand-written checkpoint hook we
// must not clobber (exact analogue of the pre-push "file exists without our
// marker" refusal). Unrelated foreign hooks are left untouched and coexist.
const isForeignCheckpointGroup = (group) => {
  if (isGigabrainHookGroup(group)) return false;
  if (!group || typeof group !== 'object' || Array.isArray(group)) return false;
  const hooks = Array.isArray(group.hooks) ? group.hooks : [];
  return hooks.some((h) => h
    && typeof h === 'object'
    && typeof h.command === 'string'
    && h.command.includes('gigabrain-codex-checkpoint'));
};

// Install the session hook into settings.json. Returns structured data and NEVER
// throws on the foreign-hook path — refusals come back as
// { ok:false, refused:true, ... } so the command wrapper can still exit 0.
export const installSessionHook = ({ settingsPath, configPath = '', nodeBin, checkpointScript } = {}) => {
  const settings = readSettingsJson(settingsPath);
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }
  const events = [];
  let installed = 0;
  let alreadyPresent = 0;
  for (const event of SESSION_HOOK_EVENTS) {
    const list = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    // Refuse: a foreign hand-written checkpoint hook lives here without our
    // marker. We must not clobber it (mirror the pre-push refusal).
    if (list.some(isForeignCheckpointGroup)) {
      return {
        ok: false,
        refused: true,
        event,
        settingsPath,
        reason: 'foreign_checkpoint_hook',
        note: `Refusing to clobber an existing ${event} hook Gigabrain did not install. Remove it or add a Gigabrain checkpoint call yourself.`,
      };
    }
    const ownedIdx = list.findIndex(isGigabrainHookGroup);
    const group = buildSessionHookGroup({ configPath, nodeBin, checkpointScript });
    if (ownedIdx === -1) {
      list.push(group);
      installed += 1;
    } else {
      // Idempotent: rewrite our own group in place (refreshes the command).
      list[ownedIdx] = group;
      alreadyPresent += 1;
    }
    settings.hooks[event] = list;
    events.push(event);
  }
  ensureDirFor(settingsPath);
  atomicWriteFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return {
    ok: true,
    refused: false,
    action: 'session_install_hook',
    settingsPath,
    events,
    installed,
    alreadyPresent,
    blocking: false,
    codexSupported: CODEX_SESSION_HOOK_SUPPORTED,
    note: 'Claude Code SessionEnd + PreCompact lifecycle checkpoint hook installed (best-effort, never blocks the host).',
  };
};

// Remove ONLY the Gigabrain-owned group(s) from each event. Every foreign entry
// is preserved; an emptied event key is dropped; an emptied hooks object is
// dropped so we never leave clutter behind.
export const uninstallSessionHook = ({ settingsPath } = {}) => {
  const state = readSettingsJsonState(settingsPath);
  if (!state.exists) {
    return { ok: true, action: 'session_uninstall_hook', removed: false, reason: 'no_settings_file', settingsPath };
  }
  const settings = state.settings;
  const hooks = (settings.hooks && typeof settings.hooks === 'object' && !Array.isArray(settings.hooks))
    ? settings.hooks
    : {};
  let removed = 0;
  for (const event of SESSION_HOOK_EVENTS) {
    if (!Array.isArray(hooks[event])) continue;
    const before = hooks[event].length;
    hooks[event] = hooks[event].filter((group) => !isGigabrainHookGroup(group));
    removed += before - hooks[event].length;
    if (hooks[event].length === 0) delete hooks[event];
  }
  if (settings.hooks && Object.keys(hooks).length === 0) {
    delete settings.hooks;
  } else if (settings.hooks) {
    settings.hooks = hooks;
  }
  atomicWriteFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  return { ok: true, action: 'session_uninstall_hook', removed: removed > 0, removedCount: removed, settingsPath };
};
