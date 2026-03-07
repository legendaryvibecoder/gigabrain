import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeConfig } from '../lib/core/config.js';
import { ensureNativeStore } from '../lib/core/native-sync.js';
import { ensurePersonStore } from '../lib/core/person-service.js';
import { buildVaultSurface, inspectVaultHealth, syncVaultPull } from '../lib/core/vault-mirror.js';
import { makeConfigObject, makeTempWorkspace, openDb, seedMemoryCurrent } from './helpers.js';

const run = async () => {
  const ws = makeTempWorkspace('gb-v4-vault-surface-');
  fs.writeFileSync(path.join(ws.workspace, 'MEMORY.md'), '# MEMORY\n\n- [m:m-1] Jordan treats Atlas as a teammate, not a tool.\n', 'utf8');
  fs.writeFileSync(path.join(ws.memoryRoot, '2026-03-06-session-start.md'), '# Session\n\n- kicked off vault planning\n', 'utf8');
  fs.writeFileSync(path.join(ws.memoryRoot, 'latest.md'), '# Latest\n\n- current state\n', 'utf8');
  fs.mkdirSync(path.join(ws.memoryRoot, 'private'), { recursive: true });
  fs.writeFileSync(path.join(ws.memoryRoot, 'private', 'secret.md'), '# Secret\n', 'utf8');

  const openclaw = makeConfigObject(ws.workspace);
  openclaw.plugins.entries.gigabrain.config.vault = {
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
  const config = normalizeConfig(openclaw.plugins.entries.gigabrain.config);

  const stalePath = path.join(config.vault.path, config.vault.subdir, '20 Nodes', 'active', 'CONTEXT', 'stale.md');
  const inboxKeepPath = path.join(config.vault.path, config.vault.subdir, 'Inbox', 'keep.md');
  const legacyMemoryPath = path.join(config.vault.path, config.vault.subdir, 'memory', 'legacy.md');
  fs.mkdirSync(path.dirname(stalePath), { recursive: true });
  fs.mkdirSync(path.dirname(inboxKeepPath), { recursive: true });
  fs.mkdirSync(path.dirname(legacyMemoryPath), { recursive: true });
  fs.writeFileSync(stalePath, '# stale\n', 'utf8');
  fs.writeFileSync(inboxKeepPath, '# keep me\n', 'utf8');
  fs.writeFileSync(legacyMemoryPath, '# legacy\n', 'utf8');

  const db = openDb(ws.dbPath);
  try {
    seedMemoryCurrent(db, [
      {
        memory_id: 'm-1',
        type: 'PREFERENCE',
        content: 'Jordan treats Atlas as a teammate, not a tool.',
        scope: 'nimbusmain',
        confidence: 0.92,
        value_score: 0.91,
        value_label: 'keep',
      },
      {
        memory_id: 'm-2',
        type: 'USER_FACT',
        content: 'Jordan wants to improve fitness and reach a healthier goal weight.',
        scope: 'nimbusmain',
        confidence: 0.87,
        value_score: 0.84,
        value_label: 'keep',
      },
      {
        memory_id: 'm-3',
        type: 'PREFERENCE',
        content: 'Jordan prefers pour-over coffee.',
        scope: 'profile:main',
        confidence: 0.86,
        value_score: 0.83,
        value_label: 'core',
        source: 'promoted_native',
        source_layer: 'promoted_native',
        source_path: path.join(ws.workspace, 'MEMORY.md'),
        source_line: 2,
      },
    ]);
    ensureNativeStore(db);
    ensurePersonStore(db);
    db.prepare(`
      INSERT INTO memory_native_chunks (
        chunk_id, source_path, source_kind, source_date, section, line_start, line_end,
        content, normalized, hash, linked_memory_id, first_seen_at, last_seen_at, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'chunk-1',
      path.join(ws.workspace, 'MEMORY.md'),
      'memory_md',
      '2026-03-06',
      'MEMORY',
      2,
      2,
      'Jordan treats Atlas as a teammate, not a tool.',
      'chris treats nimbus as someone not something',
      'hash-1',
      'm-1',
      new Date().toISOString(),
      new Date().toISOString(),
      'active',
    );
    const mentionInsert = db.prepare(`
      INSERT INTO memory_entity_mentions (
        id, memory_id, entity_key, entity_display, role, confidence, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    mentionInsert.run('m-1|atlas', 'm-1', 'atlas', 'Atlas', 'relationship', 0.95, 'memory_current');
    mentionInsert.run('m-2|atlas', 'm-2', 'atlas', 'Atlas', 'relationship', 0.9, 'memory_current');

    const summary = buildVaultSurface({
      db,
      config,
      dryRun: false,
      runId: 'vault-surface-test',
    });

    assert.equal(summary.enabled, true);
    assert.equal(summary.active_nodes, 3, 'active nodes should be exported');
    assert.equal(summary.native_sources.total >= 3, true, 'MEMORY + daily + curated file should count as native sources');
    assert.equal(fs.existsSync(path.join(config.vault.path, config.vault.subdir, '00 Home', 'Home.md')), true, 'home note should exist');
    assert.equal(fs.existsSync(path.join(config.vault.path, config.vault.subdir, '10 Native', 'MEMORY.md')), true, 'MEMORY.md should be mirrored into 10 Native');
    assert.equal(fs.existsSync(path.join(config.vault.path, config.vault.subdir, '10 Native', 'memory', '2026-03-06-session-start.md')), true, 'daily note should be mirrored into 10 Native');
    assert.equal(fs.existsSync(path.join(config.vault.path, config.vault.subdir, '20 Nodes', 'active', 'PREFERENCE', 'm-1.md')), true, 'node note should exist');
    assert.equal(fs.existsSync(path.join(config.vault.path, config.vault.subdir, '30 Views', 'Relationships.md')), true, 'relationships view should exist');
    assert.equal(fs.existsSync(path.join(config.vault.path, config.vault.subdir, '30 Views', 'Promoted Memories.md')), true, 'promoted memories view should exist');
    assert.equal(fs.existsSync(path.join(config.vault.path, config.vault.subdir, '30 Views', 'Registry-only Memories.md')), true, 'registry-only memories view should exist');
    assert.equal(fs.existsSync(path.join(config.vault.path, config.vault.subdir, '40 Reports', 'vault-manifest.json')), true, 'manifest should exist');
    assert.equal(fs.existsSync(path.join(ws.outputRoot, 'memory-surface-summary.json')), true, 'shared surface summary should exist in output');
    assert.equal(fs.existsSync(stalePath), false, 'stale generated file should be removed');
    assert.equal(fs.existsSync(legacyMemoryPath), false, 'legacy flat mirror paths should be removed');
    assert.equal(fs.existsSync(inboxKeepPath), true, 'manual inbox content must be preserved');

    const manifest = JSON.parse(fs.readFileSync(path.join(config.vault.path, config.vault.subdir, '40 Reports', 'vault-manifest.json'), 'utf8'));
    assert.equal(manifest.generated_files.includes('40 Reports/vault-manifest.json'), true, 'manifest should include itself');
    assert.equal(manifest.generated_files.includes('40 Reports/vault-freshness.json'), true, 'manifest should include freshness report');
    assert.equal(manifest.generated_files.includes('40 Reports/surface-summary.json'), true, 'manifest should include surface summary report');

    const nodeContent = fs.readFileSync(path.join(config.vault.path, config.vault.subdir, '20 Nodes', 'active', 'PREFERENCE', 'm-1.md'), 'utf8');
    assert.match(nodeContent, /id: m-1/, 'node frontmatter should include memory id');
    assert.match(nodeContent, /source_layer: native/, 'node frontmatter should include source layer');
    assert.match(nodeContent, /\[\[10 Native\/MEMORY(?:\|[^\]]+)?\]\]/, 'node should link to native source');

    const promotedView = fs.readFileSync(path.join(config.vault.path, config.vault.subdir, '30 Views', 'Promoted Memories.md'), 'utf8');
    assert.match(promotedView, /Jordan prefers pour-over coffee\./, 'promoted memories view should list promoted-native nodes');

    const health = inspectVaultHealth({ config, db });
    assert.equal(health.enabled, true, 'vault doctor should report enabled');
    assert.equal(health.manual_protection.ok, true, 'manual folder protection should be healthy after build');

    const staleKeepPath = path.join(config.vault.path, config.vault.subdir, '20 Nodes', 'active', 'CONTEXT', 'keep-stale.md');
    fs.mkdirSync(path.dirname(staleKeepPath), { recursive: true });
    fs.writeFileSync(staleKeepPath, '# keep stale\n', 'utf8');
    config.vault.clean = false;
    buildVaultSurface({
      db,
      config,
      dryRun: false,
      runId: 'vault-surface-test-clean-disabled',
    });
    assert.equal(fs.existsSync(staleKeepPath), true, 'clean=false should preserve stale generated files');
    config.vault.clean = true;

    fs.rmSync(path.join(config.vault.path, config.vault.subdir, 'Manual'), { recursive: true, force: true });
    const staleHealth = inspectVaultHealth({ config, db });
    assert.equal(staleHealth.manual_protection.ok, false, 'vault doctor should re-check manual folder protection from disk');
    assert.match(staleHealth.manual_protection.issues.join('\n'), /missing manual folder: Manual/);
  } finally {
    db.close();
  }

  const pullTarget = path.join(ws.root, 'pull-target');
  fs.mkdirSync(path.join(pullTarget, '.obsidian'), { recursive: true });
  fs.mkdirSync(path.join(pullTarget, config.vault.subdir, 'Manual'), { recursive: true });
  fs.writeFileSync(path.join(pullTarget, '.obsidian', 'workspace.json'), '{}\n', 'utf8');
  fs.writeFileSync(path.join(pullTarget, config.vault.subdir, 'Manual', 'local.md'), '# local manual note\n', 'utf8');

  const pull = syncVaultPull({
    remotePath: config.vault.path,
    target: pullTarget,
    subdir: config.vault.subdir,
    manualFolders: config.vault.manualFolders,
    preserveManual: true,
    dryRun: false,
  });
  assert.equal(pull.ok, true, 'vault pull should succeed locally');
  assert.equal(fs.existsSync(path.join(pullTarget, config.vault.subdir, '00 Home', 'Home.md')), true, 'pull target should receive generated home note');
  assert.equal(fs.existsSync(path.join(pullTarget, config.vault.subdir, 'Manual', 'local.md')), true, 'pull must preserve manual files');
  assert.equal(fs.existsSync(path.join(pullTarget, '.obsidian', 'workspace.json')), true, 'pull must preserve .obsidian files');
};

export { run };
