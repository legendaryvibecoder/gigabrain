import assert from 'node:assert/strict';
import fs from 'node:fs';

import { normalizeConfig } from '../lib/core/config.js';
import { captureFromEvent } from '../lib/core/capture-service.js';
import { getCurrentMemory, listCurrentMemories } from '../lib/core/projection-store.js';
import { parseMemoryActions } from '../lib/core/memory-actions.js';
import { runMaintenance } from '../lib/core/maintenance-service.js';
import { makeConfigObject, makeTempWorkspace, openDb, seedMemoryCurrent } from './helpers.js';

const run = async () => {
  const ws = makeTempWorkspace('gb-v5-memory-actions-');
  const config = normalizeConfig(makeConfigObject(ws.workspace).plugins.entries.gigabrain.config);
  const db = openDb(ws.dbPath);
  try {
    seedMemoryCurrent(db, [
      {
        memory_id: 'old-liz',
        type: 'USER_FACT',
        content: 'Liz lives in Vienna.',
        scope: 'nimbusmain',
        confidence: 0.88,
      },
      {
        memory_id: 'ops-note',
        type: 'CONTEXT',
        content: 'webhook endpoint for nightly deploy check',
        scope: 'shared',
        confidence: 0.34,
      },
    ]);

    const parsed = parseMemoryActions(`
      <memory_action action="replace" target_memory_id="old-liz" type="USER_FACT" scope="nimbusmain">Liz lives in Graz now.</memory_action>
      <memory_note action="protect" target_memory_id="ops-note"></memory_note>
      <memory_action action="do_not_store"></memory_action>
    `);
    assert.equal(parsed.length, 3, 'should parse memory_action and memory_note action tags');
    assert.equal(parsed[0].action, 'replace');
    assert.equal(parsed[1].action, 'protect');
    assert.equal(parsed[2].action, 'do_not_store');

    const replaceResult = captureFromEvent({
      db,
      config,
      event: {
        scope: 'nimbusmain',
        agentId: 'nimbusmain',
        sessionKey: 'sess:nimbusmain',
        text: '<memory_action action="replace" target_memory_id="old-liz" type="USER_FACT" scope="nimbusmain">Liz lives in Graz now.</memory_action>',
        output: '<memory_action action="replace" target_memory_id="old-liz" type="USER_FACT" scope="nimbusmain">Liz lives in Graz now.</memory_action>',
        prompt: '',
        messages: [],
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      runId: 'test-replace',
      reviewVersion: '',
    });
    assert.equal(replaceResult.actions_applied, 1, 'replace action should apply');
    assert.equal(replaceResult.actions_inserted, 1, 'replace action should insert replacement memory');
    assert.equal(replaceResult.actions_superseded, 1, 'replace action should supersede target memory');

    const oldRow = getCurrentMemory(db, 'old-liz');
    assert.equal(oldRow?.status, 'superseded', 'old memory should be superseded after replace');
    const activeRows = listCurrentMemories(db, { statuses: ['active'], scope: 'nimbusmain', limit: 20 });
    const replacement = activeRows.find((row) => String(row.content || '').includes('Graz'));
    assert.equal(Boolean(replacement), true, 'replacement memory should be active');

    const protectResult = captureFromEvent({
      db,
      config,
      event: {
        scope: 'shared',
        agentId: 'shared',
        sessionKey: 'sess:shared',
        text: '<memory_note action="protect" target_memory_id="ops-note"></memory_note>',
        output: '<memory_note action="protect" target_memory_id="ops-note"></memory_note>',
        prompt: '',
        messages: [],
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      runId: 'test-protect',
      reviewVersion: '',
    });
    assert.equal(protectResult.actions_protected, 1, 'protect action should mark the memory as protected');
    const protectedRow = getCurrentMemory(db, 'ops-note');
    assert.equal(Array.isArray(protectedRow?.tags), true);
    assert.equal(protectedRow.tags.includes('protected'), true, 'protected tag should be persisted');

    const blockedResult = captureFromEvent({
      db,
      config,
      event: {
        scope: 'shared',
        agentId: 'shared',
        sessionKey: 'sess:shared',
        text: '<memory_action action="do_not_store"></memory_action><memory_note type="PREFERENCE" confidence="0.9">User prefers oat milk.</memory_note>',
        output: '<memory_action action="do_not_store"></memory_action><memory_note type="PREFERENCE" confidence="0.9">User prefers oat milk.</memory_note>',
        prompt: '',
        messages: [],
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      runId: 'test-do-not-store',
      reviewVersion: '',
    });
    assert.equal(blockedResult.actions_do_not_store, 1, 'do_not_store action should be tracked');
    assert.equal(blockedResult.inserted, 0, 'do_not_store should block normal note capture in the same turn');
    const oatRows = listCurrentMemories(db, { statuses: ['active'], scope: 'shared', limit: 50 });
    assert.equal(oatRows.some((row) => String(row.content || '').includes('oat milk')), false, 'blocked note must not be stored');

    seedMemoryCurrent(db, [
      {
        memory_id: 'liz-oldest',
        type: 'USER_FACT',
        content: 'Liz lives in Vienna.',
        scope: 'nimbusmain',
        confidence: 0.86,
        source_session: 'sess:nimbusmain',
        updated_at: '2026-03-08T08:00:00.000Z',
      },
      {
        memory_id: 'liz-newest',
        type: 'USER_FACT',
        content: 'Liz lives in Vienna.',
        scope: 'nimbusmain',
        confidence: 0.86,
        source_session: 'sess:nimbusmain',
        updated_at: '2026-03-08T08:00:00.000Z',
      },
    ]);
    const ambiguousResult = captureFromEvent({
      db,
      config,
      event: {
        scope: 'nimbusmain',
        agentId: 'nimbusmain',
        sessionKey: 'sess:nimbusmain',
        text: '<memory_action action="forget" target="Liz lives in Vienna"></memory_action>',
        output: '<memory_action action="forget" target="Liz lives in Vienna"></memory_action>',
        prompt: '',
        messages: [],
      },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      runId: 'test-ambiguous-target',
      reviewVersion: '',
    });
    assert.equal(ambiguousResult.actions_queued_review, 1, 'ambiguous target resolution should queue review');
    const queueText = fs.readFileSync(ws.outputRoot + '/memory-review-queue.jsonl', 'utf8');
    assert.equal(queueText.includes('Liz lives in Vienna'), true, 'action review queue entry should be written for ambiguous targets');
  } finally {
    db.close();
  }

  const maintain = runMaintenance({
    dbPath: ws.dbPath,
    config,
    dryRun: false,
    reviewVersion: 'rv-memory-actions',
    runId: 'run-memory-actions',
  });
  assert.equal(maintain.ok, true);

  const verifyDb = openDb(ws.dbPath);
  try {
    const protectedRow = getCurrentMemory(verifyDb, 'ops-note');
    assert.equal(protectedRow?.status, 'active', 'protected row should survive maintenance');
  } finally {
    verifyDb.close();
  }
};

export { run };
