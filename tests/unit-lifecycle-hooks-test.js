import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  installSessionHook,
  uninstallSessionHook,
  SESSION_HOOK_MARKER_KEY,
  SESSION_HOOK_MARKER_VALUE,
  SESSION_HOOK_EVENTS,
} from '../lib/core/lifecycle-hooks.js';
import { makeTempWorkspace } from './helpers.js';

// Idea #4: auto-flush via real host lifecycle hooks.
// SYNTHETIC temp settings.json ONLY — every path below lives under the
// configured test temp root or platform temp directory; nothing touches a real
// ~/.claude/settings.json or repo .git.

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const tmpSettings = (label) => {
  const dir = fs.mkdtempSync(path.join(process.env.GIGABRAIN_TEST_TMPDIR || os.tmpdir(), `gb-lifecycle-${label}-`));
  return path.join(dir, '.claude', 'settings.json');
};

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const ownedGroups = (settings, event) => (settings.hooks?.[event] || [])
  .filter((g) => g && g[SESSION_HOOK_MARKER_KEY] === SESSION_HOOK_MARKER_VALUE);

const run = async () => {
  // ----- (1) install: correctly-shaped SessionEnd entry, marker-owned, content preserved -----
  {
    const settingsPath = tmpSettings('install');
    // Pre-seed UNRELATED content that MUST survive the merge.
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({
      model: 'opus',
      permissions: { allow: ['Bash(ls:*)'] },
      hooks: {
        // a totally unrelated foreign hook on a DIFFERENT event — must coexist
        PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }],
      },
    }, null, 2), 'utf8');

    const result = installSessionHook({ settingsPath, configPath: '/synthetic/config.json' });
    assert.equal(result.ok, true, 'install should succeed');
    assert.equal(result.refused, false, 'install should not be refused on clean file');
    assert.deepEqual(result.events, SESSION_HOOK_EVENTS, 'install should target SessionEnd + PreCompact');

    const settings = readJson(settingsPath);
    // Other content preserved.
    assert.equal(settings.model, 'opus', 'unrelated top-level content must survive');
    assert.deepEqual(settings.permissions.allow, ['Bash(ls:*)'], 'permissions must survive');
    assert.equal(settings.hooks.PreToolUse.length, 1, 'unrelated foreign hook on other event must survive');

    // SessionEnd entry is correctly shaped + marker-owned + invokes the checkpoint.
    const seGroups = ownedGroups(settings, 'SessionEnd');
    assert.equal(seGroups.length, 1, 'exactly one Gigabrain SessionEnd group');
    const cmd = seGroups[0].hooks[0].command;
    assert.equal(seGroups[0].hooks[0].type, 'command', 'hook is a command hook');
    assert.equal(cmd.includes('gigabrain-codex-checkpoint'), true, 'SessionEnd invokes the checkpoint CLI');
    assert.equal(cmd.includes("'/synthetic/config.json'"), true, 'config path is passed through, shell-quoted');
    assert.equal(cmd.includes('--claude-hook-input'), true, 'hook command consumes bounded Claude hook JSON');
    // PreCompact too.
    assert.equal(ownedGroups(settings, 'PreCompact').length, 1, 'PreCompact also gets a Gigabrain group');
  }

  // ----- (2) idempotent re-install -----
  {
    const settingsPath = tmpSettings('idem');
    installSessionHook({ settingsPath });
    const first = readJson(settingsPath);
    installSessionHook({ settingsPath });
    installSessionHook({ settingsPath });
    const after = readJson(settingsPath);
    for (const event of SESSION_HOOK_EVENTS) {
      assert.equal(ownedGroups(after, event).length, 1, `re-install must not duplicate the ${event} entry`);
    }
    assert.deepEqual(after, first, 're-install must be a no-op (identical settings.json)');
  }

  // ----- (3) uninstall removes ONLY Gigabrain's entry -----
  {
    const settingsPath = tmpSettings('uninstall');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    // A foreign, UNRELATED SessionEnd group that must survive uninstall.
    fs.writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionEnd: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo foreign-cleanup' }] }],
      },
    }, null, 2), 'utf8');

    installSessionHook({ settingsPath });
    let settings = readJson(settingsPath);
    assert.equal(settings.hooks.SessionEnd.length, 2, 'foreign + Gigabrain SessionEnd groups coexist after install');

    const removal = uninstallSessionHook({ settingsPath });
    assert.equal(removal.ok, true, 'uninstall should succeed');
    assert.equal(removal.removed, true, 'uninstall should report removal');

    settings = readJson(settingsPath);
    assert.equal(settings.hooks.SessionEnd.length, 1, 'only the Gigabrain SessionEnd group is removed');
    assert.equal(
      settings.hooks.SessionEnd[0].hooks[0].command,
      'echo foreign-cleanup',
      'the foreign SessionEnd group survives uninstall',
    );
    assert.equal('PreCompact' in (settings.hooks || {}), false, 'emptied PreCompact event key is dropped');
    assert.equal(ownedGroups(settings, 'SessionEnd').length, 0, 'no Gigabrain group remains');

    // uninstall on a missing file is a clean no-op.
    const missing = uninstallSessionHook({ settingsPath: path.join(process.env.GIGABRAIN_TEST_TMPDIR || os.tmpdir(), 'gb-no-such', 'settings.json') });
    assert.equal(missing.ok, true, 'uninstall on missing file is clean');
    assert.equal(missing.removed, false, 'nothing removed when file is missing');
  }

  // ----- (4) refuses to clobber a foreign SessionEnd checkpoint hook -----
  {
    const settingsPath = tmpSettings('refuse');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    // A hand-written checkpoint hook WITHOUT the Gigabrain marker key.
    const foreign = {
      hooks: {
        SessionEnd: [{
          matcher: '*',
          hooks: [{ type: 'command', command: 'node /somewhere/scripts/gigabrain-codex-checkpoint.js --custom' }],
        }],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(foreign, null, 2), 'utf8');

    const result = installSessionHook({ settingsPath });
    assert.equal(result.ok, false, 'install must refuse a foreign checkpoint hook');
    assert.equal(result.refused, true, 'refusal flag set');
    assert.equal(result.reason, 'foreign_checkpoint_hook', 'refusal reason reported');
    // The file is NOT modified.
    assert.deepEqual(readJson(settingsPath), foreign, 'a refused install must not modify settings.json');
  }

  // ----- (4b) corrupt settings.json is refused, never overwritten -----
  {
    const settingsPath = tmpSettings('corrupt');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, '{ this is : not json', 'utf8');
    assert.throws(() => installSessionHook({ settingsPath }), /not valid JSON/, 'corrupt settings.json must throw, not overwrite');
    assert.equal(fs.readFileSync(settingsPath, 'utf8'), '{ this is : not json', 'corrupt file is left untouched');
  }

  // ----- (5) setup keeps auto-flush off by default and supports explicit opt-in -----
  {
    const ws = makeTempWorkspace('gb-lifecycle-setup-default-');
    fs.writeFileSync(ws.configPath, '{}\n', 'utf8');
    const defaultSettingsPath = path.join(ws.workspace, 'synthetic.claude', 'settings.json');
    const defaultRun = spawnSync(process.execPath, [
      'scripts/setup-first-run.js',
      '--config', ws.configPath,
      '--workspace', ws.workspace,
      '--agents-path', path.join(ws.workspace, 'AGENTS.md'),
      '--session-settings', defaultSettingsPath,
      '--skip-restart',
      '--skip-agents',
    ], { cwd: repoRoot, encoding: 'utf8', env: process.env });
    assert.equal(defaultRun.status, 0, `setup should exit 0:\n${defaultRun.stderr}`);
    const defaultSummary = JSON.parse(String(defaultRun.stdout || '{}'));
    assert.equal(defaultSummary.sessionHook, 'disabled', 'setup must not install an implicit teardown checkpoint hook');
    assert.equal(fs.existsSync(defaultSettingsPath), false, 'default setup writes no session settings');

    const ws2 = makeTempWorkspace('gb-lifecycle-setup-optin-');
    fs.writeFileSync(ws2.configPath, '{}\n', 'utf8');
    const optInSettingsPath = path.join(ws2.workspace, 'synthetic.claude', 'settings.json');
    const optedIn = spawnSync(process.execPath, [
      'scripts/setup-first-run.js',
      '--config', ws2.configPath,
      '--workspace', ws2.workspace,
      '--agents-path', path.join(ws2.workspace, 'AGENTS.md'),
      '--session-settings', optInSettingsPath,
      '--session-hook',
      '--skip-restart',
      '--skip-agents',
    ], { cwd: repoRoot, encoding: 'utf8', env: process.env });
    assert.equal(optedIn.status, 0, `setup --session-hook should exit 0:\n${optedIn.stderr}`);
    const optInSummary = JSON.parse(String(optedIn.stdout || '{}'));
    assert.equal(optInSummary.sessionHook, `installed:${optInSettingsPath}`, '--session-hook installs the owned hook');
    const written = readJson(optInSettingsPath);
    assert.equal(ownedGroups(written, 'SessionEnd').length, 1, 'opt-in setup wrote a marker-owned SessionEnd entry');
    const hookCommand = ownedGroups(written, 'SessionEnd')[0].hooks[0].command;
    const hookRun = spawnSync('/bin/sh', ['-c', hookCommand], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
      input: JSON.stringify({
        hook_event_name: 'SessionEnd',
        session_id: 'synthetic-claude-session',
      }),
    });
    assert.equal(hookRun.status, 0, `installed hook should write a checkpoint:\n${hookRun.stderr}`);
    const checkpoint = JSON.parse(String(hookRun.stdout || '{}'));
    assert.equal(checkpoint.ok, true, 'installed hook should report a successful checkpoint');
    assert.equal(checkpoint.session_id, 'synthetic-claude-session', 'hook should preserve the host session id');
    assert.equal(checkpoint.written_native, true, 'hook should write one native checkpoint block');
    const missingSession = spawnSync(process.execPath, [
      'scripts/gigabrain-codex-checkpoint.js',
      '--config', ws2.configPath,
      '--surface', 'claude',
      '--claude-hook-input',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: process.env,
      input: '{}',
    });
    assert.equal(missingSession.status, 1, 'hook input without a stable session id must fail closed');
    assert.match(String(missingSession.stderr || ''), /requires session_id or conversation_id/);
  }
};

export { run };
