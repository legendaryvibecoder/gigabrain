import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

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
    prefix: 'gb-packaged-sync-pack-',
  });
  const { packageRoot } = installTarballIntoTempApp({
    tarballPath,
    prefix: 'gb-packaged-sync-app-',
  });

  assert.equal(fs.existsSync(path.join(packageRoot, 'lib', 'core', 'host-memory-sync.js')), true, 'package should include host-memory-sync core');
  assert.equal(fs.existsSync(path.join(packageRoot, 'docs', 'cross-memory-pivot-2026-04.md')), true, 'package should include cross-memory docs');
  assert.equal(fs.existsSync(path.join(packageRoot, 'release-notes', 'v0.7.0-cross-memory-pivot.md')), true, 'package should include v0.7 release notes');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-packaged-sync-'));
  const homeRoot = path.join(root, 'home');
  const projectRoot = path.join(root, 'project');
  const codexHome = path.join(homeRoot, '.codex');
  const claudeHome = path.join(homeRoot, '.claude');
  const hermesHome = path.join(homeRoot, '.hermes');
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name":"packaged-sync","private":true}\n', 'utf8');

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
    label: 'packaged sync setup',
  });

  const configPath = path.join(homeRoot, '.gigabrain', 'config.json');
  const dbPath = path.join(homeRoot, '.gigabrain', 'memory', 'registry.sqlite');
  const sharedMemory = 'User prefers cross-agent memory continuity.';
  const secretValue = 'sk-packaged1234567890abcdef';
  writeText(path.join(codexHome, 'memories', 'prefs.md'), `- ${sharedMemory}\n- OPENAI_API_KEY=${secretValue}\n`);
  writeText(path.join(claudeHome, 'projects', 'demo', 'memory', 'prefs.md'), `- ${sharedMemory}\n`);
  writeText(path.join(hermesHome, 'memories', 'MEMORY.md'), '- Hermes can use Gigabrain through MCP.\n');
  writeText(path.join(root, 'chatgpt-export.md'), '- Manual cloud preference: use one-page status briefs.\n');
  const legacyRegistry = path.join(root, 'openclaw-registry.sqlite');
  const legacyDb = new DatabaseSync(legacyRegistry);
  try {
    legacyDb.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        normalized TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL,
        status TEXT,
        scope TEXT,
        tags TEXT,
        created_at TEXT,
        updated_at TEXT,
        pinned INTEGER DEFAULT 0
      );
    `);
    legacyDb.prepare(`
      INSERT INTO memories (
        id, type, content, normalized, source, confidence, status, scope, tags, created_at, updated_at, pinned
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'legacy-packaged-1',
      'USER_FACT',
      'Nimbus backup memory says Telegram chat id 779443319.',
      'nimbus backup memory says telegram chat id 779443319',
      'capture',
      0.9,
      'active',
      'profile:nimbus',
      '[]',
      '2026-02-12T08:00:00.000Z',
      '2026-02-12T08:00:00.000Z',
      1,
    );
  } finally {
    legacyDb.close();
  }

  const help = runCommand({
    cmd: 'node',
    args: [path.join(packageRoot, 'scripts', 'gigabrainctl.js'), 'sync-hosts', '--help'],
    cwd: packageRoot,
    env,
    label: 'packaged sync-hosts help',
  });
  assert.equal(String(help.stdout || '').includes('Gigabrain sync-hosts'), true, 'sync-hosts --help should show subcommand help');
  assert.equal(String(help.stdout || '').includes('sync-hosts status'), true, 'sync-hosts --help should document status');
  assert.equal(String(help.stdout || '').includes('--hermes-home'), true, 'sync-hosts --help should document Hermes home override');

  const hermesSetup = runJsonCommand([
    path.join(packageRoot, 'scripts', 'gigabrain-hermes-setup.js'),
    '--config',
    configPath,
    '--workspace-root',
    projectRoot,
    '--hermes-bin',
    path.join(root, 'fake-hermes'),
    '--json',
  ], {
    cwd: packageRoot,
    env,
    label: 'packaged hermes setup dry command',
  });
  assert.equal(hermesSetup.ok, true, 'packaged Hermes setup should produce a command');
  assert.equal(hermesSetup.mcpAddCommand.includes('mcp add gigabrain'), true, 'Hermes setup should target hermes mcp add');
  assert.equal(hermesSetup.mcpAddCommand.includes('gigabrain-mcp.js'), true, 'Hermes setup should reference the packaged MCP server');

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
    label: 'packaged sync-hosts import',
  });
  assert.equal(sync.ok, true, 'packaged sync-hosts should succeed');
  assert.equal(sync.summary.source_count, 2, 'packaged sync-hosts should see Codex and Claude sources');
  assert.equal(sync.summary.inserted_count, 2, 'packaged sync-hosts should insert one shared memory and one redacted secret marker');
  assert.equal(sync.summary.linked_count, 3, 'packaged sync-hosts should retain both duplicate provenance links plus redacted secret link');
  assert.equal(Array.isArray(sync.warnings), true, 'packaged sync-hosts should return warnings array');

  const hermesSync = runJsonCommand([
    path.join(packageRoot, 'scripts', 'gigabrainctl.js'),
    'sync-hosts',
    '--config',
    configPath,
    '--hermes-home',
    hermesHome,
    '--host',
    'hermes',
    '--scope',
    'profile:user',
  ], {
    cwd: packageRoot,
    env,
    label: 'packaged sync-hosts hermes import',
  });
  assert.equal(hermesSync.ok, true, 'packaged Hermes host sync should succeed');
  assert.equal(hermesSync.summary.source_count, 1, 'packaged Hermes host sync should see one Hermes memory file');
  assert.equal(hermesSync.summary.inserted_count, 1, 'packaged Hermes host sync should import one Hermes memory');

  const manual = runJsonCommand([
    path.join(packageRoot, 'scripts', 'gigabrainctl.js'),
    'sync-hosts',
    '--config',
    configPath,
    '--manual-import',
    path.join(root, 'chatgpt-export.md'),
    '--manual-source-host',
    'chatgpt_manual',
    '--scope',
    'profile:user',
  ], {
    cwd: packageRoot,
    env,
    label: 'packaged sync-hosts manual import',
  });
  assert.equal(manual.ok, true, 'packaged manual cloud import should succeed');
  assert.equal(manual.summary.inserted_count, 1, 'packaged manual import should insert one memory');

  const openclawDryRun = runJsonCommand([
    path.join(packageRoot, 'scripts', 'gigabrainctl.js'),
    'import-openclaw',
    '--config',
    configPath,
    '--registry',
    legacyRegistry,
    '--source-label',
    'packaged-fixture',
    '--dry-run',
  ], {
    cwd: packageRoot,
    env,
    label: 'packaged import-openclaw dry-run',
  });
  assert.equal(openclawDryRun.ok, true, 'packaged import-openclaw dry-run should succeed');
  assert.equal(openclawDryRun.source_count, 1, 'packaged import-openclaw should count legacy memories');

  const sources = runJsonCommand([
    path.join(packageRoot, 'scripts', 'gigabrainctl.js'),
    'sync-hosts',
    'sources',
    '--config',
    configPath,
    '--codex-home',
    codexHome,
    '--claude-home',
    claudeHome,
    '--hermes-home',
    hermesHome,
    '--include-discovery',
  ], {
    cwd: packageRoot,
    env,
    label: 'packaged sync-hosts sources',
  });
  assert.equal(sources.ok, true, 'packaged sources should succeed');
  assert.equal(sources.discovered.some((row) => row.source_host === 'codex' && row.synced === true), true, 'sources discovery should flag synced Codex files');
  assert.equal(sources.discovered.some((row) => row.source_host === 'hermes' && row.synced === true), true, 'sources discovery should flag synced Hermes files');
  assert.equal(sources.sources.some((row) => row.source_host === 'chatgpt_manual'), true, 'sources should include manual cloud import');

  const status = runJsonCommand([
    path.join(packageRoot, 'scripts', 'gigabrainctl.js'),
    'sync-hosts',
    'status',
    '--config',
    configPath,
    '--codex-home',
    codexHome,
    '--claude-home',
    claudeHome,
    '--hermes-home',
    hermesHome,
  ], {
    cwd: packageRoot,
    env,
    label: 'packaged sync-hosts status',
  });
  assert.equal(status.ok, true, 'packaged status should succeed');
  assert.equal(status.groups.ready.some((row) => row.source_host === 'codex'), true, 'status should group Codex as ready');
  assert.equal(status.groups.manual_only.some((row) => row.source_host === 'chatgpt_manual'), true, 'status should group manual cloud hosts separately');
  assert.equal(status.groups.bridge.some((row) => row.source_host === 'hermes' && row.local_sources_detected >= 1), true, 'status should group Hermes as bridge with local source discovery');

  const brief = runJsonCommand([
    path.join(packageRoot, 'scripts', 'gigabrainctl.js'),
    'sync-hosts',
    'export-brief',
    '--config',
    configPath,
    '--scope',
    'profile:user',
    '--target-host',
    'agents',
    '--limit',
    '10',
  ], {
    cwd: packageRoot,
    env,
    label: 'packaged sync-hosts export brief',
  });
  assert.equal(brief.ok, true, 'packaged export brief should succeed');
  assert.equal(brief.brief.includes(sharedMemory), true, 'brief should include the imported shared memory');
  assert.equal(brief.brief.includes(secretValue), false, 'brief should not include raw secrets');
  assert.equal(brief.brief.includes('[REDACTED_SECRET]'), false, 'brief should omit secret-risk rows entirely');
  assert.equal(brief.omitted_secret_risks, 1, 'brief should report omitted secret-risk rows');
  assert.equal(brief.brief.includes('does not scrape'), true, 'brief should keep the closed-cloud boundary explicit');

  const db = new DatabaseSync(dbPath);
  try {
    const sharedRows = db.prepare(`
      SELECT COUNT(*) AS c
      FROM memory_current
      WHERE content = ? AND scope = 'profile:user' AND status = 'active'
    `).get(sharedMemory);
    assert.equal(Number(sharedRows?.c || 0), 1, 'duplicate Codex/Claude memory should be stored once');
    const links = db.prepare(`
      SELECT COUNT(*) AS c
      FROM memory_source_links
      WHERE memory_id = (
        SELECT memory_id FROM memory_current WHERE content = ? LIMIT 1
      )
    `).get(sharedMemory);
    assert.equal(Number(links?.c || 0), 2, 'duplicate Codex/Claude memory should keep two provenance links');
    const hermesRow = db.prepare(`
      SELECT source_host
      FROM memory_current
      WHERE content LIKE '%Gigabrain through MCP%'
      LIMIT 1
    `).get();
    assert.equal(hermesRow?.source_host, 'hermes', 'Hermes memory should retain Hermes source host');
    const manualRow = db.prepare(`
      SELECT sync_policy
      FROM memory_current
      WHERE source_host = 'chatgpt_manual'
      LIMIT 1
    `).get();
    assert.equal(manualRow?.sync_policy, 'bidirectional_disallowed', 'manual cloud import should never imply bidirectional sync');
  } finally {
    db.close();
  }
};

export { run };
