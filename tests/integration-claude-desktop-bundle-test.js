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
  assert.equal(summary.bundleMode, 'local', 'default bundle build should stay in local mode');
  assert.equal(summary.defaultConfigPath, path.join(os.homedir(), '.gigabrain', 'config.json'), 'bundle build should expose the canonical absolute standalone config path');

  const inspect = spawnSync('python3', [
    '-c',
    [
      'import json, sys, zipfile',
      'bundle = sys.argv[1]',
      'with zipfile.ZipFile(bundle, "r") as zf:',
      '    names = zf.namelist()',
      '    manifest = json.loads(zf.read("manifest.json").decode("utf-8"))',
      '    launcher = zf.read("scripts/claude-desktop-launcher.sh").decode("utf-8")',
      'print(json.dumps({"names": names, "manifest": manifest, "launcher": launcher}))',
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
  assert.equal(parsed.names.includes('scripts/claude-desktop-launcher.sh'), true, 'bundle should include the Claude Desktop launcher script');
  assert.equal(parsed.names.includes('lib/core/codex-mcp.js'), true, 'bundle should include the MCP server implementation');
  assert.equal(parsed.names.includes('node_modules/zod-to-json-schema/package.json'), true, 'bundle should include MCP SDK runtime dependencies that are not direct Gigabrain deps');
  assert.equal(parsed.manifest.manifest_version, '0.3', 'bundle manifest should target Claude Desktop extension manifest version 0.3');
  assert.equal(parsed.manifest.server.type, 'node', 'bundle manifest should declare a node server');
  assert.equal(parsed.manifest.server.entry_point, 'scripts/gigabrain-mcp.js', 'bundle manifest should point to the bundled Gigabrain MCP entrypoint');
  assert.equal(parsed.manifest.server.mcp_config.command, '/bin/sh', 'bundle manifest should launch through the hardened shell wrapper');
  assert.equal(parsed.manifest.server.mcp_config.args[0], '${__dirname}/scripts/claude-desktop-launcher.sh', 'bundle manifest should point at the launcher first');
  assert.equal(parsed.manifest.server.mcp_config.args.includes('${user_config.config_path}'), true, 'bundle manifest should expose a configurable shared Gigabrain config path');
  assert.equal(parsed.manifest.user_config.config_path.default, path.join(os.homedir(), '.gigabrain', 'config.json'), 'bundle manifest should default to the canonical absolute standalone config path');
  assert.equal(String(parsed.manifest.user_config.config_path.default).includes('${HOME}'), false, 'bundle manifest should no longer show a raw HOME placeholder');
  assert.equal(parsed.manifest.compatibility.platforms.includes('darwin'), true, 'bundle manifest should target macOS Claude Desktop');
  assert.match(parsed.launcher, /\.volta\/bin/, 'launcher should search common Volta paths');
  assert.match(parsed.launcher, /\.nvm\/versions\/node/, 'launcher should search common nvm paths');
  assert.match(parsed.launcher, /\.fnm/, 'launcher should search common fnm paths');
  assert.match(parsed.launcher, /\.asdf\/shims/, 'launcher should search common asdf paths');
  assert.match(parsed.launcher, /could not find Node\.js 22\+/i, 'launcher should explain how to fix missing Node setups');

  const zipLookup = spawnSync('/bin/sh', ['-lc', 'command -v zip'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });
  const zipPath = String(zipLookup.stdout || '').trim();
  if (zipPath) {
    const toolDir = path.join(root, 'bundle-tools');
    fs.mkdirSync(toolDir, { recursive: true });
    fs.symlinkSync(zipPath, path.join(toolDir, 'zip'));
    const zipOnlyOutDir = path.join(root, 'dist-zip-only');
    const zipOnlyResult = spawnSync(process.execPath, [
      'scripts/build-claude-desktop-bundle.js',
      '--out-dir', zipOnlyOutDir,
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: toolDir,
      },
    });
    if (zipOnlyResult.status !== 0) {
      throw new Error(`claude desktop zip fallback build failed:\n${zipOnlyResult.stderr || zipOnlyResult.stdout}`);
    }
    const zipOnlySummary = JSON.parse(String(zipOnlyResult.stdout || '{}'));
    assert.equal(zipOnlySummary.archiver, 'zip', 'bundle build should fall back to zip when python3 is unavailable');
    assert.equal(fs.existsSync(zipOnlySummary.bundlePath), true, 'zip-only fallback should still emit a .dxt artifact');
  }

  const portableOutDir = path.join(root, 'dist-portable');
  const portableResult = spawnSync('node', [
    'scripts/build-claude-desktop-bundle.js',
    '--out-dir', portableOutDir,
    '--portable',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });
  if (portableResult.status !== 0) {
    throw new Error(`claude desktop portable bundle build failed:\n${portableResult.stderr || portableResult.stdout}`);
  }
  const portableSummary = JSON.parse(String(portableResult.stdout || '{}'));
  assert.equal(portableSummary.ok, true, 'portable bundle build should succeed');
  assert.equal(portableSummary.bundleMode, 'portable', 'portable bundle build should report portable mode');
  assert.equal(portableSummary.defaultConfigPath, '~/.gigabrain/config.json', 'portable bundle build should use the portable standalone config default');
  const portableInspect = spawnSync('python3', [
    '-c',
    [
      'import json, sys, zipfile',
      'bundle = sys.argv[1]',
      'with zipfile.ZipFile(bundle, "r") as zf:',
      '    manifest = json.loads(zf.read("manifest.json").decode("utf-8"))',
      'print(manifest["user_config"]["config_path"]["default"])',
    ].join('\n'),
    portableSummary.bundlePath,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });
  if (portableInspect.status !== 0) {
    throw new Error(`claude desktop portable bundle inspect failed:\n${portableInspect.stderr || portableInspect.stdout}`);
  }
  assert.equal(String(portableInspect.stdout || '').trim(), '~/.gigabrain/config.json', 'portable bundle manifest should avoid embedding a builder-specific absolute path');

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
  const packagedInspect = spawnSync('python3', [
    '-c',
    [
      'import sys, zipfile',
      'bundle = sys.argv[1]',
      'with zipfile.ZipFile(bundle, "r") as zf:',
      '    names = set(zf.namelist())',
      'print("node_modules/zod-to-json-schema/package.json" in names)',
    ].join('\n'),
    packagedSummary.bundlePath,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });
  if (packagedInspect.status !== 0) {
    throw new Error(`claude desktop packaged bundle inspect failed:\n${packagedInspect.stderr || packagedInspect.stdout}`);
  }
  assert.equal(String(packagedInspect.stdout || '').trim(), 'True', 'installed package bundle should preserve SDK transitive runtime dependencies');
};

export { run };
