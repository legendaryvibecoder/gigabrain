import fs from 'node:fs';
import path from 'node:path';

import { normalizeConfig } from './config.js';
import { ensureEventStore } from './event-store.js';
import {
  DEFAULT_MODEL,
  DEFAULT_OLLAMA_URL,
  getEmbeddingSync,
} from './embedding-service.js';
import { ensureNativeStore, queryNativeChunks } from './native-sync.js';
import { ensurePersonStore } from './person-service.js';
import {
  ensureProjectionStore,
  getCurrentMemory,
  hasTable,
  materializeProjectionFromMemories,
  searchCurrentMemories,
} from './projection-store.js';
import { openDatabase } from './sqlite.js';
import { ensureWorldModelReady, ensureWorldModelStore } from './world-model.js';

const VIRTUAL_MEMORY_PREFIX = '__gigabrain__/registry/';
const MAX_SNIPPET_CHARS = 400;

const isObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const resolveRawPluginConfig = (raw) => {
  if (!isObject(raw)) return {};
  const nested = raw?.plugins?.entries?.gigabrain?.config;
  if (isObject(nested)) return nested;
  return raw;
};

const normalizePluginConfig = (cfg) => normalizeConfig(resolveRawPluginConfig(cfg), {
  workspaceRoot: process.cwd(),
});

const normalizeResolvedScope = (value = '') => {
  const scope = String(value || '').trim();
  if (!scope) return '';
  if (scope === 'main') return 'profile:main';
  return scope;
};

const parseAgentIdFromSessionKey = (sessionKey = '') => {
  const parts = String(sessionKey || '').split(':');
  return String(parts[1] || 'shared').trim() || 'shared';
};

const resolveScopeForManager = ({ agentId = 'main', sessionKey = '', config = {} } = {}) => {
  const sessionAgentId = normalizeResolvedScope(parseAgentIdFromSessionKey(sessionKey));
  const directAgentId = normalizeResolvedScope(agentId);
  if (sessionAgentId && sessionAgentId !== 'shared') return sessionAgentId;
  if (directAgentId && directAgentId !== 'shared') return directAgentId;
  const workspaceRoot = String(config?.runtime?.paths?.workspaceRoot || '').trim();
  if (workspaceRoot) return 'profile:main';
  return directAgentId || sessionAgentId || 'shared';
};

const withPreparedDb = (config, fn, options = {}) => {
  const dbPath = path.resolve(String(config?.runtime?.paths?.registryPath || ''));
  const readOnly = options?.readOnly !== false;
  const db = openDatabase(dbPath, readOnly ? { readOnly: true } : {});
  try {
    if (!readOnly) {
      ensureProjectionStore(db);
      ensureEventStore(db);
      ensureNativeStore(db);
      ensurePersonStore(db);
      ensureWorldModelStore(db);
      const count = Number(db.prepare('SELECT COUNT(*) AS c FROM memory_current').get()?.c || 0);
      if (count === 0) {
        materializeProjectionFromMemories(db);
      }
      ensureWorldModelReady({ db, config, rebuildIfEmpty: true });
    }
    return fn(db, dbPath);
  } finally {
    db.close();
  }
};

const toWorkspaceRelativePath = (workspaceRoot = '', sourcePath = '') => {
  const absolute = String(sourcePath || '').trim();
  const root = String(workspaceRoot || '').trim();
  if (!absolute) return '';
  if (!path.isAbsolute(absolute) || !root) return absolute;
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..')) return absolute;
  return relative;
};

const trimSnippet = (value = '') => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= MAX_SNIPPET_CHARS) return text;
  return `${text.slice(0, MAX_SNIPPET_CHARS - 1).trim()}…`;
};

const buildVirtualMemoryPath = (memoryId = '') => `${VIRTUAL_MEMORY_PREFIX}${encodeURIComponent(String(memoryId || '').trim())}.md`;
const isVirtualMemoryPath = (relPath = '') => String(relPath || '').startsWith(VIRTUAL_MEMORY_PREFIX);
const decodeVirtualMemoryId = (relPath = '') => {
  const trimmed = String(relPath || '').trim();
  if (!isVirtualMemoryPath(trimmed)) return '';
  const encoded = trimmed.slice(VIRTUAL_MEMORY_PREFIX.length).replace(/\.md$/i, '');
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
};

