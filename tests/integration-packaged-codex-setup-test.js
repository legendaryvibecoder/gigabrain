import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  installTarballIntoTempApp,
  packRepo,
  readJson,
  runCommand,
} from './packaged-install-helpers.js';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const run = async () => {
  const { tarballPath } = packRepo({
    repoRoot,
    prefix: 'gb-packaged-codex-pack-',
  });
  const { packageRoot } = installTarballIntoTempApp({
    tarballPath,
    prefix: 'gb-packaged-codex-app-',
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-packaged-codex-'));
  const projectRoot = path.join(root, 'project');
  const homeRoot = path.join(root, 'home');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(homeRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"packaged-codex","private":true}\n', 'utf8');

  const result = runCommand({
    cmd: 'node',
    args: [
      path.join(packageRoot, 'scripts', 'gigabrain-codex-setup.js'),
      '--project-root',
      projectRoot,
    ],
    cwd: packageRoot,
    env: {
      ...process.env,
      HOME: homeRoot,
      CODEX_HOME: path.join(homeRoot, '.codex'),
    },
    label: 'packaged codex setup',
  });

  const summary = JSON.parse(String(result.stdout || '{}'));
  const sharedStoreRoot = path.join(homeRoot, '.gigabrain');
  const sharedUserStore = path.join(sharedStoreRoot, 'profile');
  const installedPackageRoot = fs.realpathSync(packageRoot);
  assert.equal(summary.ok, true, 'packaged codex setup should succeed');
  assert.equal(summary.sharingMode, 'shared-standalone', 'packaged codex setup should report shared standalone mode');
  assert.equal(summary.standalonePathKind, 'canonical', 'packaged codex setup should use the canonical standalone path');
  assert.equal(summary.projectStorePath, sharedStoreRoot, 'packaged codex setup should report the shared project store');
  assert.equal(summary.userStorePath, sharedUserStore, 'packaged codex setup should report the shared user store');
  assert.equal(fs.existsSync(path.join(sharedStoreRoot, 'config.json')), true, 'packaged codex setup should create config.json');
  assert.equal(fs.existsSync(path.join(projectRoot, '.codex', 'actions', 'verify-gigabrain.sh')), true, 'packaged codex setup should create verify action');
  assert.equal(fs.existsSync(path.join(projectRoot, '.codex', 'actions', 'launch-gigabrain-mcp.sh')), true, 'packaged codex setup should create the project-local MCP launcher');

  const verify = runCommand({
    cmd: path.join(projectRoot, '.codex', 'actions', 'verify-gigabrain.sh'),
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: homeRoot,
      CODEX_HOME: path.join(homeRoot, '.codex'),
    },
    label: 'packaged codex verify action',
  });
  const verifyResult = JSON.parse(String(verify.stdout || '{}'));
  assert.equal(verifyResult.ok, true, 'packaged codex verify action should succeed');
  assert.equal(verifyResult.stores.some((store) => store.target === 'user' && store.ok === true), true, 'packaged codex verify should include the user store');
  assert.equal(verifyResult.standalone_path_kind, 'canonical', 'packaged codex verify should report the canonical standalone path');

  const mcpCommand = String(summary.mcpCommand || '');
  assert.equal(mcpCommand.includes(path.join(projectRoot, '.codex', 'actions', 'launch-gigabrain-mcp.sh')), true, 'packaged codex setup should register the project-local launcher with Codex');
  const verifyScript = fs.readFileSync(path.join(projectRoot, '.codex', 'actions', 'verify-gigabrain.sh'), 'utf8');
  assert.equal(verifyScript.includes('node_modules/.bin/$tool'), true, 'packaged codex verify action should prefer the shared repo-local binary resolver');
  assert.equal(verifyScript.includes(installedPackageRoot), true, 'packaged codex verify action may keep an installed-package hint as a last resort');

  const config = readJson(path.join(sharedStoreRoot, 'config.json'));
  assert.equal(config.codex.userProfilePath, sharedUserStore, 'packaged codex setup should keep the shared user store configured');
};

export { run };
