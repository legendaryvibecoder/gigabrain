import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { makeTempWorkspace } from './helpers.js';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const run = async () => {
  const ws = makeTempWorkspace('gb-v4-int-setup-');
  const agentsPath = path.join(ws.workspace, 'AGENTS.md');
  const vaultRoot = path.join(ws.root, 'obsidian-surface');

  fs.writeFileSync(ws.configPath, '{}\n', 'utf8');
  fs.writeFileSync(path.join(ws.workspace, 'MEMORY.md'), '# MEMORY\n\n- existing native memory\n', 'utf8');
  fs.writeFileSync(agentsPath, `# Workspace\n\n<!-- GIGABRAIN_MEMORY_PROTOCOL_START -->\n## Memory\nOld block\n<!-- GIGABRAIN_MEMORY_PROTOCOL_END -->\n`, 'utf8');

  const result = spawnSync('node', [
    'scripts/setup-first-run.js',
    '--config', ws.configPath,
    '--workspace', ws.workspace,
    '--agents-path', agentsPath,
    '--vault-path', vaultRoot,
    '--skip-restart',
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });

  if (result.status !== 0) {
    throw new Error(`setup command failed:\n${result.stderr || result.stdout}`);
  }

  const summary = JSON.parse(String(result.stdout || '{}'));
  assert.equal(summary.ok, true, 'setup should succeed');
  assert.equal(summary.gatewayRestart, 'skipped');
  assert.equal(summary.vault.enabled, true, 'setup should enable the vault by default');
  assert.equal(summary.vault.built, true, 'setup should build the initial surface');
  assert.equal(summary.vault.surfacePath, path.join(vaultRoot, 'Gigabrain'));
  assert.equal(fs.existsSync(summary.vault.homeNotePath), true, 'setup should create the Obsidian home note');
  assert.equal(Array.isArray(summary.nextSteps), true, 'setup should return structured next steps');
  assert.equal(summary.nextSteps.some((step) => step.includes('Obsidian')), true, 'setup should guide users to Obsidian');

  const config = JSON.parse(fs.readFileSync(ws.configPath, 'utf8'));
  assert.equal(config.plugins.slots.memory, 'gigabrain', 'setup should activate Gigabrain as the OpenClaw memory slot');
  assert.equal('path' in config.plugins.entries.gigabrain, false, 'setup should not write plugin path into config');
  const gb = config.plugins.entries.gigabrain.config;
  assert.equal(gb.runtime.paths.workspaceRoot, ws.workspace, 'setup should store workspace root');
  assert.equal(gb.runtime.paths.memoryRoot, 'memory', 'setup should store memoryRoot');
  assert.equal(gb.runtime.paths.outputDir, 'output', 'setup should store outputDir');
  assert.equal(gb.capture.requireMemoryNote, true, 'setup should keep explicit capture enabled');
  assert.equal(gb.capture.rememberIntent.enabled, true, 'setup should enable remember intent defaults');
  assert.equal(gb.capture.rememberIntent.writeNative, true, 'setup should enable native remember writes');
  assert.equal(gb.capture.rememberIntent.writeRegistry, true, 'setup should enable registry remember writes');
  assert.equal(gb.nativePromotion.enabled, true, 'setup should enable native promotion defaults');
  assert.equal(gb.vault.enabled, true, 'setup should enable the Obsidian surface');
  assert.equal(gb.vault.path, vaultRoot, 'setup should persist custom vault path');

  const agents = fs.readFileSync(agentsPath, 'utf8');
  assert.equal(agents.includes('Gigabrain uses a hybrid memory model.'), true, 'setup should refresh the AGENTS block');
  assert.equal(agents.includes('Old block'), false, 'setup should replace stale AGENTS content');

  const restartFailure = spawnSync(process.execPath, [
    'scripts/setup-first-run.js',
    '--config', ws.configPath,
    '--workspace', ws.workspace,
    '--agents-path', agentsPath,
    '--vault-path', vaultRoot,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: '/usr/bin:/bin',
    },
  });

  if (restartFailure.status !== 0) {
    throw new Error(`setup command should still exit cleanly on restart failure:\n${restartFailure.stderr || restartFailure.stdout}`);
  }

  const restartFailureSummary = JSON.parse(String(restartFailure.stdout || '{}'));
  assert.equal(restartFailureSummary.ok, false, 'setup should report not-ok when the gateway restart step fails');
  assert.equal(restartFailureSummary.gatewayRestart, 'failed', 'setup should report the failed gateway restart');
  assert.equal(
    restartFailureSummary.nextSteps.some((step) => step.includes('openclaw gateway restart')),
    true,
    'setup should tell the user to run gateway restart manually when restart fails',
  );
};

export { run };
