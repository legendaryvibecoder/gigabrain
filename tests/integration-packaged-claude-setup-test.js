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
    prefix: 'gb-packaged-claude-pack-',
  });
  const { packageRoot } = installTarballIntoTempApp({
    tarballPath,
    prefix: 'gb-packaged-claude-app-',
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-packaged-claude-'));
  const projectRoot = path.join(root, 'project');
  const homeRoot = path.join(root, 'home');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(homeRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"packaged-claude","private":true}\n', 'utf8');

  const result = runCommand({
    cmd: 'node',
    args: [
      path.join(packageRoot, 'scripts', 'gigabrain-claude-setup.js'),
      '--project-root',
      projectRoot,
    ],
    cwd: packageRoot,
    env: {
      ...process.env,
      HOME: homeRoot,
    },
    label: 'packaged claude setup',
  });

  const summary = JSON.parse(String(result.stdout || '{}'));
  const sharedStoreRoot = path.join(homeRoot, '.gigabrain');
  const installedPackageRoot = fs.realpathSync(packageRoot);
  assert.equal(summary.ok, true, 'packaged claude setup should succeed');
  assert.equal(summary.sharingMode, 'shared-standalone', 'packaged claude setup should report shared standalone mode');
  assert.equal(summary.standalonePathKind, 'canonical', 'packaged claude setup should use the canonical standalone path');
  assert.equal(fs.existsSync(path.join(projectRoot, 'CLAUDE.md')), true, 'packaged claude setup should create CLAUDE.md');
  assert.equal(fs.existsSync(path.join(projectRoot, '.mcp.json')), true, 'packaged claude setup should create .mcp.json');
  assert.equal(fs.existsSync(path.join(projectRoot, '.claude', 'actions', 'verify-gigabrain.sh')), true, 'packaged claude setup should create verify action');

  const verify = runCommand({
    cmd: path.join(projectRoot, '.claude', 'actions', 'verify-gigabrain.sh'),
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: homeRoot,
    },
    label: 'packaged claude verify action',
  });
  const verifyResult = JSON.parse(String(verify.stdout || '{}'));
  assert.equal(verifyResult.ok, true, 'packaged claude verify action should succeed');
  assert.equal(verifyResult.standalone_path_kind, 'canonical', 'packaged claude verify should report the canonical standalone path');

  const mcp = readJson(path.join(projectRoot, '.mcp.json'));
  assert.equal(mcp.mcpServers.gigabrain.args.includes(path.join(installedPackageRoot, 'scripts', 'gigabrain-mcp.js')), true, 'packaged claude setup should point .mcp.json at the installed package');
  assert.equal(mcp.mcpServers.gigabrain.args.includes(path.join(sharedStoreRoot, 'config.json')), true, 'packaged claude setup should point .mcp.json at the shared config');
};

export { run };
