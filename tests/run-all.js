#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PUBLIC_TEST_FILES = [
  'integration-remote-mcp-test.js',
  'unit-bitemporal-test.js',
  'unit-bm25-test.js',
  'unit-capture-service-test.js',
  'unit-checkpoint-migration-test.js',
  'unit-claim-promotion-auth-test.js',
  'unit-cloud-inbox-test.js',
  'unit-config-test.js',
  'unit-control-plane-test.js',
  'unit-event-store-test.js',
  'unit-git-wiki-test.js',
  'unit-handoff-pii-redaction-test.js',
  'unit-host-memory-sync-test.js',
  'unit-http-routes-test.js',
  'unit-lifecycle-hooks-test.js',
  'unit-pii-scanner-test.js',
  'unit-plugin-runtime-test.js',
  'unit-policy-test.js',
  'unit-projection-store-test.js',
  'unit-public-mirror-test.js',
  'unit-recall-service-test.js',
  'unit-remote-mcp-auth-test.js',
  'unit-runtime-guard-test.js',
  'unit-safe-boundaries-test.js',
  'unit-sqlite-test.js',
  'unit-standalone-client-test.js',
  'unit-transcript-harvester-test.js',
];

const root = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

const loadFullTestFiles = async () => {
  const inventoryPath = path.join(root, 'full-test-inventory.js');
  if (!fs.existsSync(inventoryPath)) return null;
  const inventory = await import(pathToFileURL(inventoryPath).href);
  if (!Array.isArray(inventory.FULL_TEST_FILES)
      || inventory.FULL_TEST_FILES.some((file) => typeof file !== 'string' || file.length === 0)) {
    throw new Error('Source test inventory is invalid.');
  }
  return inventory.FULL_TEST_FILES;
};

const readFilters = () => {
  const filters = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index] || '');
    if (value === '--filter' && args[index + 1]) {
      filters.push(String(args[index + 1]));
      index += 1;
      continue;
    }
    if (value.startsWith('--filter=')) {
      filters.push(value.split('=').slice(1).join('='));
    }
  }
  return filters
    .flatMap((item) => String(item || '').split(','))
    .map((item) => item.trim())
    .filter(Boolean);
};

const run = async () => {
  const fullTestFiles = await loadFullTestFiles();
  const separatelyRun = new Set([
    'release-live-codex-cli-test.js',
    'release-live-openclaw-install-test.js',
  ]);
  const discovered = fs.readdirSync(root)
    .filter((file) => (
      (file.endsWith('-test.js') || Boolean(fullTestFiles?.includes(file)))
      && !separatelyRun.has(file)
    ))
    .sort();
  const exactInventory = (registered) => {
    const expected = [...registered].sort();
    return expected.length === discovered.length
      && expected.every((file, index) => file === discovered[index]);
  };
  let inventoryMode;
  let testFiles;
  if (fullTestFiles && exactInventory(fullTestFiles)) {
    inventoryMode = 'full';
    testFiles = fullTestFiles;
  } else if (exactInventory(PUBLIC_TEST_FILES)) {
    inventoryMode = 'public';
    testFiles = PUBLIC_TEST_FILES;
  } else {
    const publicSet = new Set(PUBLIC_TEST_FILES);
    const missingFromPublic = PUBLIC_TEST_FILES.filter((file) => !discovered.includes(file));
    const unexpectedForPublic = discovered.filter((file) => !publicSet.has(file));
    const details = [
      'Test inventory matches neither the full nor public suite.',
    ];
    if (fullTestFiles) {
      const fullSet = new Set(fullTestFiles);
      const missingFromFull = fullTestFiles.filter((file) => !discovered.includes(file));
      const unexpectedForFull = discovered.filter((file) => !fullSet.has(file));
      details.push(
        `Full missing: ${missingFromFull.join(', ') || 'none'}`,
        `Full unexpected: ${unexpectedForFull.join(', ') || 'none'}`,
      );
    }
    details.push(
      `Public missing: ${missingFromPublic.join(', ') || 'none'}`,
      `Public unexpected: ${unexpectedForPublic.join(', ') || 'none'}`,
    );
    throw new Error(details.join('\n'));
  }
  if (args.includes('--inventory-only')) {
    fs.writeSync(1, `${JSON.stringify({ ok: true, inventoryMode, tests: testFiles }, null, 2)}\n`);
    return;
  }
  const filters = readFilters();
  const selectedFiles = filters.length === 0
    ? testFiles
    : testFiles.filter((file) => filters.some((filter) => file.includes(filter)));
  if (selectedFiles.length === 0) {
    throw new Error(`No tests matched filter(s): ${filters.join(', ')}`);
  }
  const results = [];
  for (const file of selectedFiles) {
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
  fs.writeSync(1, `${JSON.stringify({
    ok: true,
    suite: 'gigabrain-v3',
    inventoryMode,
    filters,
    tests: results,
  }, null, 2)}\n`);
};

run().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
