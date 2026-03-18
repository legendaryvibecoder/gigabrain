import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

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

const EMBEDDING_SERVER_SCRIPT = `
  import http from 'node:http';
  const server = http.createServer((req, res) => {
    if (req.url !== '/v1/embeddings' || req.method !== 'POST') {
      res.writeHead(404);
      res.end();
      return;
    }
    let raw = '';
    req.on('data', (chunk) => { raw += String(chunk); });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const input = String(body.input || '').toLowerCase();
      const vector = input.includes('winter') ? [1, 0] : [0.5, 0.5, 0.5];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: vector }] }));
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    process.stdout.write(String(address.port));
  });
`;

const withEmbeddingServer = async (fn) => {
  const child = spawn(process.execPath, ['-e', EMBEDDING_SERVER_SCRIPT], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  let portText = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    portText += chunk;
  });
  await once(child.stdout, 'data');
  const port = Number(portText.trim());
  if (!Number.isFinite(port)) throw new Error(`failed to start embedding server: ${portText}`);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await fn(baseUrl);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
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

  assert.equal(isSafeEmbeddingBaseUrl('http://127.0.0.1:11434'), true, 'http Ollama endpoints should be accepted');
  assert.equal(isSafeEmbeddingBaseUrl('http://localhost:11434/'), true, 'localhost Ollama endpoints should be accepted');
  assert.equal(isSafeEmbeddingBaseUrl('http://[::1]:11434'), true, 'IPv6 loopback Ollama endpoints should be accepted');
  assert.equal(isSafeEmbeddingBaseUrl('https://example.com/ollama'), false, 'remote embedding endpoints must be rejected');
  assert.equal(isSafeEmbeddingBaseUrl('-o/tmp/pwned'), false, 'flag-like base URLs must be rejected');
  assert.equal(isSafeEmbeddingBaseUrl('not-a-url'), false, 'non-URL base values must be rejected');
  assert.equal(
    buildEmbeddingEndpoint('http://127.0.0.1:11434///')?.toString(),
    'http://127.0.0.1:11434/v1/embeddings',
    'embedding endpoint should normalize trailing slashes without regex ambiguity',
  );
  assert.equal(
    buildEmbeddingEndpoint('http://127.0.0.1:11434/ollama/')?.toString(),
    'http://127.0.0.1:11434/ollama/v1/embeddings',
    'embedding endpoint should preserve explicit local path prefixes',
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

  await withEmbeddingServer(async (baseUrl) => {
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
          ollamaUrl: baseUrl,
          embeddingTimeoutMs: 500,
        },
      }, db);

      assert.equal(reranked[0].memory_id, 'candidate-winter', 'semantic rerank should promote the semantically matching candidate');
    } finally {
      db.close();
    }
  });

  await withEmbeddingServer(async (baseUrl) => {
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
          ollamaUrl: baseUrl,
          embeddingTimeoutMs: 500,
        },
      });
      const second = buildMissingEmbeddings(db, {
        recall: {
          semanticRerankEnabled: true,
          ollamaUrl: baseUrl,
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
