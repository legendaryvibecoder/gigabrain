import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeConfig } from '../lib/core/config.js';
import { runMaintenance } from '../lib/core/maintenance-service.js';
import { recallForQuery } from '../lib/core/recall-service.js';
import { makeTempWorkspace, makeConfigObject, openDb } from './helpers.js';

const run = async () => {
  const ws = makeTempWorkspace('gb-v3-int-native-recall-');
  const memoryDir = path.join(ws.workspace, 'memory');
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(ws.workspace, 'MEMORY.md'), `
# MEMORY

## Relationship

- Riley is Jordan partner and they live together.
`, 'utf8');
  fs.writeFileSync(path.join(memoryDir, '2026-01-15.md'), `
# 2026-01-15

## 08:00 UTC

### CONTEXT
- [m:abc12345-aaaa-bbbb-cccc-1234567890ab] In January 2026, Jordan and Atlas worked on gigabrain architecture.
`, 'utf8');
  fs.writeFileSync(path.join(memoryDir, 'whois.md'), `
# whois

- Riley is Jordan partner and has birthday on Nov 6.
`, 'utf8');

  const config = normalizeConfig(makeConfigObject(ws.workspace).plugins.entries.gigabrain.config);
  const maintain = runMaintenance({
    dbPath: ws.dbPath,
    config,
    dryRun: false,
    runId: 'run-native-recall-maint',
    reviewVersion: 'rv-native-recall-maint',
  });
  assert.equal(maintain.ok, true);

  const db = openDb(ws.dbPath);
  try {
    const jan = recallForQuery({
      db,
      config,
      query: 'What happened in January 2026 with gigabrain?',
      scope: 'main',
    });
    assert.equal(jan.results.length >= 1, true, 'temporal query should return at least one result');
    const hasJanuaryNative = jan.results.some((row) =>
      String(row._source || '') === 'native'
      && String(row.source_date || '').startsWith('2026-01'),
    );
    assert.equal(hasJanuaryNative, true, 'temporal recall should pull January native chunk');

    const shared = recallForQuery({
      db,
      config,
      query: 'wer ist riley?',
      scope: 'shared',
    });
    const leaksMemoryMd = shared.results.some((row) => String(row.source_kind || '') === 'memory_md');
    assert.equal(leaksMemoryMd, false, 'shared recall must not pull private MEMORY.md chunks');
  } finally {
    db.close();
  }
};

export { run };
