/**
 * Semantic reranking service via BGE-M3 embeddings through Ollama's
 * OpenAI-compatible API.  Designed as a reranker over BM25 lexical
 * candidates -- NOT a full-corpus cosine scan.
 *
 * Architecture:
 *  1. BM25 retrieves top-30 candidates (lexical)
 *  2. This service reranks by cosine similarity to query
 *  3. Final score: alpha * bm25 + (1-alpha) * cosine
 *
 * Gated by config:  recall.semanticRerankEnabled  (default: false)
 * Graceful fallback: if Ollama is unreachable, candidates pass through unchanged.
 */

import { execFileSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
const DEFAULT_MODEL = 'bge-m3';
const DEFAULT_DIMS = 1024;
const DEFAULT_ALPHA = 0.7;
const DEFAULT_TIMEOUT_MS = 5000;
const NIGHTLY_BATCH_SIZE = 50;
const DEFAULT_OLLAMA_PORT = '11434';
const DEFAULT_EMBEDDING_ENDPOINT = `http://127.0.0.1:${DEFAULT_OLLAMA_PORT}/v1/embeddings`;

const normalizeLoopbackHostname = (value = '') => {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[') && raw.endsWith(']')) return raw.slice(1, -1);
  return raw;
};

const isAllowedEmbeddingHost = (hostname = '') => {
  const normalized = normalizeLoopbackHostname(hostname);
  return normalized === '127.0.0.1'
    || normalized === 'localhost'
    || normalized === '::1';
};

const buildEmbeddingEndpoint = (value = '') => {
  const trimmed = String(value || '').trim();
  if (!trimmed || trimmed.startsWith('-')) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:') return null;
    if (!isAllowedEmbeddingHost(parsed.hostname)) return null;
    if (parsed.username || parsed.password) return null;
    if (parsed.search || parsed.hash) return null;
    if (parsed.port && parsed.port !== DEFAULT_OLLAMA_PORT) return null;
    return new URL(DEFAULT_EMBEDDING_ENDPOINT);
  } catch {
    return null;
  }
};

const isSafeEmbeddingBaseUrl = (value = '') => {
  return buildEmbeddingEndpoint(value) !== null;
};

// ---------------------------------------------------------------------------
// Embedding helpers
// ---------------------------------------------------------------------------

/**
 * Fetch an embedding vector from Ollama (async, uses global fetch).
 * @param {string} text
 * @param {{ baseUrl?: string, model?: string, timeoutMs?: number }} opts
 * @returns {Promise<number[] | null>}
 */
const getEmbedding = async (text, opts = {}) => {
  const baseUrl = opts.baseUrl || DEFAULT_OLLAMA_URL;
  const model = opts.model || DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  if (!isSafeEmbeddingBaseUrl(baseUrl)) return null;
  const endpoint = new URL(DEFAULT_EMBEDDING_ENDPOINT);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: text }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const json = await res.json();
    return json?.data?.[0]?.embedding || null;
  } catch {
    return null;
  }
};

/**
 * Synchronous embedding fetch via curl (for recall-time hot path).
 * Falls back to null on any error so callers degrade gracefully.
 * @param {string} text
 * @param {{ baseUrl?: string, model?: string, timeoutMs?: number }} opts
 * @returns {number[] | null}
 */
