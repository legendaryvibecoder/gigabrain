import assert from 'node:assert/strict';

import { normalizeConfig } from '../lib/core/config.js';
import { runMaintenance } from '../lib/core/maintenance-service.js';
import { runAudit } from '../lib/core/audit-service.js';
import { makeTempWorkspace, makeConfigObject, openDb, seedMemoryCurrent } from './helpers.js';

const buildFixtureRows = (count = 1400) => {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push({
      memory_id: `perf-${i}`,
      type: i % 7 === 0 ? 'PREFERENCE' : i % 5 === 0 ? 'DECISION' : 'CONTEXT',
      content: i % 37 === 0
        ? '<working_memory>temporary wrapper</working_memory>'
        : `Project note ${i}: system behavior and user preference pattern ${(i % 12) + 1}`,
      scope: i % 4 === 0 ? 'main' : 'shared',
      confidence: 0.45 + ((i % 40) / 100),
    });
  }
  return rows;
};

const run = async () => {
  const ws = makeTempWorkspace('gb-v3-perf-');
  const config = normalizeConfig(makeConfigObject(ws.workspace).plugins.entries.gigabrain.config);
  const db = openDb(ws.dbPath);
  try {
    seedMemoryCurrent(db, buildFixtureRows(1600));
  } finally {
    db.close();
  }

  const beforeHeap = process.memoryUsage().heapUsed;
  const startedAt = Date.now();
  const maintenance = runMaintenance({
    dbPath: ws.dbPath,
    config,
    dryRun: false,
    runId: 'run-perf-maint',
    reviewVersion: 'rv-perf-maint',
  });
  assert.equal(maintenance.ok, true);
  const audit = await runAudit({
    dbPath: ws.dbPath,
    config,
    mode: 'shadow',
    runId: 'run-perf-audit',
    reviewVersion: 'rv-perf-audit',
    llm: { enabled: false, provider: 'none' },
  });
  assert.equal(audit.ok, true);
  const elapsedMs = Date.now() - startedAt;
  const afterHeap = process.memoryUsage().heapUsed;
  const heapDeltaMb = (afterHeap - beforeHeap) / (1024 * 1024);

  // Target is intentionally conservative for CI/dev laptops.
  assert.equal(elapsedMs < 20000, true, `nightly path exceeded performance target: ${elapsedMs}ms`);
  assert.equal(heapDeltaMb < 300, true, `heap growth too high: ${heapDeltaMb.toFixed(2)}MB`);
};

export { run };
