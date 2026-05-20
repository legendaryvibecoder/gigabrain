import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { hashNormalized, normalizeContent } from '../lib/core/policy.js';
import {
  exportMemoryBrief,
  getSyncStatus,
  listMemorySources,
  syncHostMemories,
} from '../lib/core/host-memory-sync.js';
import { makeTempWorkspace, openDb } from './helpers.js';

const writeText = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
};

const run = async () => {
  const temp = makeTempWorkspace('gb-host-sync-');
  const db = openDb(temp.dbPath);
  const codexHome = path.join(temp.root, 'codex-home');
  const claudeHome = path.join(temp.root, 'claude-home');
  const hermesHome = path.join(temp.root, 'hermes-home');
  const codexMemory = path.join(codexHome, 'memories', 'prefs.md');
  const claudeMemory = path.join(claudeHome, 'projects', 'example', 'memory', 'prefs.md');
  const hermesMemory = path.join(hermesHome, 'memories', 'MEMORY.md');
  const manualImport = path.join(temp.root, 'exports', 'chatgpt-export.md');
  const sharedLine = 'User prefers concise setup docs.';
  const secretValue = 'sk-secret1234567890abcdef';
  const config = {
    runtime: {
      paths: {
        workspaceRoot: temp.workspace,
      },
    },
    codex: {
      projectRoot: temp.workspace,
      defaultUserScope: 'profile:user',
    },
  };

  try {
    writeText(codexMemory, `- ${sharedLine}\n- OPENAI_API_KEY=${secretValue}\n`);
    writeText(claudeMemory, `- ${sharedLine}\n`);
    writeText(hermesMemory, '- Hermes should recall Nimbus through Gigabrain MCP.\n');

    const sync = syncHostMemories({
      db,
      config,
      codexHome,
      claudeHome,
      hermesHome,
      hosts: ['codex', 'claude_code'],
      scope: 'profile:user',
    });
    assert.equal(sync.ok, true, 'host sync should succeed');
    assert.deepEqual(sync.summary, {
      source_count: 2,
      indexed_count: 3,
      inserted_count: 2,
      linked_count: 3,
      skipped_count: 0,
    }, 'host sync should return compact summary counts');
    assert.equal(sync.indexed_count, 3, 'host sync should index all visible local lines');
    assert.equal(sync.linked_count, 3, 'host sync should link every imported line to provenance');
    assert.equal(Array.isArray(sync.warnings), true, 'host sync should return warnings array');

    const sharedHash = hashNormalized(normalizeContent(sharedLine));
    const sharedRows = db.prepare(`
      SELECT memory_id, source_host, source_kind, sync_policy
      FROM memory_current
      WHERE normalized_hash = ? AND scope = 'profile:user' AND status = 'active'
    `).all(sharedHash);
    assert.equal(sharedRows.length, 1, 'exact host duplicates should collapse to one current memory');
    assert.equal(sharedRows[0].source_host, 'codex', 'the first importer keeps canonical metadata');
    assert.equal(sharedRows[0].source_kind, 'native_memory');
    assert.equal(sharedRows[0].sync_policy, 'read_only');

    const links = db.prepare(`
      SELECT source_host, source_kind, sync_policy, source_path, source_line
      FROM memory_source_links
      WHERE memory_id = ?
      ORDER BY source_host ASC
    `).all(sharedRows[0].memory_id);
    assert.deepEqual(
      links.map((row) => row.source_host),
      ['claude_code', 'codex'],
      'deduped memories should retain both host provenance links',
    );
    assert.equal(links.every((row) => row.source_kind === 'native_memory'), true, 'local host links should be native memories');
    assert.equal(links.every((row) => row.sync_policy === 'read_only'), true, 'local host links should be read-only');

    const storedText = db.prepare("SELECT GROUP_CONCAT(content, '\n') AS text FROM memory_current").get()?.text || '';
    assert.equal(storedText.includes(secretValue), false, 'host sync must not store raw secrets');
    assert.equal(storedText.includes('[REDACTED_SECRET]'), true, 'host sync should leave a visible redaction marker');

    const sources = listMemorySources({ db, config });
    assert.equal(sources.sources.some((row) => row.source_host === 'codex' && row.memory_count >= 2), true, 'sources should include Codex counts');
    assert.equal(sources.sources.some((row) => row.source_host === 'claude_code' && row.memory_count >= 1), true, 'sources should include Claude Code counts');

    const hermes = syncHostMemories({
      db,
      config,
      hermesHome,
      hosts: ['hermes'],
      scope: 'profile:user',
    });
    assert.equal(hermes.ok, true, 'Hermes host sync should succeed');
    assert.equal(hermes.summary.source_count, 1, 'Hermes sync should see the Hermes memories folder');
    assert.equal(hermes.summary.inserted_count, 1, 'Hermes sync should import one local memory line');
    const hermesRow = db.prepare(`
      SELECT source_host, source_kind, sync_policy
      FROM memory_current
      WHERE content LIKE '%Nimbus through Gigabrain MCP%'
      LIMIT 1
    `).get();
    assert.equal(hermesRow.source_host, 'hermes');
    assert.equal(hermesRow.source_kind, 'native_memory');
    assert.equal(hermesRow.sync_policy, 'read_only');

    const status = getSyncStatus({ db, config, codexHome, claudeHome, hermesHome });
    assert.equal(status.hosts.some((row) => row.source_host === 'codex' && row.status === 'ok'), true, 'sync status should report the Codex run');
    assert.equal(status.groups.ready.some((row) => row.source_host === 'codex'), true, 'sync status should group ready hosts');
    assert.equal(status.groups.manual_only.some((row) => row.source_host === 'chatgpt_manual'), true, 'sync status should group manual-only hosts');
    assert.equal(status.groups.bridge.some((row) => row.source_host === 'hermes' && row.local_sources_detected >= 1), true, 'sync status should group Hermes bridge/local source availability');
    assert.equal(status.hermes_bridge.mode, 'mcp_or_http_bridge', 'Hermes should be represented as a bridge, not a fake local path');

    writeText(manualImport, '- Manual cloud preference: user likes one-page briefs.\n');
    const manual = syncHostMemories({
      db,
      config,
      hosts: ['chatgpt_manual'],
      manualImportPath: manualImport,
      manualSourceHost: 'chatgpt_manual',
      scope: 'profile:user',
    });
    assert.equal(manual.ok, true, 'manual cloud import should succeed when explicitly provided');
    const manualRow = db.prepare(`
      SELECT source_host, source_kind, sync_policy
      FROM memory_current
      WHERE content LIKE '%one-page briefs%'
      LIMIT 1
    `).get();
    assert.equal(manualRow.source_host, 'chatgpt_manual');
    assert.equal(manualRow.source_kind, 'manual_import');
    assert.equal(manualRow.sync_policy, 'bidirectional_disallowed', 'manual cloud imports must not imply bidirectional sync');

    const brief = exportMemoryBrief({
      db,
      config,
      targetHost: 'claude_code',
      scope: 'profile:user',
      limit: 20,
    });
    assert.equal(brief.ok, true);
    assert.equal(brief.brief.includes('does not scrape'), true, 'export brief should state the closed-cloud boundary');
    assert.equal(brief.brief.includes(secretValue), false, 'export brief should not leak raw secrets');
    assert.equal(brief.brief.includes('[REDACTED_SECRET]'), false, 'export brief should omit secret-risk rows entirely');
    assert.equal(brief.omitted_secret_risks, 1, 'export brief should report omitted secret-risk rows');
    assert.equal(brief.brief.includes('User prefers concise setup docs.'), true, 'export brief should include useful memories');
  } finally {
    db.close();
  }
};

export { run };
