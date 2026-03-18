import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { ensureProjectionStore } from '../lib/core/projection-store.js';
import {
  buildEmbeddingEndpoint,
  buildMissingEmbeddings,
  ensureEmbeddingStore,
  semanticRerank,
  storeEmbedding,
  getEmbeddingSync,
  isSafeEmbeddingBaseUrl,
} from '../lib/core/embedding-service.js';
import { makeTempWorkspace, openDb, seedMemoryCurrent } from './helpers.js';

const FAKE_CURL_SCRIPT = `#!/usr/bin/env node
const args = process.argv.slice(2);
const bodyIdx = args.indexOf('-d');
const raw = bodyIdx !== -1 ? String(args[bodyIdx + 1] || '{}') : '{}';
const body = JSON.parse(raw);
const input = String(body.input || '').toLowerCase();
const vector = input.includes('winter') ? [1, 0] : [0.5, 0.5, 0.5];
process.stdout.write(JSON.stringify({ data: [{ embedding: vector }] }));
`;

const withFakeCurl = async (fn) => {
  const ws = makeTempWorkspace('gb-v6-embedding-curl-');
  const binDir = path.join(ws.root, 'bin');
  const curlPath = path.join(binDir, 'curl');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(curlPath, FAKE_CURL_SCRIPT, 'utf8');
  fs.chmodSync(curlPath, 0o755);
  const previousPath = process.env.PATH || '';
  process.env.PATH = `${binDir}:${previousPath}`;
  try {
    await fn();
  } finally {
    process.env.PATH = previousPath;
  }
};

