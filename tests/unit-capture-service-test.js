import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeConfig } from '../lib/core/config.js';
import { parseMemoryNotes, captureFromEvent } from '../lib/core/capture-service.js';
import { makeTempWorkspace, makeConfigObject, openDb } from './helpers.js';

const run = async () => {
  const notes = parseMemoryNotes(`
<memory_note type="FACT" confidence="0.93">Riley ist Jordan Partner.</memory_note>
<memory_note type="USERFACT" confidence="high">Jordan likes mozzarella.</memory_note>
  `);
  assert.equal(notes.length, 2);
  assert.equal(notes[0].type, 'USER_FACT', 'FACT alias must map to USER_FACT');
  assert.equal(Number(notes[0].confidence || 0).toFixed(2), '0.93', 'numeric confidence must be parsed');
  assert.equal(notes[1].type, 'USER_FACT', 'USERFACT alias must map to USER_FACT');
  assert.equal(Number(notes[1].confidence || 0).toFixed(2), '0.90', 'symbolic confidence must be parsed');

  const ws = makeTempWorkspace('gb-v3-unit-capture-');
  const config = normalizeConfig(makeConfigObject(ws.workspace).plugins.entries.gigabrain.config);
  const db = openDb(ws.dbPath);
  try {
    const summary = captureFromEvent({
      db,
      config,
      event: {
        scope: 'nimbusmain',
        agentId: 'main',
        sessionKey: 'agent:main:main',
        messages: [{ role: 'user', content: 'remember that Riley is Jordan partner.' }],
        text: '<memory_note type="FACT" confidence="0.88">Riley is Jordan partner.</memory_note>',
      },
      runId: 'capture-unit-run',
      reviewVersion: 'rv-capture-unit',
      logger: { info: () => {} },
    });
    assert.equal(summary.inserted, 1);
    const row = db.prepare(`
      SELECT type, content, confidence, source_layer, source_path, source_line
      FROM memory_current
      WHERE content LIKE '%Riley is Jordan partner.%'
      LIMIT 1
    `).get();
    assert.equal(String(row?.type || ''), 'USER_FACT');
    assert.equal(Number(row?.confidence || 0).toFixed(2), '0.88', 'captured confidence should respect note attribute');
    assert.equal(String(row?.source_layer || ''), 'native', 'explicit remember should link registry memory back to native markdown');
    assert.match(String(row?.source_path || ''), /MEMORY\.md$/, 'durable explicit remember in private scope should write to MEMORY.md');
    assert.equal(Number(row?.source_line || 0) > 0, true, 'native source line should be recorded');
    const memoryMd = fs.readFileSync(path.join(ws.workspace, 'MEMORY.md'), 'utf8');
    assert.match(memoryMd, /\[m:[0-9a-f-]{8,}\] Riley is Jordan partner\./i, 'MEMORY.md should contain linked dual-write entry');

    const sharedDurable = captureFromEvent({
      db,
      config,
      event: {
        scope: 'shared',
        agentId: 'main',
        sessionKey: 'agent:main:group',
        messages: [{ role: 'user', content: 'remember that Jordan prefers peppermint tea.' }],
        text: '<memory_note type="PREFERENCE" confidence="0.9">Jordan prefers peppermint tea.</memory_note>',
      },
      runId: 'capture-unit-run',
      reviewVersion: 'rv-capture-unit',
      logger: { info: () => {} },
    });
    assert.equal(sharedDurable.inserted, 1, 'shared durable remember should still enter the registry');
    const sharedRow = db.prepare(`
      SELECT source_path, source_line
      FROM memory_current
      WHERE content = 'Jordan prefers peppermint tea.'
      LIMIT 1
    `).get();
    assert.match(String(sharedRow?.source_path || ''), /memory\/\d{4}-\d{2}-\d{2}\.md$/, 'shared durable remember should stay in the daily note instead of MEMORY.md');
    assert.equal(Number(sharedRow?.source_line || 0) > 0, true, 'shared durable remember should still record native provenance');

    const noisy = captureFromEvent({
      db,
      config,
      event: {
        scope: 'shared',
        agentId: 'main',
        sessionKey: 'agent:main:main',
        text: '<memory_note type="USER_FACT" confidence="0.5">User started a jabber on the 11th at 90kg</memory_note>',
      },
      runId: 'capture-unit-run',
      reviewVersion: 'rv-capture-unit',
      logger: { info: () => {} },
    });
    assert.equal(noisy.queued_review, 1, 'malformed low-confidence facts should be queued for review');
    const queued = db.prepare(`
      SELECT COUNT(*) AS c
      FROM memory_current
      WHERE content LIKE '%jabber%'
    `).get();
    assert.equal(Number(queued?.c || 0), 0, 'malformed low-confidence fact should not be inserted as active memory');

    const nativeOnly = captureFromEvent({
      db,
      config,
      event: {
        scope: 'shared',
        agentId: 'main',
        sessionKey: 'agent:main:main',
        messages: [{ role: 'user', content: 'remember that I am travelling today and tired.' }],
        text: '<memory_note type="CONTEXT" confidence="0.84">User is travelling today and tired.</memory_note>',
      },
      runId: 'capture-unit-run',
      reviewVersion: 'rv-capture-unit',
      logger: { info: () => {} },
    });
    assert.equal(nativeOnly.inserted, 0, 'ephemeral remember intent should stay out of the durable registry');
    assert.equal(nativeOnly.native_only, 1, 'ephemeral remember intent should still write a native note');
    const dailyPath = path.join(ws.memoryRoot, `${new Date().toISOString().slice(0, 10)}.md`);
    assert.equal(fs.existsSync(dailyPath), true, "ephemeral remember intent should create today's daily note");
    const dailyBody = fs.readFileSync(dailyPath, 'utf8');
    assert.match(dailyBody, /User is travelling today and tired\./, 'daily note should contain the remembered ephemeral context');

    const missingNote = captureFromEvent({
      db,
      config,
      event: {
        scope: 'shared',
        agentId: 'main',
        sessionKey: 'agent:main:main',
        messages: [{ role: 'user', content: 'remember that I prefer herbal tea.' }],
        text: 'Okay, I will remember that.',
      },
      runId: 'capture-unit-run',
      reviewVersion: 'rv-capture-unit',
      logger: { info: () => {}, warn: () => {} },
    });
    assert.equal(missingNote.queued_review, 1, 'explicit remember without an internal memory note should be queued instead of being silently lost');
    const queuePath = path.join(ws.outputRoot, 'memory-review-queue.jsonl');
    assert.equal(fs.existsSync(queuePath), true, 'missing remember note should create a review queue row');
    const queueText = fs.readFileSync(queuePath, 'utf8');
    assert.match(queueText, /remember_intent_missing_note/, 'review queue should record the explicit remember failure reason');

    // Phase 0A: Thinking block contamination must be stripped before parsing
    const thinkingContaminated = parseMemoryNotes(`
<thinking>I should store a memory about the user's pet.</thinking>
<memory_note type="USER_FACT" confidence="0.9">User has a cat named Whiskers.</memory_note>
    `);
    assert.equal(thinkingContaminated.length, 1, 'thinking blocks must be stripped — note should still be parsed');
    assert.equal(thinkingContaminated[0].content, 'User has a cat named Whiskers.');

    const antlrThinking = parseMemoryNotes(`
<antlr:thinking>Let me consider what to store...</antlr:thinking>
<memory_note type="PREFERENCE" confidence="high">User prefers dark mode.</memory_note>
    `);
    assert.equal(antlrThinking.length, 1, 'antlr:thinking blocks must also be stripped');
    assert.equal(antlrThinking[0].content, 'User prefers dark mode.');

    const nestedThinkingNotes = parseMemoryNotes(`
<thinking>
The user mentioned something important.
<memory_note type="USER_FACT" confidence="0.8">Nested inside thinking — should be stripped.</memory_note>
</thinking>
<memory_note type="USER_FACT" confidence="0.85">Outside thinking — should be captured.</memory_note>
    `);
    assert.equal(nestedThinkingNotes.length, 1, 'memory_notes nested inside thinking blocks must be discarded');
    assert.match(nestedThinkingNotes[0].content, /Outside thinking/, 'only non-thinking memory_notes should survive');
  } finally {
    db.close();
  }
};

export { run };
