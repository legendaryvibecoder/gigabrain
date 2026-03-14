import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  installTarballIntoTempApp,
  packRepo,
  runCommand,
} from './packaged-install-helpers.js';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const run = async () => {
  if (process.env.RELEASE_LIVE_SMOKE !== '1') {
    console.log(JSON.stringify({
      ok: true,
      skipped: true,
      reason: 'Set RELEASE_LIVE_SMOKE=1 to run live Codex CLI release smokes.',
    }, null, 2));
    return;
  }

  const { tarballPath } = packRepo({
    repoRoot,
    prefix: 'gb-release-codex-pack-',
  });
  const { packageRoot } = installTarballIntoTempApp({
    tarballPath,
    prefix: 'gb-release-codex-app-',
  });

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-release-codex-'));
  const projectRoot = path.join(root, 'project');
  const homeRoot = path.join(root, 'home');
  const codexHome = path.join(homeRoot, '.codex');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(homeRoot, { recursive: true });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"release-codex","private":true}\n', 'utf8');

  runCommand({
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
      CODEX_HOME: codexHome,
    },
    label: 'release codex setup',
  });

  runCommand({
    cmd: path.join(projectRoot, '.codex', 'actions', 'install-gigabrain-mcp.sh'),
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: homeRoot,
      CODEX_HOME: codexHome,
    },
    timeout: 30_000,
    label: 'codex mcp install action',
  });

  const get = runCommand({
    cmd: 'codex',
    args: ['mcp', 'get', 'gigabrain'],
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME: homeRoot,
      CODEX_HOME: codexHome,
    },
    timeout: 30_000,
    label: 'codex mcp get gigabrain',
  });

  const output = `${get.stdout || ''}\n${get.stderr || ''}`;
  assert.equal(/gigabrain/i.test(output), true, 'codex mcp get should report the installed Gigabrain MCP server');
  console.log(JSON.stringify({
    ok: true,
    projectRoot,
    codexHome,
  }, null, 2));
};

run().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
