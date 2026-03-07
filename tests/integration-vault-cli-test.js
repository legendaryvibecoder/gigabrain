import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { makeTempWorkspace, makeConfigObject, writeConfigFile, openDb, seedMemoryCurrent } from './helpers.js';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const runNodeJson = (args) => {
  const result = spawnSync('node', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`command failed: node ${args.join(' ')}\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(String(result.stdout || '{}'));
};

const run = async () => {
  const ws = makeTempWorkspace('gb-v4-int-vault-cli-');
  fs.writeFileSync(path.join(ws.workspace, 'MEMORY.md'), '# MEMORY\n\n- durable fact\n', 'utf8');
  fs.writeFileSync(path.join(ws.memoryRoot, '2026-03-07.md'), '# Daily\n\n- fresh daily\n', 'utf8');
  fs.writeFileSync(path.join(ws.memoryRoot, 'latest.md'), '# Latest\n\n- current\n', 'utf8');

  const configObject = makeConfigObject(ws.workspace);
  configObject.plugins.entries.gigabrain.config.vault = {
    enabled: true,
    path: 'obsidian-vault',
    subdir: 'Gigabrain',
    clean: true,
    homeNoteName: 'Home',
    exportActiveNodes: true,
    exportRecentArchivesLimit: 50,
    manualFolders: ['Inbox', 'Manual'],
    views: { enabled: true },
    reports: { enabled: true },
  };
  writeConfigFile(ws.configPath, configObject);

  const db = openDb(ws.dbPath);
  try {
    seedMemoryCurrent(db, [
      {
        memory_id: 'cli-node-1',
        type: 'PREFERENCE',
        content: 'Jordan prefers working with Obsidian as a memory surface.',
        scope: 'shared',
        confidence: 0.88,
        value_score: 0.8,
        value_label: 'keep',
      },
    ]);
  } finally {
    db.close();
  }

  const doctorBeforeBuild = runNodeJson([
    'scripts/gigabrainctl.js',
    'doctor',
    '--config', ws.configPath,
    '--db', ws.dbPath,
  ]);
  assert.equal(Array.isArray(doctorBeforeBuild.checks), true, 'doctor should return health JSON before the first vault build');
  assert.equal(doctorBeforeBuild.checks.some((check) => check.name === 'vault_surface_ready'), true, 'doctor should include vault surface readiness');

  const vaultDoctorBeforeBuild = runNodeJson([
    'scripts/gigabrainctl.js',
    'vault',
    'doctor',
    '--config', ws.configPath,
    '--db', ws.dbPath,
  ]);
  assert.equal(typeof vaultDoctorBeforeBuild.ok, 'boolean', 'vault doctor should report health before the first build');
  assert.equal(vaultDoctorBeforeBuild.health.enabled, true);

  const build = runNodeJson([
    'scripts/gigabrainctl.js',
    'vault',
    'build',
    '--config', ws.configPath,
    '--db', ws.dbPath,
    '--run-id', 'vault-cli-build',
  ]);
  assert.equal(build.ok, true);
  assert.equal(build.result.active_nodes >= 1, true, 'vault build should export active nodes');
  assert.equal(fs.existsSync(path.join(ws.outputRoot, 'memory-surface-summary.json')), true, 'vault build should write shared summary');

  const report = runNodeJson([
    'scripts/gigabrainctl.js',
    'vault',
    'report',
    '--config', ws.configPath,
    '--db', ws.dbPath,
  ]);
  assert.equal(report.ok, true);
  assert.equal(report.summary.active_nodes >= 1, true, 'vault report should expose active node count');

  const doctor = runNodeJson([
    'scripts/gigabrainctl.js',
    'vault',
    'doctor',
    '--config', ws.configPath,
    '--db', ws.dbPath,
  ]);
  assert.equal(doctor.ok, true, 'vault doctor should pass when manual folders are intact');
  assert.equal(doctor.health.enabled, true);

  const pullTarget = path.join(ws.root, 'cli-pull-target');
  fs.mkdirSync(path.join(pullTarget, '.obsidian'), { recursive: true });
  fs.mkdirSync(path.join(pullTarget, 'Gigabrain', 'Manual'), { recursive: true });
  fs.writeFileSync(path.join(pullTarget, '.obsidian', 'workspace.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(pullTarget, 'Gigabrain', 'Manual', 'keep.md'), '# keep\n', 'utf8');

  const pull = runNodeJson([
    'scripts/gigabrainctl.js',
    'vault',
    'pull',
    '--remote-path', build.result.vault_root,
    '--target', pullTarget,
  ]);
  assert.equal(pull.ok, true);
  assert.equal(fs.existsSync(path.join(pullTarget, 'Gigabrain', '00 Home', 'Home.md')), true, 'vault pull should sync generated content');
  assert.equal(fs.existsSync(path.join(pullTarget, 'Gigabrain', 'Manual', 'keep.md')), true, 'vault pull should preserve manual content');
};

export { run };
