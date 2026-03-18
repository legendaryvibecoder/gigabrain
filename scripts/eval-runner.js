#!/usr/bin/env node

/**
 * eval-runner.js -- Run the Gigabrain eval harness.
 *
 * Usage:
 *   node scripts/eval-runner.js --config path/to/config.json [--mode golden|live] [--out report.json]
 *
 * Options:
 *   --config   Path to the OpenClaw/Gigabrain config JSON (required)
 *   --mode     "golden" = create temp DB with golden seed; "live" = use production DB (default: live)
 *   --out      Output file path for the report JSON (default: stdout)
 *   --cases    Path to cases.jsonl (default: eval/cases.jsonl relative to package root)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

import { loadResolvedConfig } from '../lib/core/config.js';
import { openDatabase } from '../lib/core/sqlite.js';
import { ensureProjectionStore } from '../lib/core/projection-store.js';
import { evalRecall, loadEvalCases } from '../lib/core/eval-harness.js';
import { seedGoldenDb } from '../eval/golden-seed.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');

const { values: args } = parseArgs({
  options: {
    config: { type: 'string' },
    mode: { type: 'string', default: 'live' },
    out: { type: 'string', short: 'o' },
    cases: { type: 'string' },
  },
  strict: false,
});

if (!args.config) {
  console.error('Usage: node scripts/eval-runner.js --config path/to/config.json [--mode golden|live] [--out report.json]');
  process.exit(1);
}

const mode = ['golden', 'live'].includes(args.mode) ? args.mode : 'live';

const main = () => {
  const resolved = loadResolvedConfig({ configPath: args.config });
  const config = resolved.config;

  const casesPath = args.cases
    ? path.resolve(args.cases)
    : path.join(PACKAGE_ROOT, 'eval', 'cases.jsonl');

  if (!fs.existsSync(casesPath)) {
    console.error(`Cases file not found: ${casesPath}`);
    process.exit(1);
  }

  const cases = loadEvalCases(casesPath);
  if (cases.length === 0) {
    console.error('No valid eval cases found.');
    process.exit(1);
  }

  let db;
  let dbPath;

  if (mode === 'golden') {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-eval-golden-'));
    dbPath = path.join(tmpDir, 'golden-eval.sqlite');
    db = openDatabase(dbPath);
    ensureProjectionStore(db);

    const seedResult = seedGoldenDb(db);
    console.error(`[eval-runner] Golden seed: ${seedResult.seeded} memories, entities_rebuilt=${seedResult.entities_rebuilt}`);
  } else {
    const workspaceRoot = String(
      config?.runtime?.paths?.workspaceRoot
      || config?.paths?.workspaceRoot
      || '',
    ).trim();
    const memoryRoot = String(
      config?.runtime?.paths?.memoryRoot
      || config?.paths?.memoryRoot
      || 'memory',
    ).trim();

    const memoryDir = path.isAbsolute(memoryRoot)
      ? memoryRoot
      : path.join(workspaceRoot, memoryRoot);

    dbPath = path.join(memoryDir, 'registry.sqlite');
    if (!fs.existsSync(dbPath)) {
      console.error(`Database not found at: ${dbPath}`);
      process.exit(1);
    }
    db = openDatabase(dbPath);
  }

  try {
    console.error(`[eval-runner] Running ${cases.length} cases in mode=${mode} against ${dbPath}`);
    const report = evalRecall({ db, config, cases, mode });

    const output = JSON.stringify(report, null, 2);
    if (args.out) {
      const outPath = path.resolve(args.out);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, output, 'utf8');
      console.error(`[eval-runner] Report written to: ${outPath}`);
      console.error(
        `[eval-runner] Summary: ${report.aggregate.evaluated_case_count}/${report.aggregate.case_count} cases, `
        + `hit_rate=${report.aggregate.hit_rate}, mrr=${report.aggregate.mrr}, p@1=${report.aggregate.precision_at_1}`,
      );
    } else {
      console.log(output);
    }
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
};

main();
