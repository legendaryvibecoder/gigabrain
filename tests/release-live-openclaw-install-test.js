import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  packRepo,
  readJson,
  runCommand,
} from './packaged-install-helpers.js';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const resolveWorkingOpenClawBinary = () => {
  const candidates = [
    '/opt/homebrew/bin/openclaw',
    'openclaw',
    '/Users/legendary/.local/bin/openclaw',
  ];
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--help'], {
      encoding: 'utf8',
      timeout: 8_000,
      killSignal: 'SIGKILL',
      env: process.env,
    });
    if (probe.error || probe.status !== 0) continue;
    return candidate;
  }
  throw new Error('No working OpenClaw CLI binary found for release smoke.');
};

const run = async () => {
  if (process.env.RELEASE_LIVE_SMOKE !== '1') {
    console.log(JSON.stringify({
      ok: true,
      skipped: true,
      reason: 'Set RELEASE_LIVE_SMOKE=1 to run live OpenClaw release smokes.',
    }, null, 2));
    return;
  }

  const { tarballPath } = packRepo({
    repoRoot,
    prefix: 'gb-release-openclaw-pack-',
  });
  const openclawBin = resolveWorkingOpenClawBinary();

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-release-openclaw-'));
  const homeRoot = path.join(root, 'home');
  const workspaceRoot = path.join(root, 'workspace');
  const configDir = path.join(root, '.openclaw');
  const configPath = path.join(configDir, 'openclaw.json');
  fs.mkdirSync(homeRoot, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(configPath, '{}\n', 'utf8');

  runCommand({
    cmd: openclawBin,
    args: ['plugins', 'install', tarballPath],
    cwd: root,
    env: {
      ...process.env,
      HOME: homeRoot,
      OPENCLAW_STATE_DIR: configDir,
    },
    timeout: 60_000,
    label: 'openclaw plugins install',
  });

  const extensionsDir = path.join(configDir, 'extensions');
  const extensionEntries = fs.existsSync(extensionsDir) ? fs.readdirSync(extensionsDir) : [];
  const installedEntry = extensionEntries.find((entry) => entry.toLowerCase().includes('gigabrain'));
  assert.equal(Boolean(installedEntry), true, 'openclaw plugins install should create a Gigabrain extension entry');
  const extensionRoot = path.join(extensionsDir, installedEntry);

  runCommand({
    cmd: 'node',
    args: [
      'scripts/setup-first-run.js',
      '--config',
      configPath,
      '--workspace',
      workspaceRoot,
      '--skip-restart',
    ],
    cwd: extensionRoot,
    env: {
      ...process.env,
      HOME: homeRoot,
      OPENCLAW_STATE_DIR: configDir,
    },
    timeout: 30_000,
    label: 'openclaw packaged setup-first-run',
  });

  const config = readJson(configPath);
  assert.equal(config.plugins.slots.memory, 'gigabrain', 'setup should activate Gigabrain as the OpenClaw memory slot');
  assert.equal('path' in config.plugins.entries.gigabrain, false, 'setup should not write a stale plugin path key');
  console.log(JSON.stringify({
    ok: true,
    openclawBin,
    extensionRoot,
    configPath,
  }, null, 2));
};

run().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