const run = async () => {
  const disabledCandidates = [
    { memory_id: 'a', content: 'winter preference', _score: 0.4 },
    { memory_id: 'b', content: 'deploy checklist', _score: 0.9 },
  ];
  assert.equal(
    semanticRerank(disabledCandidates, 'winter', { recall: { semanticRerankEnabled: false } }),
    disabledCandidates,
    'semantic rerank should be a no-op when disabled',
  );

  assert.equal(isSafeEmbeddingBaseUrl('http://127.0.0.1:11434'), true, 'default loopback Ollama endpoint should be accepted');
  assert.equal(isSafeEmbeddingBaseUrl('http://localhost:11434/'), true, 'localhost alias on the default Ollama port should be accepted');
  assert.equal(isSafeEmbeddingBaseUrl('http://[::1]:11434'), true, 'IPv6 loopback alias on the default Ollama port should be accepted');
  assert.equal(isSafeEmbeddingBaseUrl('http://127.0.0.1:9999'), false, 'non-default local ports must be rejected');
  assert.equal(isSafeEmbeddingBaseUrl('https://example.com/ollama'), false, 'remote embedding endpoints must be rejected');
  assert.equal(isSafeEmbeddingBaseUrl('-o/tmp/pwned'), false, 'flag-like base URLs must be rejected');
  assert.equal(isSafeEmbeddingBaseUrl('not-a-url'), false, 'non-URL base values must be rejected');
  assert.equal(
    buildEmbeddingEndpoint('http://127.0.0.1:11434///')?.toString(),
    'http://127.0.0.1:11434/v1/embeddings',
    'embedding endpoint should normalize to the fixed local Ollama route',
  );
  assert.equal(
    buildEmbeddingEndpoint('http://127.0.0.1:11434/ollama/')?.toString(),
    'http://127.0.0.1:11434/v1/embeddings',
    'embedding endpoint should ignore custom paths and use the fixed Ollama route',
  );
  assert.equal(
    getEmbeddingSync('winter', { baseUrl: '-o/tmp/pwned', timeoutMs: 100 }),
    null,
    'sync embedding fetch must fail closed on unsafe base URLs before invoking curl',
  );
  assert.equal(
    getEmbeddingSync('winter', { baseUrl: 'https://example.com/ollama', timeoutMs: 100 }),
    null,
    'sync embedding fetch must fail closed on non-local embedding endpoints',
  );

  const missingOllamaCandidates = [
    { memory_id: 'a', content: 'winter preference', _score: 0.4 },
    { memory_id: 'b', content: 'deploy checklist', _score: 0.9 },
  ];
  assert.equal(
    semanticRerank(missingOllamaCandidates, 'winter', {
      recall: {
        semanticRerankEnabled: true,
        ollamaUrl: 'http://127.0.0.1:9',
        embeddingTimeoutMs: 100,
      },
    }),
    missingOllamaCandidates,
    'semantic rerank should gracefully fall back when Ollama is unavailable',
  );

  await withFakeCurl(async () => {
    const ws = makeTempWorkspace('gb-v6-embedding-');
    const db = openDb(ws.dbPath);
    try {
      ensureProjectionStore(db);
      ensureEmbeddingStore(db);

      storeEmbedding(db, {
        memoryId: 'candidate-winter',
        embedding: [1, 0],
      });
      storeEmbedding(db, {
        memoryId: 'candidate-deploy',
        embedding: [0.5, 0.5, 0.5],
      });

      const reranked = semanticRerank([
        { memory_id: 'candidate-deploy', content: 'Deploy the release checklist.', _score: 0.92 },
        { memory_id: 'candidate-winter', content: 'Jordan prefers winter.', _score: 0.35 },
      ], 'winter preference', {
        recall: {
          semanticRerankEnabled: true,
          semanticRerankAlpha: 0.2,
          ollamaUrl: 'http://127.0.0.1:11434',
          embeddingTimeoutMs: 500,
        },
      }, db);

      assert.equal(reranked[0].memory_id, 'candidate-winter', 'semantic rerank should promote the semantically matching candidate');

      const partialCache = semanticRerank([
        { memory_id: 'uncached-strong', content: 'Deploy checklist for the release.', _score: 10 },
        { memory_id: 'candidate-winter', content: 'Jordan prefers winter.', _score: 6 },
      ], 'winter preference', {
        recall: {
          semanticRerankEnabled: true,
          semanticRerankAlpha: 0.7,
          ollamaUrl: 'http://127.0.0.1:11434',
          embeddingTimeoutMs: 500,
        },
      }, db);

      assert.equal(
        partialCache[0].memory_id,
        'uncached-strong',
        'partial semantic rerank should leave uncached rows on their original BM25 scale instead of demoting them below cached rows',
      );
    } finally {
      db.close();
    }
  });

  await withFakeCurl(async () => {
    const ws = makeTempWorkspace('gb-v6-embedding-nightly-');
    const db = openDb(ws.dbPath);
    try {
      seedMemoryCurrent(db, [
        {
          memory_id: 'embed-1',
          type: 'CONTEXT',
          content: 'Jordan prefers direct release notes.',
          scope: 'shared',
          confidence: 0.8,
        },
        {
          memory_id: 'embed-2',
          type: 'DECISION',
          content: 'Claude Desktop uses the same shared standalone store.',
          scope: 'shared',
          confidence: 0.82,
        },
      ]);
      const first = buildMissingEmbeddings(db, {
        recall: {
          semanticRerankEnabled: true,
          ollamaUrl: 'http://127.0.0.1:11434',
          embeddingTimeoutMs: 500,
        },
      });
      const second = buildMissingEmbeddings(db, {
        recall: {
          semanticRerankEnabled: true,
          ollamaUrl: 'http://127.0.0.1:11434',
          embeddingTimeoutMs: 500,
        },
      });
      const stored = db.prepare('SELECT COUNT(*) AS c FROM memory_embeddings').get()?.c || 0;

      assert.equal(first.enabled, true, 'nightly embedding build should report the feature as enabled');
      assert.equal(Number(first.computed || 0) >= 2, true, 'nightly embedding build should compute embeddings for uncached active memories');
      assert.equal(Number(second.computed || 0), 0, 'nightly embedding build should be incremental once rows are cached');
      assert.equal(Number(stored), 2, 'nightly embedding build should persist embeddings in memory_embeddings');
    } finally {
      db.close();
    }
  });
};

export { run };
