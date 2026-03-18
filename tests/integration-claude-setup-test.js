import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const runClaudeSetup = ({ projectRoot, homeRoot }) => spawnSync('node', [
  'scripts/gigabrain-claude-setup.js',
  '--project-root', projectRoot,
], {
  cwd: repoRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    HOME: homeRoot,
  },
});

const runCodexSetup = ({ projectRoot, homeRoot }) => spawnSync('node', [
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

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));

const run = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-claude-setup-'));
  const projectRoot = path.join(root, 'project');
  const homeRoot = path.join(root, 'home');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(homeRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({
    name: 'claude-project',
    private: true,
  }, null, 2), 'utf8');

  const result = runClaudeSetup({ projectRoot, homeRoot });
  if (result.status !== 0) {
    throw new Error(`claude setup failed:\n${result.stderr || result.stdout}`);
  }

  const summary = JSON.parse(String(result.stdout || '{}'));
  const sharedStoreRoot = path.join(homeRoot, '.gigabrain');
  const sharedUserStore = path.join(sharedStoreRoot, 'profile');
  assert.equal(summary.ok, true, 'claude setup should succeed');
  assert.equal(summary.storeMode, 'global', 'claude setup should default to the shared global standalone store');
  assert.equal(summary.sharingMode, 'shared-standalone', 'claude setup should report shared standalone mode');
  assert.equal(summary.standalonePathKind, 'canonical', 'fresh Claude setup should use the canonical standalone path');
  assert.equal(summary.projectStorePath, sharedStoreRoot, 'claude setup should report the shared project store');
  assert.equal(summary.userStorePath, sharedUserStore, 'claude setup should report the shared personal store');
  assert.equal(summary.standaloneConfigPath, path.join(sharedStoreRoot, 'config.json'), 'claude setup should report the canonical standalone config');
  assert.equal(fs.existsSync(path.join(projectRoot, 'CLAUDE.md')), true, 'claude setup should create CLAUDE.md');
  assert.equal(fs.existsSync(path.join(projectRoot, '.mcp.json')), true, 'claude setup should create .mcp.json');
  assert.equal(fs.existsSync(path.join(projectRoot, '.claude', 'setup.sh')), true, 'claude setup should create .claude/setup.sh');
  assert.equal(fs.existsSync(path.join(projectRoot, '.claude', 'actions', 'launch-gigabrain-mcp.sh')), true, 'claude setup should create a project-local MCP launcher');
  assert.equal(fs.existsSync(path.join(projectRoot, '.claude', 'actions', 'verify-gigabrain.sh')), true, 'claude setup should create a verify action');
  assert.equal(fs.existsSync(path.join(projectRoot, '.claude', 'actions', 'run-gigabrain-maintenance.sh')), true, 'claude setup should create a maintenance action');
  assert.equal(fs.existsSync(path.join(projectRoot, '.claude', 'actions', 'checkpoint-gigabrain-session.sh')), true, 'claude setup should create a checkpoint action');

  const config = readJson(path.join(sharedStoreRoot, 'config.json'));
  assert.equal(config.runtime.paths.workspaceRoot, sharedStoreRoot, 'standalone workspace root should default to the shared standalone store');
  assert.equal(config.codex.userProfilePath, sharedUserStore, 'claude setup should keep the shared personal store');
  assert.equal(config.codex.defaultProjectScope, summary.projectScope, 'claude setup should use the repo scope as the default project scope');
  assert.deepEqual(config.codex.recallOrder, ['project', 'user', 'remote'], 'claude setup should keep the shared recall order');

  const claudeMd = fs.readFileSync(path.join(projectRoot, 'CLAUDE.md'), 'utf8');
  assert.equal(claudeMd.includes('gigabrain_recall'), true, 'CLAUDE.md should teach recall first');
  assert.equal(claudeMd.includes('gigabrain_checkpoint'), true, 'CLAUDE.md should document checkpoints');
  assert.equal(claudeMd.includes(summary.projectScope), true, 'CLAUDE.md should include the repo-specific scope');
  assert.equal(claudeMd.includes('target: "user"'), true, 'CLAUDE.md should teach personal-memory targeting');
  assert.equal(claudeMd.includes('target: "project"'), true, 'CLAUDE.md should teach repo-memory targeting');

  const mcp = readJson(path.join(projectRoot, '.mcp.json'));
  assert.equal(typeof mcp.mcpServers, 'object', 'Claude mcp config should define mcpServers');
  assert.equal(mcp.mcpServers.gigabrain.command, '/bin/sh', 'Gigabrain server entry should use the project-local launcher via /bin/sh');
  assert.deepEqual(mcp.mcpServers.gigabrain.args, [path.join(projectRoot, '.claude', 'actions', 'launch-gigabrain-mcp.sh')], 'Claude mcp config should point at the project-local launcher');

  const verify = spawnSync(path.join(projectRoot, '.claude', 'actions', 'verify-gigabrain.sh'), [], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeRoot,
    },
  });
  if (verify.status !== 0) {
    throw new Error(`claude verify action failed:\n${verify.stderr || verify.stdout}`);
  }
  const verifyResult = JSON.parse(String(verify.stdout || '{}'));
  assert.equal(verifyResult.ok, true, 'claude verify action should report both stores healthy');
  assert.equal(verifyResult.stores.length, 2, 'claude verify action should report both stores');
  assert.equal(verifyResult.standalone_path_kind, 'canonical', 'claude doctor should report the canonical standalone path');
  const verifyScript = fs.readFileSync(path.join(projectRoot, '.claude', 'actions', 'verify-gigabrain.sh'), 'utf8');
  assert.equal(verifyScript.includes('node_modules/.bin/$tool'), true, 'claude verify action should prefer repo-local binaries through the shared helper resolver');
  assert.equal(verifyScript.includes('npx --no-install "$tool"'), true, 'claude verify action should fall back to npx without reinstalling');

  const checkpoint = spawnSync(path.join(projectRoot, '.claude', 'actions', 'checkpoint-gigabrain-session.sh'), [
    '--summary', 'Implemented Claude Desktop MCP support.',
    '--decision', 'Use CLAUDE.md plus .mcp.json for Claude projects.',
  ], {
    cwd: projectRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: homeRoot,
    },
  });
  if (checkpoint.status !== 0) {
    throw new Error(`claude checkpoint action failed:\n${checkpoint.stderr || checkpoint.stdout}`);
  }
  const checkpointResult = JSON.parse(String(checkpoint.stdout || '{}'));
  assert.equal(checkpointResult.ok, true, 'claude checkpoint action should succeed');
  assert.equal(checkpointResult.scope, summary.projectScope, 'claude checkpoint should use the repo-specific scope automatically');
  assert.equal(fs.existsSync(checkpointResult.source_path), true, 'claude checkpoint should create the daily session log');
  assert.equal(checkpointResult.written_sections.includes('Claude Sessions'), true, 'claude checkpoint should write into a Claude-specific session section');
  const checkpointNote = fs.readFileSync(checkpointResult.source_path, 'utf8');
  assert.equal(checkpointNote.includes('Claude session:'), true, 'claude checkpoint should label the native summary as a Claude session');

  fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), `# Project notes\n\nKeep this text.\n\n${claudeMd}`, 'utf8');
  fs.writeFileSync(path.join(projectRoot, '.mcp.json'), `${JSON.stringify({
    mcpServers: {
      other: {
        command: 'python3',
        args: ['-m', 'other-server'],
      },
    },
  }, null, 2)}\n`, 'utf8');

  const rerun = runClaudeSetup({ projectRoot, homeRoot });
  if (rerun.status !== 0) {
    throw new Error(`claude setup rerun failed:\n${rerun.stderr || rerun.stdout}`);
  }
  const rerunSummary = JSON.parse(String(rerun.stdout || '{}'));
  const rerunClaudeMd = fs.readFileSync(path.join(projectRoot, 'CLAUDE.md'), 'utf8');
  const rerunMcp = readJson(path.join(projectRoot, '.mcp.json'));
  assert.equal(rerunClaudeMd.includes('Keep this text.'), true, 'rerun should preserve user-authored CLAUDE.md content');
  assert.equal(rerunClaudeMd.includes(rerunSummary.projectScope), true, 'rerun should refresh the managed Gigabrain scope block');
  assert.equal(typeof rerunMcp.mcpServers.other, 'object', 'rerun should preserve unrelated MCP servers');
  assert.equal(typeof rerunMcp.mcpServers.gigabrain, 'object', 'rerun should upsert the Gigabrain MCP server');

  const coexistRoot = fs.mkdtempSync(path.join(root, 'coexist-'));
  const codexFirstProject = path.join(coexistRoot, 'codex-first');
  const claudeFirstProject = path.join(coexistRoot, 'claude-first');
  fs.mkdirSync(codexFirstProject, { recursive: true });
  fs.mkdirSync(claudeFirstProject, { recursive: true });
  fs.writeFileSync(path.join(codexFirstProject, 'package.json'), '{"name":"codex-first","private":true}\n', 'utf8');
  fs.writeFileSync(path.join(claudeFirstProject, 'package.json'), '{"name":"claude-first","private":true}\n', 'utf8');

  const codexFirst = runCodexSetup({ projectRoot: codexFirstProject, homeRoot });
  if (codexFirst.status !== 0) throw new Error(`codex-first setup failed:\n${codexFirst.stderr || codexFirst.stdout}`);
  const codexFirstSummary = JSON.parse(String(codexFirst.stdout || '{}'));
  const codexThenClaude = runClaudeSetup({ projectRoot: codexFirstProject, homeRoot });
  if (codexThenClaude.status !== 0) throw new Error(`claude after codex failed:\n${codexThenClaude.stderr || codexThenClaude.stdout}`);
  const codexThenClaudeSummary = JSON.parse(String(codexThenClaude.stdout || '{}'));
  assert.equal(codexThenClaudeSummary.projectScope, codexFirstSummary.projectScope, 'codex then claude should preserve the same project scope');
  assert.equal(codexThenClaudeSummary.standaloneConfigPath, path.join(sharedStoreRoot, 'config.json'), 'codex then claude should continue using the same shared standalone config');
  assert.equal(readJson(path.join(codexFirstProject, '.mcp.json')).mcpServers.gigabrain.command, '/bin/sh', 'codex then claude should leave Claude MCP wiring installed through the launcher');
  assert.equal(fs.existsSync(path.join(codexFirstProject, '.codex', 'actions', 'verify-gigabrain.sh')), true, 'codex then claude should preserve Codex actions');

  const claudeFirst = runClaudeSetup({ projectRoot: claudeFirstProject, homeRoot });
  if (claudeFirst.status !== 0) throw new Error(`claude-first setup failed:\n${claudeFirst.stderr || claudeFirst.stdout}`);
  const claudeFirstSummary = JSON.parse(String(claudeFirst.stdout || '{}'));
  const claudeThenCodex = runCodexSetup({ projectRoot: claudeFirstProject, homeRoot });
  if (claudeThenCodex.status !== 0) throw new Error(`codex after claude failed:\n${claudeThenCodex.stderr || claudeThenCodex.stdout}`);
  const claudeThenCodexSummary = JSON.parse(String(claudeThenCodex.stdout || '{}'));
  assert.equal(claudeThenCodexSummary.projectScope, claudeFirstSummary.projectScope, 'claude then codex should preserve the same project scope');
  assert.equal(claudeThenCodexSummary.standaloneConfigPath, path.join(sharedStoreRoot, 'config.json'), 'claude then codex should continue using the same shared standalone config');
  assert.equal(fs.existsSync(path.join(claudeFirstProject, 'CLAUDE.md')), true, 'claude then codex should preserve CLAUDE.md');
  assert.equal(fs.existsSync(path.join(claudeFirstProject, '.codex', 'actions', 'verify-gigabrain.sh')), true, 'claude then codex should add Codex actions');
};

export { run };