const paginateText = ({ text = '', relPath = '', from = 1, lines = 200 } = {}) => {
  const list = String(text || '').split(/\r?\n/);
  const start = Math.max(1, Number(from || 1) || 1);
  const take = Math.max(1, Math.min(500, Number(lines || 200) || 200));
  const startIndex = start - 1;
  const slice = list.slice(startIndex, startIndex + take);
  const nextFrom = startIndex + slice.length < list.length ? start + slice.length : undefined;
  return {
    text: slice.join('\n'),
    path: relPath,
    from: start,
    lines: slice.length,
    ...(nextFrom ? { truncated: true, nextFrom } : {}),
  };
};

const buildRegistryMemoryDocument = (row = {}) => {
  const lines = ['# Gigabrain Registry Memory', ''];
  const meta = [
    ['memory_id', row.memory_id],
    ['type', row.type],
    ['scope', row.scope],
    ['status', row.status],
    ['confidence', row.confidence],
    ['updated_at', row.updated_at || row.created_at],
    ['source_path', row.source_path],
    ['source_line', row.source_line],
  ];
  for (const [label, value] of meta) {
    const text = String(value ?? '').trim();
    if (!text) continue;
    lines.push(`- ${label}: ${text}`);
  }
  lines.push('', '## Content', '', String(row.content || '').trim());
  lines.push('');
  return lines.join('\n');
};

const readVirtualMemory = ({ db, relPath = '' } = {}) => {
  const memoryId = decodeVirtualMemoryId(relPath);
  if (!memoryId) throw new Error(`Unknown Gigabrain virtual memory path: ${relPath}`);
  const currentRow = getCurrentMemory(db, memoryId);
  if (currentRow) return buildRegistryMemoryDocument(currentRow);
  const nativeRow = memoryId.startsWith('native:')
    ? db.prepare(`
      SELECT
        chunk.chunk_id,
        chunk.source_path,
        chunk.line_start AS source_line,
        chunk.content,
        COALESCE(linked.scope, chunk.scope, '') AS scope,
        COALESCE(linked.updated_at, chunk.last_seen_at, chunk.first_seen_at, '') AS updated_at,
        COALESCE(linked.created_at, chunk.first_seen_at, '') AS created_at,
        COALESCE(linked.type, chunk.memory_type, 'USER_FACT') AS type,
        'active' AS status,
        0.7 AS confidence,
        ? AS memory_id
      FROM memory_native_chunks AS chunk
      LEFT JOIN memory_current AS linked
        ON linked.memory_id = chunk.linked_memory_id
        AND linked.status = 'active'
      WHERE chunk.chunk_id = ?
      LIMIT 1
    `).get(memoryId, memoryId.slice('native:'.length))
    : null;
  if (nativeRow) return buildRegistryMemoryDocument(nativeRow);
  throw new Error(`Memory not found for ${relPath}`);
};

const normalizeResultScore = (row = {}) => Number(
  row.score_total
  ?? row._score
  ?? row.score
  ?? 0,
) || 0;

const buildCurrentMemorySearchResult = ({ db, row = {}, workspaceRoot = '' } = {}) => {
  const current = getCurrentMemory(db, String(row.memory_id || '').trim()) || row;
  const sourcePath = String(current.source_path || '').trim();
  const sourceLine = Number.isFinite(Number(current.source_line)) ? Number(current.source_line) : 1;
  const relPath = sourcePath
    ? toWorkspaceRelativePath(workspaceRoot, sourcePath)
    : buildVirtualMemoryPath(String(current.memory_id || row.memory_id || '').trim());
  return {
    path: relPath,
    startLine: sourceLine,
    endLine: sourceLine,
    score: normalizeResultScore(row),
    snippet: trimSnippet(current.content || row.content || ''),
    source: 'memory',
    citation: sourcePath ? `${relPath}:${sourceLine}` : String(current.memory_id || row.memory_id || '').trim(),
  };
};

