import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const runSetup = ({ projectRoot, homeRoot }) => spawnSync('node', [
  'scripts/gigabrain-codex-setup.js',
  '--project-root', projectRoot,
], {
  cwd: repoRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    HOME: homeRoot,
  },
});

const run = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-codex-setup-'));
  const projectRoot = path.join(root, 'project');
  const homeRoot = path.join(root, 'home');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(homeRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'codex-project',
    private: true,
  }, null, 2), 'utf8');

  const result = runSetup({ projectRoot, homeRoot });

  if (result.status !== 0) {
    throw new Error(`codex setup failed:\n${result.stderr || result.stdout}`);
  }

  const summary = JSON.parse(String(result.stdout || '{}'));
  const sharedStoreRoot = path.join(homeRoot, '.gigabrain');
  const sharedUserStore = path.join(sharedStoreRoot, 'profile');
  assert.equal(summary.ok, true, 'setup should succeed');
  assert.equal(summary.storeMode, 'global', 'setup should default to the shared standalone store');
  assert.equal(summary.sharingMode, 'shared-standalone', 'setup should report shared standalone mode');
  assert.equal(summary.standalonePathKind, 'canonical', 'fresh setup should use the canonical standalone path');
  assert.equal(summary.projectStorePath, sharedStoreRoot, 'setup summary should report the shared project store');
  assert.equal(summary.userStorePath, sharedUserStore, 'setup summary should report the shared personal store');
  assert.equal(summary.standaloneConfigPath, path.join(sharedStoreRoot, 'config.json'), 'setup summary should report the canonical config path');
  assert.equal(fs.existsSync(path.join(sharedStoreRoot, 'config.json')), true, 'setup should create the shared standalone config');
  assert.equal(fs.existsSync(path.join(sharedStoreRoot, 'MEMORY.md')), true, 'setup should bootstrap the shared MEMORY.md');
  assert.equal(fs.existsSync(path.join(sharedUserStore, 'MEMORY.md')), true, 'setup should bootstrap the shared personal MEMORY.md');
  assert.equal(fs.existsSync(path.join(projectRoot, '.codex', 'setup.sh')), true, 'setup should create the Codex setup script');
  assert.equal(fs.existsSync(path.join(projectRoot, '.codex', 'actions', 'install-gigabrain-mcp.sh')), true, 'setup should create the MCP install action');
  assert.equal(fs.existsSync(path.join(projectRoot, '.codex', 'actions', 'verify-gigabrain.sh')), true, 'setup should create the doctor action');
  assert.equal(fs.existsSync(path.join(projectRoot, '.codex', 'actions', 'run-gigabrain-maintenance.sh')), true, 'setup should create the maintenance action');
  assert.equal(fs.existsSync(path.join(projectRoot, '.codex', 'actions', 'checkpoint-gigabrain-session.sh')), true, 'setup should create the checkpoint action');
  assert.equal(String(summary.mcpCommand).includes('codex'), true, 'setup should print the exact codex mcp add command');

  const config = JSON.parse(fs.readFileSync(path.join(sharedStoreRoot, 'config.json'), 'utf8'));
  assert.equal(config.runtime.paths.workspaceRoot, sharedStoreRoot, 'standalone workspace root should default to the shared standalone store');
  assert.equal(config.llm.provider, 'none', 'codex defaults should keep llm.provider at none');
  assert.equal(config.vault.enabled, false, 'codex defaults should keep the vault disabled');
  assert.equal(config.codex.userProfilePath, sharedUserStore, 'setup should enable the shared personal store by default');
  assert.equal(config.codex.defaultProjectScope, summary.projectScope, 'setup should make the repo scope the default project scope');
  assert.deepEqual(config.codex.recallOrder, ['project', 'user', 'remote'], 'setup should recall repo, user, then remote memory by default');

  assert.equal(fs.existsSync(path.join(projectRoot, '.gitignore')), false, 'global-mode setup should not touch repo .gitignore');

  const agents = fs.readFileSync(path.join(projectRoot, 'AGENTS.md'), 'utf8');
  assert.equal(agents.includes('gigabrain_recall'), true, 'setup should install the Codex-specific AGENTS block');
  assert.equal(agents.includes('gigabrain_checkpoint'), true, 'setup should document the checkpoint tool');
  assert.equal(agents.includes('Do not grep Gigabrain store files directly'), true, 'AGENTS block should prefer the MCP server');
  assert.equal(agents.includes(summary.projectScope), true, 'AGENTS block should teach the repo-specific scope');
  assert.equal(agents.includes('target: "user"'), true, 'AGENTS block should teach personal-memory targeting');
  assert.equal(agents.includes('target: "project"'), true, 'AGENTS block should teach repo-memory targeting');

  const verify = spawnSync(path.join(projectRoot, '.codex', 'actions', 'verify-gigabrain.sh'), [], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeRoot,
    },
  });
  if (verify.status !== 0) {
    throw new Error(`verify action failed:\n${verify.stderr || verify.stdout}`);
  }
  const verifyResult = JSON.parse(String(verify.stdout || '{}'));
  assert.equal(verifyResult.ok, true, 'verify action should report both stores healthy');
  assert.equal(Array.isArray(verifyResult.stores), true, 'verify action should include store health');
  assert.equal(verifyResult.stores.length, 2, 'verify action should report both project and user stores');
  assert.equal(verifyResult.stores.some((store) => store.target === 'user' && store.ok === true), true, 'verify action should report the personal store as healthy');
  assert.equal(verifyResult.standalone_path_kind, 'canonical', 'doctor should report the canonical standalone path');
  assert.equal(verifyResult.sharing_mode, 'shared-standalone', 'doctor should explain the standalone sharing mode');

  const checkpoint = spawnSync(path.join(projectRoot, '.codex', 'actions', 'checkpoint-gigabrain-session.sh'), [
    '--summary', 'Implemented the Codex App checkpoint workflow.',
    '--decision', 'Use task-end checkpoints in the Codex App.',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeRoot,
    },
  });
  if (checkpoint.status !== 0) {
    throw new Error(`checkpoint action failed:\n${checkpoint.stderr || checkpoint.stdout}`);
  }
  const checkpointResult = JSON.parse(String(checkpoint.stdout || '{}'));
  assert.equal(checkpointResult.ok, true, 'checkpoint action should succeed');
  assert.equal(checkpointResult.written_native, true, 'checkpoint action should write a native log');
  assert.equal(checkpointResult.scope, summary.projectScope, 'checkpoint action should use the repo-specific scope automatically');
  assert.equal(fs.existsSync(checkpointResult.source_path), true, 'checkpoint action should create the daily session log');

  const staleConfigPath = path.join(sharedStoreRoot, 'config.json');
  fs.writeFileSync(staleConfigPath, `${JSON.stringify({
    ...config,
    codex: {
      ...config.codex,
      userProfilePath: '',
      defaultProjectScope: 'codex:global',
      recallOrder: ['project', 'remote'],
    },
  }, null, 2)}\n`, 'utf8');

  const rerun = runSetup({ projectRoot, homeRoot });
  if (rerun.status !== 0) {
    throw new Error(`codex setup rerun failed:\n${rerun.stderr || rerun.stdout}`);
  }
  const rerunSummary = JSON.parse(String(rerun.stdout || '{}'));
  const migratedConfig = JSON.parse(fs.readFileSync(staleConfigPath, 'utf8'));
  assert.equal(migratedConfig.codex.userProfilePath, sharedUserStore, 'setup rerun should migrate empty userProfilePath to the shared personal store');
  assert.equal(migratedConfig.codex.defaultProjectScope, rerunSummary.projectScope, 'setup rerun should migrate the project default scope to the repo scope');
  assert.deepEqual(migratedConfig.codex.recallOrder, ['project', 'user', 'remote'], 'setup rerun should migrate recall order to include the personal store');
  assert.equal(fs.existsSync(checkpointResult.source_path), true, 'setup rerun should preserve previously written native project memory');
  assert.equal(rerunSummary.standalonePathKind, 'canonical', 'setup rerun should keep using the canonical standalone path');
};

export { run };
