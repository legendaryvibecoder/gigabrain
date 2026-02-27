#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TEST_FILES = [
  'unit-config-test.js',
  'unit-policy-test.js',
  'unit-capture-service-test.js',
  'unit-person-service-test.js',
  'unit-llm-router-test.js',
  'unit-native-sync-query-test.js',
  'integration-audit-maintenance-test.js',
  'integration-migration-and-api-test.js',
  'integration-native-recall-test.js',
  'integration-bridge-contract-routes-test.js',
  'regression-memory-behavior-test.js',
  'performance-nightly-test.js',
];

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));

const run = async () => {
  const results = [];
  for (const file of TEST_FILES) {
    const modulePath = pathToFileURL(path.join(root, file)).href;
    const testModule = await import(modulePath);
    if (typeof testModule.run !== 'function') {
      throw new Error(`Test file ${file} does not export run()`);
    }
    const started = Date.now();
    await testModule.run();
    const elapsedMs = Date.now() - started;
    results.push({
      test: file,
      elapsedMs,
    });
  }
  console.log(JSON.stringify({
    ok: true,
    suite: 'gigabrain-v3',
    tests: results,
  }, null, 2));
};

run().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
