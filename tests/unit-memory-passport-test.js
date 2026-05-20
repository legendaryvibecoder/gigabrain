import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { buildMemoryPassport, writeMemoryPassport } from '../lib/core/memory-passport.js';
import { syncHostMemories } from '../lib/core/host-memory-sync.js';
import { upsertCurrentMemory } from '../lib/core/projection-store.js';
import { ensureWorldModelStore } from '../lib/core/world-model.js';
import { assertFileExists, makeTempWorkspace, openDb } from './helpers.js';

const writeText = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
};

const run = async () => {
  const temp = makeTempWorkspace('gb-passport-');
  const db = openDb(temp.dbPath);
  const codexHome = path.join(temp.root, 'codex-home');
  const claudeHome = path.join(temp.root, 'claude-home');
  const sharedMemory = 'User prefers launch notes with concrete verification evidence.';
  const rawSecret = 'sk-passport1234567890abcdef';
  const config = {
    runtime: {
      paths: {
        workspaceRoot: temp.workspace,
        outputDir: temp.outputRoot,
      },
    },
    codex: {
      projectRoot: temp.workspace,
      defaultUserScope: 'profile:user',
    },
  };

  try {
    writeText(path.join(codexHome, 'memories', 'prefs.md'), `- ${sharedMemory}\n`);
    writeText(path.join(claudeHome, 'projects', 'demo', 'memory', 'prefs.md'), `- ${sharedMemory}\n`);
    syncHostMemories({
      db,
      config,
      codexHome,
      claudeHome,
      hosts: ['codex', 'claude_code'],
      scope: 'profile:user',
    });

    upsertCurrentMemory(db, {
      memory_id: 'manual-dup-a',
      content: 'Duplicate launch preference should collapse later.',
      source_host: 'manual',
      source_kind: 'manual_import',
      source_path: path.join(temp.root, 'manual-a.md'),
      scope: 'profile:user',
      updated_at: '2025-01-01T00:00:00.000Z',
      created_at: '2025-01-01T00:00:00.000Z',
    });
    upsertCurrentMemory(db, {
      memory_id: 'manual-dup-b',
      content: 'Duplicate launch preference should collapse later.',
      source_host: 'manual',
      source_kind: 'manual_import',
      source_path: path.join(temp.root, 'manual-b.md'),
      scope: 'profile:user',
      updated_at: '2025-01-02T00:00:00.000Z',
      created_at: '2025-01-02T00:00:00.000Z',
    });
    upsertCurrentMemory(db, {
      memory_id: 'raw-secret-risk',
      content: `OPENAI_API_KEY=${rawSecret}`,
      scope: 'profile:user',
      updated_at: '2026-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
    });
    upsertCurrentMemory(db, {
      memory_id: 'raw-secret-risk-copy',
      content: `OPENAI_API_KEY=${rawSecret}`,
      scope: 'profile:user',
      updated_at: '2026-01-02T00:00:00.000Z',
      created_at: '2026-01-02T00:00:00.000Z',
    });
    upsertCurrentMemory(db, {
      memory_id: 'stale-memory',
      content: 'Old launch plan from a previous positioning pass.',
      source_host: 'codex',
      source_kind: 'native_memory',
      source_path: path.join(codexHome, 'memories', 'old.md'),
      scope: 'profile:user',
      updated_at: '2024-01-01T00:00:00.000Z',
      created_at: '2024-01-01T00:00:00.000Z',
      valid_until: '2024-06-01T00:00:00.000Z',
    });

    ensureWorldModelStore(db);
    db.prepare(`
      INSERT INTO memory_open_loops (
        loop_id, kind, title, status, priority, related_entity_id, source_memory_ids, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'loop-contradiction',
      'contradiction_review',
      'Conflicting launch positioning needs review',
      'open',
      0.91,
      'entity:gigabrain',
      JSON.stringify(['manual-dup-a', 'manual-dup-b']),
      '{}',
    );

    const passport = buildMemoryPassport({
      db,
      config,
      scope: 'profile:user',
      codexHome,
      claudeHome,
      staleDays: 180,
      limit: 20,
      handoffLimit: 20,
    });

    assert.equal(passport.ok, true, 'passport should build');
    assert.equal(passport.summary.counts.scoped_active >= 5, true, 'passport should count scoped active memories');
    assert.equal(passport.sections.duplicates.some((row) => row.count === 2), true, 'passport should include exact duplicate groups');
    assert.equal(passport.sections.contradictions.length, 1, 'passport should include contradiction review rows');
    assert.equal(passport.sections.stale.some((row) => row.memory_id === 'stale-memory'), true, 'passport should flag stale memories');
    assert.equal(passport.sections.provenance_gaps.some((row) => row.memory_id === 'raw-secret-risk'), true, 'passport should flag provenance gaps');
    assert.equal(passport.sections.secret_risks.some((row) => row.memory_id === 'raw-secret-risk'), true, 'passport should flag raw secret-like memories');
    assert.equal(passport.markdown.includes(rawSecret), false, 'passport markdown must not leak raw secrets');
    assert.equal(passport.html.includes(rawSecret), false, 'passport html must not leak raw secrets');
    assert.equal(passport.readiness.status, 'blocked', 'secret-risk rows should block Passport readiness');
    assert.equal(passport.markdown.includes('## Readiness Verdict'), true, 'passport markdown should include readiness verdict');
    assert.equal(passport.handoffs.chatgpt_manual.brief.includes('does not scrape'), true, 'manual cloud handoff should state boundary');
    assert.equal(passport.handoffs.agents.brief.includes(sharedMemory), true, 'handoff should include useful portable memories');
    assert.equal(passport.handoffs.agents.brief.includes(rawSecret), false, 'handoff must redact secrets');
    assert.equal(passport.handoffs.agents.brief.includes('[REDACTED_SECRET]'), false, 'handoff must omit secret-risk rows entirely');
    assert.equal(passport.handoffs.agents.omitted_secret_risks, 2, 'handoff should report omitted secret-risk rows');

    const limitedPassport = buildMemoryPassport({
      db,
      config,
      scope: 'profile:user',
      codexHome,
      claudeHome,
      staleDays: 180,
      limit: 1,
      handoffLimit: 20,
    });
    assert.equal(limitedPassport.sections.provenance_gaps.length, 1, 'limit should cap provenance audit rows');
    assert.equal(limitedPassport.sections.secret_risks.length, 1, 'limit should cap secret-risk audit rows');

    const outputDir = path.join(temp.outputRoot, 'passport');
    const files = writeMemoryPassport(passport, { outputDir, formats: ['all'] });
    assertFileExists(files.markdown, 'passport markdown');
    assertFileExists(files.html, 'passport html');
    assertFileExists(files.json, 'passport json');
    assertFileExists(files.handoffs.agents, 'AGENTS handoff');
    assertFileExists(files.handoffs.claude_code, 'CLAUDE handoff');
    assertFileExists(files.handoffs.chatgpt_manual, 'ChatGPT handoff');
    assert.equal(fs.readFileSync(files.markdown, 'utf8').includes('## Source Inventory'), true, 'markdown should contain source inventory');
    assert.equal(fs.readFileSync(files.json, 'utf8').includes(rawSecret), false, 'passport json must not leak raw secrets');
  } finally {
    db.close();
  }
};

export { run };
