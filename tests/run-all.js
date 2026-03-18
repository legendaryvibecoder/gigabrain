#!/usr/bin/env node
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TEST_FILES = [
  'unit-config-test.js',
  'unit-policy-test.js',
  'unit-standalone-client-test.js',
  'unit-bm25-test.js',
  'unit-eval-harness-test.js',
  'unit-projection-store-test.js',
  'unit-capture-service-test.js',
  'unit-recall-service-test.js',
  'unit-memory-actions-test.js',
  'unit-native-promotion-test.js',
  'unit-person-service-test.js',
  'unit-world-model-test.js',
  'unit-orchestrator-test.js',
  'unit-plugin-runtime-test.js',
  'unit-sqlite-test.js',
  'unit-runtime-guard-test.js',
  'unit-llm-router-test.js',
  'unit-review-queue-test.js',
  'unit-http-routes-test.js',
  'unit-embedding-service-test.js',
  'unit-native-sync-query-test.js',
  'unit-codex-service-test.js',
  'unit-vault-mirror-test.js',
  'unit-memory-studio-test.js',
  'integration-audit-maintenance-test.js',
  'integration-eval-tools-test.js',
  'integration-nightly-cli-test.js',
  'integration-setup-first-run-test.js',
  'integration-codex-setup-test.js',
  'integration-claude-setup-test.js',
  'integration-standalone-path-resolution-test.js',
  'integration-packaged-codex-setup-test.js',
  'integration-packaged-claude-setup-test.js',
  'integration-claude-desktop-bundle-test.js',
  'integration-vault-cli-test.js',
  'integration-migration-and-api-test.js',
  'integration-memory-api-security-test.js',
  'integration-native-recall-test.js',
  'integration-openclaw-hooks-test.js',
  'integration-bridge-contract-routes-test.js',
  'integration-codex-mcp-test.js',
  'regression-memory-behavior-test.js',
  'performance-nightly-test.js',
];

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname));
const args = process.argv.slice(2);

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
  const filters = readFilters();
  const selectedFiles = filters.length === 0
    ? TEST_FILES
    : TEST_FILES.filter((file) => filters.some((filter) => file.includes(filter)));
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
  console.log(JSON.stringify({
    ok: true,
    suite: 'gigabrain-v3',
    filters,
    tests: results,
  }, null, 2));
};

run().catch((err) => {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
});
