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

const writeText = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
};

const runJsonCommand = (args, options = {}) => {
  const result = runCommand({
    cmd: 'node',
    args,
    cwd: options.cwd,
    env: options.env,
    label: options.label,
  });
  return JSON.parse(String(result.stdout || '{}'));
};

const run = async () => {
  const { tarballPath } = packRepo({
    repoRoot,
    prefix: 'gb-packaged-passport-pack-',
  });
  const { packageRoot } = installTarballIntoTempApp({
    tarballPath,
    prefix: 'gb-packaged-passport-app-',
  });

  assert.equal(fs.existsSync(path.join(packageRoot, 'lib', 'core', 'memory-passport.js')), true, 'package should include memory-passport core');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-packaged-passport-'));
  const homeRoot = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  const codexHome = path.join(homeRoot, '.codex');
  const claudeHome = path.join(homeRoot, '.claude');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"packaged-passport","private":true}\n', 'utf8');

  const env = {
    ...process.env,
    HOME: homeRoot,
    CODEX_HOME: codexHome,
  };

  runJsonCommand([
    path.join(packageRoot, 'scripts', 'gigabrain-codex-setup.js'),
    '--project-root',
    projectRoot,
  ], {
    cwd: packageRoot,
    env,
    label: 'packaged passport setup',
  });

  const configPath = path.join(homeRoot, '.gigabrain', 'config.json');
  const sharedMemory = 'User wants a Memory Passport launch demo.';
  const secretValue = 'sk-packagedpassport1234567890abcdef';
  writeText(path.join(codexHome, 'memories', 'prefs.md'), `- ${sharedMemory}\n- API_KEY=${secretValue}\n`);
  writeText(path.join(claudeHome, 'projects', 'demo', 'memory', 'prefs.md'), `- ${sharedMemory}\n`);

  const sync = runJsonCommand([
    path.join(packageRoot, 'scripts', 'gigabrainctl.js'),
    'sync-hosts',
    '--config',
    configPath,
    '--codex-home',
    codexHome,
    '--claude-home',
    claudeHome,
    '--host',
    'codex,claude_code',
    '--scope',
    'profile:user',
  ], {
    cwd: packageRoot,
    env,
    label: 'packaged passport sync',
  });
  assert.equal(sync.ok, true, 'packaged sync should succeed before passport');

  const outputDir = path.join(root, 'passport-output');
  const passport = runJsonCommand([
    path.join(packageRoot, 'scripts', 'gigabrainctl.js'),
    'passport',
    '--config',
    configPath,
    '--codex-home',
    codexHome,
    '--claude-home',
    claudeHome,
    '--scope',
    'profile:user',
    '--output-dir',
    outputDir,
  ], {
    cwd: packageRoot,
    env,
    label: 'packaged passport',
  });

  assert.equal(passport.ok, true, 'packaged passport should succeed');
  assert.equal(fs.existsSync(passport.files.markdown), true, 'packaged passport should write markdown');
  assert.equal(fs.existsSync(passport.files.html), true, 'packaged passport should write html');
  assert.equal(fs.existsSync(passport.files.handoffs.agents), true, 'packaged passport should write AGENTS handoff');
  assert.equal(fs.existsSync(passport.files.handoffs.chatgpt_manual), true, 'packaged passport should write ChatGPT handoff');
  assert.equal(fs.readFileSync(passport.files.markdown, 'utf8').includes('Gigabrain Memory Passport'), true, 'passport markdown should be branded');
  assert.equal(fs.readFileSync(passport.files.markdown, 'utf8').includes(secretValue), false, 'passport markdown should not leak raw secret');
  assert.equal(fs.readFileSync(passport.files.handoffs.agents, 'utf8').includes(sharedMemory), true, 'handoff should include synced memory');
  assert.equal(fs.readFileSync(passport.files.handoffs.agents, 'utf8').includes(secretValue), false, 'handoff should redact secret');
  assert.equal(fs.readFileSync(passport.files.handoffs.agents, 'utf8').includes('[REDACTED_SECRET]'), false, 'handoff should omit secret-risk rows entirely');
  assert.equal(passport.summary.section_counts.secret_risks, 1, 'packaged passport should count secret-risk rows in audit');
};

export { run };