const getEmbeddingSync = (text, opts = {}) => {
  const baseUrl = opts.baseUrl || DEFAULT_OLLAMA_URL;
  const model = opts.model || DEFAULT_MODEL;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  if (!isSafeEmbeddingBaseUrl(baseUrl)) return null;
  const endpoint = new URL(DEFAULT_EMBEDDING_ENDPOINT);

  try {
    const body = JSON.stringify({ model, input: text });
    const result = execFileSync('curl', [
      '-s',
      '--max-time', String(Math.ceil(timeoutMs / 1000)),
      '-X', 'POST',
      '-H', 'Content-Type: application/json',
      '-d', body,
      '--',
      endpoint.toString(),
    ], { encoding: 'utf8', timeout: timeoutMs + 2000 });
    const parsed = JSON.parse(result);
    return parsed?.data?.[0]?.embedding || null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------------

/**
 * Cosine similarity between two equal-length numeric vectors.
 * Returns 0 on degenerate input.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number}
 */
const cosineSimilarity = (a, b) => {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
};

// ---------------------------------------------------------------------------
// SQLite persistence (Float32Array <-> Buffer)
// ---------------------------------------------------------------------------

/**
 * Ensure the memory_embeddings table exists (additive migration).
 * @param {import('node:sqlite').DatabaseSync} db
 */
const ensureEmbeddingStore = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id   TEXT PRIMARY KEY,
      model       TEXT NOT NULL DEFAULT 'bge-m3',
      embedding   BLOB NOT NULL,
      dims        INTEGER NOT NULL DEFAULT ${DEFAULT_DIMS},
      computed_at TEXT NOT NULL
    )
  `);
};

/**
 * Serialize a float array to a Buffer suitable for SQLite BLOB storage.
 * @param {number[]} vec
 * @returns {Buffer}
 */
const vecToBlob = (vec) => {
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
};

/**
 * Deserialize a Buffer/Uint8Array from SQLite back to a float array.
 * @param {Buffer | Uint8Array} buf
 * @returns {number[]}
 */
const blobToVec = (buf) => {
  const bytes = buf instanceof Uint8Array ? buf : Buffer.from(buf);
  const f32 = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  return Array.from(f32);
};

/**
 * Store an embedding for a memory in the DB.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ memoryId: string, model?: string, embedding: number[], dims?: number }} params
 */
const storeEmbedding = (db, { memoryId, model, embedding, dims }) => {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO memory_embeddings (memory_id, model, embedding, dims, computed_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(
    memoryId,
    model || DEFAULT_MODEL,
    vecToBlob(embedding),
    dims || embedding.length,
    new Date().toISOString(),
  );
};

/**
 * Retrieve a stored embedding for a memory.
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} memoryId
 * @returns {{ embedding: number[], model: string, dims: number, computed_at: string } | null}
 */
const getStoredEmbedding = (db, memoryId) => {
  const stmt = db.prepare(
    'SELECT model, embedding, dims, computed_at FROM memory_embeddings WHERE memory_id = ?',
  );
  const row = stmt.get(memoryId);
  if (!row) return null;
  return {
    embedding: blobToVec(row.embedding),
    model: row.model,
    dims: row.dims,
    computed_at: row.computed_at,
  };
};

// ---------------------------------------------------------------------------
// Semantic reranking (recall-time)
// ---------------------------------------------------------------------------

/**
 * Rerank BM25 candidates using semantic (cosine) similarity.
 *
 * Reads cached embeddings from DB for each candidate. Computes the query
 * embedding on-the-fly (sync via curl). Blends scores:
 *   final = alpha * bm25_norm + (1 - alpha) * cosine
 *
 * If the feature is disabled, Ollama is unreachable, or the query embedding
 * cannot be obtained, the original candidates are returned unchanged.
 *
 * @param {Array<{ memory_id: string, content: string, _score: number }>} candidates
 * @param {string} query
 * @param {object} config  Resolved gigabrain config (or partial)
 * @param {import('node:sqlite').DatabaseSync} [db]  Optional DB handle for cached embeddings
 * @returns {Array<{ memory_id: string, content: string, _score: number, _semantic_score?: number, _bm25_score?: number, _bm25_norm?: number }>}
 */
const semanticRerank = (candidates, query, config = {}, db = null) => {
  const recall = config.recall || {};
  if (!recall.semanticRerankEnabled) return candidates;
  if (!candidates || candidates.length === 0) return candidates;

  const alpha = typeof recall.semanticRerankAlpha === 'number'
    ? recall.semanticRerankAlpha
    : DEFAULT_ALPHA;
  const ollamaUrl = recall.ollamaUrl || DEFAULT_OLLAMA_URL;
  const model = recall.embeddingModel || DEFAULT_MODEL;
  const timeoutMs = recall.embeddingTimeoutMs || DEFAULT_TIMEOUT_MS;

  // Compute query embedding synchronously
  const queryVec = getEmbeddingSync(query, { baseUrl: ollamaUrl, model, timeoutMs });
  if (!queryVec) return candidates;

  // Normalize BM25 scores to [0,1] for blending
  let maxBm25 = 0;
  for (const c of candidates) {
    if (c._score > maxBm25) maxBm25 = c._score;
  }
  if (maxBm25 === 0) maxBm25 = 1;

  const results = candidates.map((candidate) => {
    let candidateVec = null;

    // Try cached embedding from DB first
    if (db && candidate.memory_id) {
      try {
        const stored = getStoredEmbedding(db, candidate.memory_id);
        if (stored) candidateVec = stored.embedding;
      } catch {
        // DB read failed -- skip semantic score for this candidate
      }
    }

    const bm25Norm = candidate._score / maxBm25;

    if (!candidateVec) {
      return {
        ...candidate,
        _bm25_score: candidate._score,
        _bm25_norm: bm25Norm,
        _score: candidate._score,
        _semantic_score: null,
      };
    }

    const cosine = cosineSimilarity(queryVec, candidateVec);
    const blended = alpha * bm25Norm + (1 - alpha) * cosine;
    return {
      ...candidate,
      _bm25_score: candidate._score,
      _bm25_norm: bm25Norm,
      _score: blended * maxBm25,
      _semantic_score: cosine,
    };
  });

  // Re-sort by blended score descending
  results.sort((a, b) => b._score - a._score);
  return results;
};

// ---------------------------------------------------------------------------
// Nightly batch: build missing embeddings
// ---------------------------------------------------------------------------

/**
 * Compute and store embeddings for active memories that don't have one yet.
 * Intended to run in the nightly maintenance pipeline.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [config]  Resolved gigabrain config (or partial)
 * @returns {{ enabled: boolean, computed: number, skipped: number, failed: number }}
 */
const buildMissingEmbeddings = (db, config = {}) => {
  const recall = config.recall || {};
  if (recall.semanticRerankEnabled !== true) {
    return { enabled: false, computed: 0, skipped: 0, failed: 0 };
  }
  const ollamaUrl = recall.ollamaUrl || DEFAULT_OLLAMA_URL;
  const model = recall.embeddingModel || DEFAULT_MODEL;
  const timeoutMs = recall.embeddingTimeoutMs || DEFAULT_TIMEOUT_MS;

  ensureEmbeddingStore(db);

  // Find active memories without an embedding
  const rows = db.prepare(`
    SELECT mc.memory_id, mc.content
    FROM memory_current mc
    LEFT JOIN memory_embeddings me ON mc.memory_id = me.memory_id
    WHERE mc.status = 'active'
      AND me.memory_id IS NULL
    ORDER BY mc.updated_at DESC
    LIMIT ?
  `).all(NIGHTLY_BATCH_SIZE);

  if (rows.length === 0) {
    return { enabled: true, computed: 0, skipped: 0, failed: 0 };
  }

  const probe = getEmbeddingSync('gigabrain semantic probe', { baseUrl: ollamaUrl, model, timeoutMs });
  if (!probe) {
    return { enabled: true, computed: 0, skipped: 0, failed: rows.length, reachable: false };
  }

  let computed = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    const text = row.content;
    if (!text || text.length < 10) {
      skipped++;
      continue;
    }

    const vec = getEmbeddingSync(text, { baseUrl: ollamaUrl, model, timeoutMs });
    if (!vec) {
      failed++;
      continue;
    }

    try {
      storeEmbedding(db, { memoryId: row.memory_id, model, embedding: vec });
      computed++;
    } catch {
      failed++;
    }
  }

  return { enabled: true, computed, skipped, failed };
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  DEFAULT_OLLAMA_URL,
  DEFAULT_MODEL,
  DEFAULT_DIMS,
  DEFAULT_ALPHA,
  ensureEmbeddingStore,
  getEmbedding,
  getEmbeddingSync,
  isSafeEmbeddingBaseUrl,
  buildEmbeddingEndpoint,
  cosineSimilarity,
  storeEmbedding,
  getStoredEmbedding,
  semanticRerank,
  buildMissingEmbeddings,
  vecToBlob,
  blobToVec,
};
