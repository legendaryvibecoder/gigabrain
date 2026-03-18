import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { createStandaloneCodexConfig } from '../lib/core/codex-project.js';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const runSetup = ({ scriptName, projectRoot, homeRoot, extraArgs = [] }) => spawnSync('node', [
  path.join('scripts', scriptName),
  '--project-root',
  projectRoot,
  ...extraArgs,
], {
  cwd: repoRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    HOME: homeRoot,
  },
});

const writeJsonPretty = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

const run = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-standalone-paths-'));
  const homeRoot = path.join(root, 'home');
  fs.mkdirSync(homeRoot, { recursive: true });

  const legacyProjectRoot = path.join(root, 'legacy-project');
  fs.mkdirSync(legacyProjectRoot, { recursive: true });
  fs.writeFileSync(path.join(legacyProjectRoot, 'package.json'), '{"name":"legacy-project","private":true}\n', 'utf8');
  const legacyStoreRoot = path.join(homeRoot, '.codex', 'gigabrain');
  const legacyConfigPath = path.join(legacyStoreRoot, 'config.json');
  writeJsonPretty(legacyConfigPath, createStandaloneCodexConfig({
    projectRoot: legacyProjectRoot,
    projectStorePath: legacyStoreRoot,
    userProfilePath: path.join(legacyStoreRoot, 'profile'),
  }));

  const legacyRun = runSetup({
    scriptName: 'gigabrain-codex-setup.js',
    projectRoot: legacyProjectRoot,
    homeRoot,
  });
  if (legacyRun.status !== 0) {
    throw new Error(`legacy path setup failed:\n${legacyRun.stderr || legacyRun.stdout}`);
  }
  const legacySummary = JSON.parse(String(legacyRun.stdout || '{}'));
  assert.equal(legacySummary.configPath, legacyConfigPath, 'legacy standalone config should be reused in place');
  assert.equal(legacySummary.standalonePathKind, 'legacy_supported', 'legacy standalone path should be reported as supported');
  assert.equal(fs.existsSync(path.join(homeRoot, '.gigabrain', 'config.json')), false, 'legacy reuse should not silently create a canonical config');

  fs.rmSync(path.join(homeRoot, '.codex'), { recursive: true, force: true });

  const canonicalProjectRoot = path.join(root, 'canonical-project');
  fs.mkdirSync(canonicalProjectRoot, { recursive: true });
  fs.writeFileSync(path.join(canonicalProjectRoot, 'package.json'), '{"name":"canonical-project","private":true}\n', 'utf8');
  const canonicalStoreRoot = path.join(homeRoot, '.gigabrain');
  const canonicalConfigPath = path.join(canonicalStoreRoot, 'config.json');
  writeJsonPretty(canonicalConfigPath, createStandaloneCodexConfig({
    projectRoot: canonicalProjectRoot,
    projectStorePath: canonicalStoreRoot,
    userProfilePath: path.join(canonicalStoreRoot, 'profile'),
  }));

  const canonicalRun = runSetup({
    scriptName: 'gigabrain-claude-setup.js',
    projectRoot: canonicalProjectRoot,
    homeRoot,
  });
  if (canonicalRun.status !== 0) {
    throw new Error(`canonical path setup failed:\n${canonicalRun.stderr || canonicalRun.stdout}`);
  }
  const canonicalSummary = JSON.parse(String(canonicalRun.stdout || '{}'));
  assert.equal(canonicalSummary.configPath, canonicalConfigPath, 'canonical standalone config should be reused in place');
  assert.equal(canonicalSummary.standalonePathKind, 'canonical', 'canonical standalone path should be reported');

  const explicitProjectRoot = path.join(root, 'explicit-project');
  fs.mkdirSync(explicitProjectRoot, { recursive: true });
  fs.writeFileSync(path.join(explicitProjectRoot, 'package.json'), '{"name":"explicit-project","private":true}\n', 'utf8');
  const explicitConfigPath = path.join(root, 'custom-store', 'config.json');
  const explicitRun = runSetup({
    scriptName: 'gigabrain-codex-setup.js',
    projectRoot: explicitProjectRoot,
    homeRoot,
    extraArgs: ['--config', explicitConfigPath],
  });
  if (explicitRun.status !== 0) {
    throw new Error(`explicit config setup failed:\n${explicitRun.stderr || explicitRun.stdout}`);
  }
  const explicitSummary = JSON.parse(String(explicitRun.stdout || '{}'));
  assert.equal(explicitSummary.configPath, explicitConfigPath, 'explicit standalone config should override both canonical and legacy defaults');
  assert.equal(explicitSummary.standalonePathKind, 'custom', 'explicit custom config should be reported as custom');

  const missingRuntimeConfigPath = path.join(root, 'missing-store', 'config.json');
  const missingRuntime = spawnSync('node', [
    path.join('scripts', 'gigabrain-mcp.js'),
    '--config',
    missingRuntimeConfigPath,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeRoot,
    },
  });
  assert.notEqual(missingRuntime.status, 0, 'runtime MCP config resolution should fail closed for explicit missing configs');
  assert.match(
    missingRuntime.stderr || missingRuntime.stdout,
    /could not find a standalone config/i,
    'runtime MCP startup should explain missing explicit config paths instead of silently falling back',
  );
};

export { run };
