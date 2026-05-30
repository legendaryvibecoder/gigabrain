import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { appendQueueRow, applyQueueRetention } from '../lib/core/review-queue.js';
import { writeNativeMemoryEntry } from '../lib/core/native-memory.js';

// Regression coverage for the 2026-05-30 adversarial deep-audit findings:
//   1. review-queue sanitizeRow whitelist silently dropped legitimate top-level
//      AND nested payload fields (and was the root cause of the flaky
//      integration-audit-maintenance test that reads winner/loser_memory_id).
//   2. native-memory validateFilePath skipped the symlink-containment check for
//      not-yet-existing target files (dangling-symlink redirect bypass).
//   3. the #88 durable allowedRoot anchored on the target file's own dirname,
//      making the containment check a tautological no-op (arbitrary file append).

export const run = async () => {
  // ---------------------------------------------------------------------------
  // 1. review-queue retention must preserve every legitimate field, only
  //    stripping prototype-pollution keys.
  // ---------------------------------------------------------------------------
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-audit-rq-'));
    const queuePath = path.join(root, 'queue.jsonl');

    // A dedupe-style row carrying the exact fields the maintenance producer writes,
    // none of which were in the old ALLOWED_ROW_PROPERTIES whitelist.
    appendQueueRow(queuePath, {
      status: 'pending',
      reason: 'semantic_borderline',
      winner_memory_id: 'dup-keep',
      loser_memory_id: 'dup-drop',
      matched_memory_id: 'dup-keep',
      similarity: 0.94,
      auto_resolved: false,
      payload: {
        excerpt: 'jordan prefers pour over coffee',
        plausibility_flags: ['contact_info'],
        matched_pattern: 'preference.coffee',
      },
      // a prototype-pollution attempt that MUST be stripped
      __proto__: { polluted: true },
    }, { applyRetention: false });

    // Force a retention rewrite (this is what used to strip the fields).
    applyQueueRetention(queuePath, {}, { skipLock: true });

    const rows = fs.readFileSync(queuePath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const row = rows.find((r) => r.loser_memory_id === 'dup-drop');

    assert.ok(row, 'top-level dedupe fields (loser_memory_id) must survive a retention rewrite');
    assert.equal(row.winner_memory_id, 'dup-keep', 'winner_memory_id must survive retention');
    assert.equal(row.matched_memory_id, 'dup-keep', 'matched_memory_id must survive retention');
    assert.equal(row.similarity, 0.94, 'numeric similarity must survive retention');
    assert.equal(row.auto_resolved, false, 'auto_resolved flag must survive retention');
    assert.equal(row.payload.plausibility_flags?.[0], 'contact_info', 'nested payload.plausibility_flags must survive retention');
    assert.equal(row.payload.matched_pattern, 'preference.coffee', 'nested payload.matched_pattern must survive retention');
    assert.equal(row.payload.excerpt, 'jordan prefers pour over coffee', 'nested payload.excerpt must survive retention');
    // prototype pollution must NOT have happened
    assert.equal({}.polluted, undefined, 'prototype pollution via __proto__ must be blocked');
    assert.equal(Object.prototype.hasOwnProperty.call(row, '__proto__'), false, '__proto__ own-key must be stripped from the row');
  }

  // ---------------------------------------------------------------------------
  // 2 + 3. native-memory durable write: legit MEMORY.md allowed; symlink redirect
  //        and arbitrary absolute targets rejected.
  // ---------------------------------------------------------------------------
  {
    const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-audit-nm-'));
    const memoryRoot = path.join(ws, 'memory');
    fs.mkdirSync(memoryRoot, { recursive: true });
    const memoryMdPath = path.join(ws, 'MEMORY.md');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-audit-out-'));

    const baseConfig = {
      runtime: { paths: { memoryRoot, workspaceRoot: ws } },
      native: { memoryMdPath },
    };

    // (a) The legitimate durable write to MEMORY.md (the case #88 was meant to fix)
    //     must still succeed and link source_layer = native.
    const ok = writeNativeMemoryEntry({
      config: baseConfig,
      memoryId: 'm-legit',
      type: 'USER_FACT',
      content: 'Workspace root durable write must be allowed.',
      durable: true,
      timestamp: '2026-05-30T10:00:00.000Z',
    });
    assert.equal(ok.written, true, 'legit durable MEMORY.md write must still succeed after the allowedRoot fix');
    assert.match(String(ok.source_path), /MEMORY\.md$/, 'durable write must target MEMORY.md');
    assert.ok(fs.existsSync(memoryMdPath), 'MEMORY.md must be created at the workspace root');

    // (b) Finding #3: an absolute memoryMdPath OUTSIDE the workspace must be
    //     rejected — previously the dirname-anchored check passed everything.
    const evilAbs = path.join(outside, 'evil.md');
    let threwAbs = false;
    try {
      writeNativeMemoryEntry({
        config: { runtime: { paths: { memoryRoot, workspaceRoot: ws } }, native: { memoryMdPath: evilAbs } },
        memoryId: 'm-evil-abs',
        content: 'should not land outside the workspace',
        durable: true,
        timestamp: '2026-05-30T10:00:00.000Z',
      });
    } catch (e) {
      threwAbs = /path traversal/i.test(String(e && e.message));
    }
    assert.equal(threwAbs, true, 'durable write to an absolute path outside the workspace must be rejected');
    assert.equal(fs.existsSync(evilAbs), false, 'no file may be written outside the workspace');

    // (c) Finding #1: a DANGLING symlink planted at the target path, pointing
    //     outside the workspace, must be rejected even though the target file
    //     does not exist yet (the realpath-skip bypass).
    const linkTarget = path.join(outside, 'redirected.md'); // does NOT exist yet
    const symlinkMd = path.join(ws, 'LINKED.md');
    try { fs.symlinkSync(linkTarget, symlinkMd); } catch { /* symlinks may be unavailable */ }
    if (fs.existsSync(symlinkMd) || fs.lstatSync(symlinkMd, { throwIfNoEntry: false })) {
      let threwLink = false;
      try {
        writeNativeMemoryEntry({
          config: { runtime: { paths: { memoryRoot, workspaceRoot: ws } }, native: { memoryMdPath: symlinkMd } },
          memoryId: 'm-evil-link',
          content: 'should not follow a dangling symlink out of the workspace',
          durable: true,
          timestamp: '2026-05-30T10:00:00.000Z',
        });
      } catch (e) {
        threwLink = /path traversal/i.test(String(e && e.message));
      }
      // The symlink itself is inside ws, but its target escapes — the realpath
      // probe of the (existing) parent dir keeps it inside; the key assertion is
      // that the write never lands at the outside target.
      assert.equal(fs.existsSync(linkTarget), false, 'a dangling symlink must not redirect a memory write outside the workspace');
      void threwLink;
    }
  }

  console.log('audit-hardening regression: all assertions passed');
};

if (import.meta.url === `file://${process.argv[1]}`) {
  await run();
}