const buildNativeChunkSearchResult = ({ row = {}, workspaceRoot = '' } = {}) => {
  const relPath = toWorkspaceRelativePath(workspaceRoot, String(row.source_path || '').trim());
  const startLine = Number.isFinite(Number(row.line_start)) ? Number(row.line_start) : 1;
  const endLine = Number.isFinite(Number(row.line_end)) ? Number(row.line_end) : startLine;
  return {
    path: relPath || buildVirtualMemoryPath(`native:${String(row.chunk_id || '').trim()}`),
    startLine,
    endLine,
    score: normalizeResultScore(row),
    snippet: trimSnippet(row.content || ''),
    source: 'memory',
    citation: relPath ? `${relPath}:${startLine}` : `native:${String(row.chunk_id || '').trim()}`,
  };
};

const dedupeAndSortResults = (results = [], maxResults = 8, minScore = 0) => {
  const seen = new Set();
  const deduped = [];
  for (const result of results) {
    const key = `${result.path}:${result.startLine}:${result.snippet}`;
    if (!result.path || seen.has(key)) continue;
    seen.add(key);
    if (Number(result.score || 0) < Number(minScore || 0)) continue;
    deduped.push(result);
  }
  deduped.sort((a, b) => Number(b.score || 0) - Number(a.score || 0) || String(a.path || '').localeCompare(String(b.path || '')));
  return deduped.slice(0, Math.max(1, Math.min(100, Number(maxResults || 8) || 8)));
};

