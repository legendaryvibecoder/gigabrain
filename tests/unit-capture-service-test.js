import assert from 'node:assert/strict';

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
        scope: 'shared',
        agentId: 'main',
        sessionKey: 'agent:main:main',
        text: '<memory_note type="FACT" confidence="0.88">Riley is Jordan partner.</memory_note>',
      },
      runId: 'capture-unit-run',
      reviewVersion: 'rv-capture-unit',
      logger: { info: () => {} },
    });
    assert.equal(summary.inserted, 1);
    const row = db.prepare(`
      SELECT type, content, confidence
      FROM memory_current
      WHERE content LIKE '%Riley is Jordan partner.%'
      LIMIT 1
    `).get();
    assert.equal(String(row?.type || ''), 'USER_FACT');
    assert.equal(Number(row?.confidence || 0).toFixed(2), '0.88', 'captured confidence should respect note attribute');
  } finally {
    db.close();
  }
};

export { run };
