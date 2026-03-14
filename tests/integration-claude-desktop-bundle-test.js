import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const run = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-claude-bundle-'));
  const outDir = path.join(root, 'dist');

  const result = spawnSync('node', [
    'scripts/build-claude-desktop-bundle.js',
    '--out-dir', outDir,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });

  if (result.status !== 0) {
    throw new Error(`claude desktop bundle build failed:\n${result.stderr || result.stdout}`);
  }

  const summary = JSON.parse(String(result.stdout || '{}'));
  assert.equal(summary.ok, true, 'bundle build should succeed');
  assert.equal(fs.existsSync(summary.bundlePath), true, 'bundle build should create a .dxt artifact');
  assert.equal(path.extname(summary.bundlePath), '.dxt', 'bundle output should use the .dxt extension');

  const inspect = spawnSync('python3', [
    '-c',
    [
      'import json, sys, zipfile',
      'bundle = sys.argv[1]',
      'with zipfile.ZipFile(bundle, "r") as zf:',
      '    names = zf.namelist()',
      '    manifest = json.loads(zf.read("manifest.json").decode("utf-8"))',
      'print(json.dumps({"names": names, "manifest": manifest}))',
    ].join('\n'),
    summary.bundlePath,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });

  if (inspect.status !== 0) {
    throw new Error(`claude desktop bundle inspect failed:\n${inspect.stderr || inspect.stdout}`);
  }

  const parsed = JSON.parse(String(inspect.stdout || '{}'));
  assert.equal(parsed.names.includes('manifest.json'), true, 'bundle should contain manifest.json');
  assert.equal(parsed.names.includes('package.json'), true, 'bundle should contain package.json for ESM resolution');
  assert.equal(parsed.names.includes('scripts/gigabrain-mcp.js'), true, 'bundle should include the Gigabrain MCP entry script');
  assert.equal(parsed.names.includes('lib/core/codex-mcp.js'), true, 'bundle should include the MCP server implementation');
  assert.equal(parsed.manifest.manifest_version, '0.3', 'bundle manifest should target Claude Desktop extension manifest version 0.3');
  assert.equal(parsed.manifest.server.type, 'node', 'bundle manifest should declare a node server');
  assert.equal(parsed.manifest.server.entry_point, 'scripts/gigabrain-mcp.js', 'bundle manifest should point to the bundled Gigabrain MCP entrypoint');
  assert.equal(parsed.manifest.server.mcp_config.command, 'node', 'bundle manifest should run the server with node');
  assert.equal(parsed.manifest.server.mcp_config.args.includes('${user_config.config_path}'), true, 'bundle manifest should expose a configurable shared Gigabrain config path');
  assert.equal(parsed.manifest.compatibility.platforms.includes('darwin'), true, 'bundle manifest should target macOS Claude Desktop');

  const installedRoot = path.join(root, 'installed');
  fs.mkdirSync(installedRoot, { recursive: true });
  const packed = spawnSync('npm', [
    'pack',
    repoRoot,
  ], {
    cwd: installedRoot,
    encoding: 'utf8',
    env: process.env,
  });
  if (packed.status !== 0) {
    throw new Error(`claude desktop package pack failed:\n${packed.stderr || packed.stdout}`);
  }
  const tarballName = String(packed.stdout || '').trim().split('\n').filter(Boolean).pop();
  const installedApp = path.join(installedRoot, 'app');
  fs.mkdirSync(installedApp, { recursive: true });
  const init = spawnSync('npm', ['init', '-y'], {
    cwd: installedApp,
    encoding: 'utf8',
    env: process.env,
  });
  if (init.status !== 0) {
    throw new Error(`claude desktop package init failed:\n${init.stderr || init.stdout}`);
  }
  const install = spawnSync('npm', [
    'install',
    path.join(installedRoot, tarballName),
  ], {
    cwd: installedApp,
    encoding: 'utf8',
    env: process.env,
  });
  if (install.status !== 0) {
    throw new Error(`claude desktop package install failed:\n${install.stderr || install.stdout}`);
  }
  const packagedBundleOut = path.join(installedRoot, 'out');
  const packagedBuild = spawnSync('node', [
    'node_modules/@legendaryvibecoder/gigabrain/scripts/build-claude-desktop-bundle.js',
    '--out-dir',
    packagedBundleOut,
  ], {
    cwd: installedApp,
    encoding: 'utf8',
    env: process.env,
  });
  if (packagedBuild.status !== 0) {
    throw new Error(`claude desktop packaged bundle build failed:\n${packagedBuild.stderr || packagedBuild.stdout}`);
  }
  const packagedSummary = JSON.parse(String(packagedBuild.stdout || '{}'));
  assert.equal(packagedSummary.ok, true, 'installed package should also build a Claude Desktop bundle');
  assert.equal(fs.existsSync(packagedSummary.bundlePath), true, 'installed package bundle build should emit a .dxt artifact');
};

export { run };