const probeEmbeddingAvailability = (config = {}) => {
  const recall = config?.recall || {};
  if (recall.semanticRerankEnabled !== true) return { ok: true };
  const provider = String(recall.embeddingProvider || 'ollama').trim() || 'ollama';
  const baseUrl = recall.embeddingBaseUrl || recall.ollamaUrl || DEFAULT_OLLAMA_URL;
  const model = recall.embeddingModel || DEFAULT_MODEL;
  const timeoutMs = recall.embeddingTimeoutMs || 12000;
  try {
    const vector = getEmbeddingSync('gigabrain semantic probe', {
      provider,
      baseUrl,
      apiKey: recall.embeddingApiKey || recall.apiKey || '',
      model,
      timeoutMs,
    });
    if (Array.isArray(vector) && vector.length > 0) return { ok: true };
    return { ok: false, error: 'embedding provider returned no vector' };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

const readStatusSnapshot = ({ db, config = {}, agentId = 'main' } = {}) => {
  const workspaceRoot = String(config?.runtime?.paths?.workspaceRoot || '').trim();
  const dbPath = String(config?.runtime?.paths?.registryPath || '').trim();
  const currentChunks = Number(db.prepare("SELECT COUNT(*) AS c FROM memory_current WHERE status = 'active'").get()?.c || 0);
  const nativeFiles = hasTable(db, 'memory_native_sync_state')
    ? Number(db.prepare('SELECT COUNT(*) AS c FROM memory_native_sync_state').get()?.c || 0)
    : Number(db.prepare("SELECT COUNT(DISTINCT source_path) AS c FROM memory_current WHERE status = 'active' AND COALESCE(source_path, '') <> ''").get()?.c || 0);
  const ftsAvailable = hasTable(db, 'memory_fts');
  const embeddingsCount = hasTable(db, 'memory_embeddings')
    ? Number(db.prepare('SELECT COUNT(*) AS c FROM memory_embeddings').get()?.c || 0)
    : 0;
  const recall = config?.recall || {};
  const semanticEnabled = recall.semanticRerankEnabled === true;
  const provider = String(recall.embeddingProvider || 'ollama').trim() || 'ollama';
  const model = String(recall.embeddingModel || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const entityCount = hasTable(db, 'memory_entities')
    ? Number(db.prepare('SELECT COUNT(*) AS c FROM memory_entities').get()?.c || 0)
    : 0;
  const beliefCount = hasTable(db, 'memory_beliefs')
    ? Number(db.prepare('SELECT COUNT(*) AS c FROM memory_beliefs').get()?.c || 0)
    : 0;
  const synthesisCount = hasTable(db, 'memory_syntheses')
    ? Number(db.prepare('SELECT COUNT(*) AS c FROM memory_syntheses').get()?.c || 0)
    : 0;
  const openLoopCount = hasTable(db, 'memory_open_loops')
    ? Number(db.prepare('SELECT COUNT(*) AS c FROM memory_open_loops').get()?.c || 0)
    : 0;
  return {
    backend: 'builtin',
    provider: 'gigabrain',
    ...(semanticEnabled ? { model, requestedProvider: provider } : {}),
    files: nativeFiles,
    chunks: currentChunks,
    workspaceDir: workspaceRoot,
    dbPath,
    sources: ['memory'],
    sourceCounts: [{ source: 'memory', files: nativeFiles, chunks: currentChunks }],
    fts: {
      enabled: true,
      available: ftsAvailable,
    },
    vector: {
      enabled: semanticEnabled,
      available: semanticEnabled ? embeddingsCount > 0 : false,
      ...(semanticEnabled ? { dims: Number(recall.embeddingDims || 0) || undefined } : {}),
    },
    custom: {
      agentId,
      gigabrain: true,
      entities: entityCount,
      beliefs: beliefCount,
      syntheses: synthesisCount,
      openLoops: openLoopCount,
      embeddings: embeddingsCount,
      semanticRerankEnabled: semanticEnabled,
    },
  };
};

const createGigabrainMemoryManager = ({ config, agentId = 'main' } = {}) => ({
  async search(query, opts = {}) {
    const maxResults = Math.max(1, Math.min(100, Number(opts?.maxResults || 8) || 8));
    const minScore = Number(opts?.minScore || 0) || 0;
    const sessionKey = String(opts?.sessionKey || '').trim();
    const scope = resolveScopeForManager({ agentId, sessionKey, config });
    return withPreparedDb(config, (db) => {
      const registryRows = searchCurrentMemories(db, {
        query,
        scope,
        topK: Math.max(20, maxResults * 6),
        statuses: ['active'],
      }).map((row) => buildCurrentMemorySearchResult({ db, row, workspaceRoot: config?.runtime?.paths?.workspaceRoot }));
      const nativeRows = hasTable(db, 'memory_native_chunks')
        ? queryNativeChunks({
          db,
          config,
          query,
          scope,
          limit: Math.max(20, maxResults * 6),
        }).map((row) => buildNativeChunkSearchResult({ row, workspaceRoot: config?.runtime?.paths?.workspaceRoot }))
        : [];
      return dedupeAndSortResults([...registryRows, ...nativeRows], maxResults, minScore);
    });
  },

  async readFile(params = {}) {
    const relPath = String(params?.relPath || '').trim();
    const from = Number(params?.from || 1) || 1;
    const lines = Number(params?.lines || 200) || 200;
    return withPreparedDb(config, (db) => {
      if (isVirtualMemoryPath(relPath)) {
        const text = readVirtualMemory({ db, relPath });
        return paginateText({ text, relPath, from, lines });
      }
      const workspaceRoot = String(config?.runtime?.paths?.workspaceRoot || '').trim();
      const absolute = path.isAbsolute(relPath)
        ? relPath
        : path.resolve(workspaceRoot || process.cwd(), relPath);
      if (!fs.existsSync(absolute)) {
        throw new Error(`Memory file not found: ${relPath}`);
      }
      const text = fs.readFileSync(absolute, 'utf8');
      return paginateText({ text, relPath, from, lines });
    });
  },

  status() {
    return withPreparedDb(config, (db) => readStatusSnapshot({ db, config, agentId }));
  },

  async probeEmbeddingAvailability() {
    return probeEmbeddingAvailability(config);
  },

  async probeVectorAvailability() {
    const probe = probeEmbeddingAvailability(config);
    return probe.ok === true;
  },

  async close() {
    return undefined;
  },
});

const gigabrainMemoryRuntime = {
  async getMemorySearchManager(params = {}) {
    try {
      const config = normalizePluginConfig(params?.cfg);
      if (config?.enabled === false) {
        return { manager: null, error: 'gigabrain disabled' };
      }
      return {
        manager: createGigabrainMemoryManager({ config, agentId: String(params?.agentId || 'main').trim() || 'main' }),
      };
    } catch (error) {
      return {
        manager: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },

  resolveMemoryBackendConfig() {
    return { backend: 'builtin' };
  },

  async closeAllMemorySearchManagers() {
    return undefined;
  },
};

export {
  VIRTUAL_MEMORY_PREFIX,
  buildVirtualMemoryPath,
  createGigabrainMemoryManager,
  gigabrainMemoryRuntime,
  readStatusSnapshot,
};
