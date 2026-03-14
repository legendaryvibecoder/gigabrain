import fs from 'node:fs';
import path from 'node:path';

import { loadResolvedConfig, normalizeConfig } from './config.js';
import { openDatabase } from './sqlite.js';
import { describeStandaloneConfigPath } from './standalone-client.js';
import { ensureProjectionStore, getCurrentMemory, listCurrentMemories, materializeProjectionFromMemories, searchCurrentMemories, tableStats } from './projection-store.js';
import { ensureEventStore } from './event-store.js';
import { ensureNativeStore, queryNativeChunks, syncNativeMemory } from './native-sync.js';
import { ensurePersonStore, rebuildEntityMentions } from './person-service.js';
import { ensureWorldModelReady, ensureWorldModelStore, rebuildWorldModel, resolveMemoryTier } from './world-model.js';
import { orchestrateRecall } from './orchestrator.js';
import { captureFromEvent } from './capture-service.js';
import { writeNativeSessionCheckpoint } from './native-memory.js';
import { normalizeContent } from './policy.js';

const USER_OVERLAY_ALLOWED_TYPES = new Set(['PREFERENCE', 'USER_FACT', 'AGENT_IDENTITY', 'DECISION']);

const deepClone = (value) => JSON.parse(JSON.stringify(value ?? {}));

const ensureDir = (dirPath) => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const escapeXml = (value = '') => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

const normalizeTarget = (value, fallback = 'both') => {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'project' || key === 'user' || key === 'both') return key;
  return fallback;
};

const normalizeDurability = (value, fallback = 'durable') => {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'durable' || key === 'ephemeral') return key;
  return fallback;
};

const normalizeType = (value, fallback = 'USER_FACT') => {
  const key = String(value || '').trim().toUpperCase();
  if (!key) return fallback;
  if (key === 'FACT' || key === 'USERFACT') return 'USER_FACT';
  if (USER_OVERLAY_ALLOWED_TYPES.has(key) || ['DECISION', 'ENTITY', 'EPISODE', 'CONTEXT'].includes(key)) return key;
  return fallback;
};

const normalizeStringList = (value) => {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return String(value)
      .split(/\r?\n+/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
};

const buildUserOverlayConfig = (loaded = {}) => {
  const userRoot = String(loaded?.config?.codex?.userProfilePath || '').trim();
  if (!userRoot) return null;
  const raw = deepClone(loaded.rawConfig || {});
  raw.runtime = raw.runtime || {};
  raw.runtime.paths = raw.runtime.paths || {};
  raw.runtime.paths.workspaceRoot = userRoot;
  raw.runtime.paths.memoryRoot = 'memory';
  raw.runtime.paths.registryPath = 'memory/registry.sqlite';
  raw.runtime.paths.outputDir = 'output';
  raw.runtime.paths.reviewQueuePath = 'output/memory-review-queue.jsonl';
  raw.native = raw.native || {};
  raw.native.memoryMdPath = 'MEMORY.md';
  raw.vault = {
    ...(raw.vault || {}),
    enabled: false,
  };
  raw.codex = {
    ...(raw.codex || {}),
    enabled: true,
    storeMode: loaded?.config?.codex?.storeMode || 'global',
    projectRoot: loaded?.config?.codex?.projectRoot || '',
    projectStorePath: loaded?.config?.codex?.projectStorePath || '',
    userProfilePath: userRoot,
    projectScope: loaded?.config?.codex?.projectScope || '',
    defaultProjectScope: loaded?.config?.codex?.defaultProjectScope || loaded?.config?.codex?.projectScope || '',
    defaultUserScope: loaded?.config?.codex?.defaultUserScope || 'profile:user',
    defaultTarget: loaded?.config?.codex?.defaultTarget || 'project',
    recallOrder: Array.isArray(loaded?.config?.codex?.recallOrder) ? loaded.config.codex.recallOrder : ['project', 'user', 'remote'],
    userOverlayTypes: Array.isArray(loaded?.config?.codex?.userOverlayTypes) ? loaded.config.codex.userOverlayTypes : ['PREFERENCE', 'USER_FACT', 'AGENT_IDENTITY', 'DECISION'],
  };
  return normalizeConfig(raw, {
    workspaceRoot: userRoot,
  });
};

const loadCodexContext = (options = {}) => {
  const loaded = loadResolvedConfig({
    configPath: options.configPath || '',
    config: options.config,
    workspaceRoot: options.workspaceRoot,
    mode: options.mode || '',
  });
  return {
    ...loaded,
    projectConfig: loaded.config,
    userConfig: buildUserOverlayConfig(loaded),
  };
};

const ensureStoreFilesystem = (config = {}) => {
  const workspaceRoot = String(config?.runtime?.paths?.workspaceRoot || '').trim();
  const memoryRoot = String(config?.runtime?.paths?.memoryRoot || '').trim();
  const outputDir = String(config?.runtime?.paths?.outputDir || '').trim();
  const registryPath = String(config?.runtime?.paths?.registryPath || '').trim();
  const memoryMdPath = String(config?.native?.memoryMdPath || '').trim();
  if (workspaceRoot) ensureDir(workspaceRoot);
  if (memoryRoot) ensureDir(memoryRoot);
  if (outputDir) ensureDir(outputDir);
  if (registryPath) ensureDir(path.dirname(registryPath));
  if (memoryMdPath && !fs.existsSync(memoryMdPath)) {
    ensureDir(path.dirname(memoryMdPath));
    fs.writeFileSync(memoryMdPath, '# MEMORY\n\n', 'utf8');
  }
};

const openPreparedDb = ({
  config,
  syncNative = false,
  rebuildWorldOnNativeChange = false,
} = {}) => {
  ensureStoreFilesystem(config);
  const dbPath = String(config?.runtime?.paths?.registryPath || '').trim();
  const db = openDatabase(dbPath);
  let projectionImported = 0;
  let nativeSync = {
    changed_files: 0,
    inserted_chunks: 0,
  };
  try {
    ensureProjectionStore(db);
    ensureEventStore(db);
    ensureNativeStore(db);
    ensurePersonStore(db);
    ensureWorldModelStore(db);
    const count = Number(db.prepare('SELECT COUNT(*) AS c FROM memory_current').get()?.c || 0);
    if (count === 0) {
      projectionImported = Number(materializeProjectionFromMemories(db)?.imported || 0);
    }
    if (syncNative) {
      nativeSync = syncNativeMemory({ db, config, dryRun: false }) || nativeSync;
      if (Number(nativeSync?.changed_files || 0) > 0) {
        rebuildEntityMentions(db);
        if (rebuildWorldOnNativeChange && config?.worldModel?.enabled !== false) {
          rebuildWorldModel({ db, config });
        }
      }
    }
    ensureWorldModelReady({ db, config, rebuildIfEmpty: true });
    return {
      db,
      dbPath,
      projectionImported,
      nativeSync,
    };
  } catch (err) {
    db.close();
    throw err;
  }
};

const closeDbQuietly = (db) => {
  try {
    db?.close?.();
  } catch {
    // Ignore teardown noise in caller flows.
  }
};

const resolveStoreOrder = (config = {}, target = 'both') => {
  const normalized = normalizeTarget(target);
  if (normalized === 'project') return ['project'];
  if (normalized === 'user') return ['user'];
  const configured = Array.isArray(config?.codex?.recallOrder) ? config.codex.recallOrder : ['project', 'user', 'remote'];
  return configured.filter((item, index) => ['project', 'user', 'remote'].includes(item) && configured.indexOf(item) === index);
};

const resolveDoctorTargets = (target = 'both') => {
  const normalized = normalizeTarget(target);
  if (normalized === 'project') return ['project'];
  if (normalized === 'user') return ['user'];
  return ['project', 'user'];
};

const resolveScopeForTarget = (config = {}, target = 'project', explicitScope = '') => {
  const scope = String(explicitScope || '').trim();
  const defaultProjectScope = String(config?.codex?.defaultProjectScope || config?.codex?.projectScope || '').trim();
  const defaultUserScope = String(config?.codex?.defaultUserScope || 'profile:user').trim() || 'profile:user';
  if (scope) {
    const normalized = scope.toLowerCase();
    if (target === 'project' && ['project', 'repo', 'workspace'].includes(normalized)) {
      return defaultProjectScope || 'project:workspace';
    }
    if (target === 'user' && ['user', 'profile', 'personal'].includes(normalized)) {
      return defaultUserScope;
    }
    return scope;
  }
  if (target === 'user') {
    return defaultUserScope;
  }
  return defaultProjectScope || 'project:workspace';
};

const getTargetConfig = (context = {}, target = 'project') => {
  if (target === 'project') return context.projectConfig;
  if (target === 'user') return context.userConfig;
  return null;
};

const annotateLocalRecallRow = (db, row = {}, origin = 'project', includeProvenance = false) => {
  const memoryId = String(row.memory_id || row.id || '').trim();
  const localRow = memoryId && !memoryId.startsWith('native:')
    ? (getCurrentMemory(db, memoryId) || {})
    : {};
  const sourceLayer = String(row.source_layer || localRow.source_layer || (memoryId.startsWith('native:') ? 'native' : 'registry') || '').trim();
  const sourcePath = String(row.source_path || localRow.source_path || '').trim();
  const sourceLine = Number.isFinite(Number(row.source_line))
    ? Number(row.source_line)
    : (Number.isFinite(Number(localRow.source_line)) ? Number(localRow.source_line) : null);
  const annotated = {
    origin,
    memory_id: memoryId,
    type: String(row.type || localRow.type || '').trim(),
    content: String(row.content || localRow.content || '').trim(),
    scope: String(row.scope || localRow.scope || '').trim(),
    source_layer: sourceLayer,
    source_path: includeProvenance ? sourcePath : '',
    source_line: includeProvenance ? sourceLine : null,
    score: Number(row._score || row.score || 0),
    confidence: Number(row.confidence || localRow.confidence || 0),
    updated_at: String(row.updated_at || localRow.updated_at || '').trim(),
    created_at: String(row.created_at || localRow.created_at || '').trim(),
    memory_tier: String(row._memory_tier || row.memory_tier || '').trim(),
  };
  return annotated;
};

const annotateRemoteRecallRow = (row = {}, includeProvenance = false) => ({
  origin: 'remote',
  memory_id: String(row.memory_id || '').trim(),
  type: String(row.type || '').trim(),
  content: String(row.content || '').trim(),
  scope: String(row.scope || '').trim(),
  source_layer: 'remote_bridge',
  source_path: includeProvenance ? String(row.source_path || '').trim() : '',
  source_line: includeProvenance && Number.isFinite(Number(row.source_line)) ? Number(row.source_line) : null,
  score: Number(row.score || 0),
  confidence: Number(row.confidence || 0),
  updated_at: String(row.updated_at || '').trim(),
  created_at: String(row.created_at || '').trim(),
  memory_tier: '',
});

const inferNativeType = (row = {}) => {
  const linkedMemoryId = String(row.linked_memory_id || '').trim();
  if (linkedMemoryId) return 'USER_FACT';
  const sourceKind = String(row.source_kind || '').trim();
  if (sourceKind === 'daily_note') return 'CONTEXT';
  return 'USER_FACT';
};

const annotateNativeChunkRow = (row = {}, origin = 'project', includeProvenance = false, scope = '') => {
  const type = String(row.type || inferNativeType(row)).trim();
  const memoryTier = String(
    row.memory_tier
    || row._memory_tier
    || resolveMemoryTier({
      row: {
        type,
        content: row.content || '',
        source_path: row.source_path || '',
        source_layer: 'native',
      },
    }),
  ).trim();
  return {
    origin,
    memory_id: `native:${String(row.chunk_id || '').trim()}`,
    type,
  content: String(row.content || '').trim(),
  scope: String(row.scope || scope || '').trim(),
  source_layer: 'native',
  source_path: includeProvenance ? String(row.source_path || '').trim() : '',
  source_line: includeProvenance && Number.isFinite(Number(row.line_start)) ? Number(row.line_start) : null,
  score: Number(row._score || row.score_total || row.score || 0),
  confidence: Number(row.confidence || 0.7),
  updated_at: String(row.updated_at || row.last_seen_at || '').trim(),
  created_at: String(row.created_at || row.first_seen_at || '').trim(),
    memory_tier: memoryTier || 'working_reference',
  };
};

const getNativeChunkByMemoryId = (db, memoryId = '') => {
  const raw = String(memoryId || '').trim();
  if (!raw.startsWith('native:')) return null;
  const chunkId = raw.slice('native:'.length).trim();
  if (!chunkId) return null;
  ensureNativeStore(db);
  return db.prepare(`
    SELECT
      chunk.chunk_id,
      chunk.source_path,
      chunk.source_kind,
      chunk.source_date,
      chunk.section,
      chunk.line_start,
      chunk.line_end,
      chunk.content,
      chunk.normalized,
      chunk.hash,
      COALESCE(linked.scope, chunk.scope, '') AS scope,
      chunk.linked_memory_id,
      chunk.first_seen_at,
      chunk.last_seen_at,
      chunk.status
    FROM memory_native_chunks AS chunk
    LEFT JOIN memory_current AS linked
      ON linked.memory_id = chunk.linked_memory_id
      AND linked.status = 'active'
    WHERE chunk.chunk_id = ? AND chunk.status = 'active'
    LIMIT 1
  `).get(chunkId) || null;
};

const mergeAnnotatedResults = (batches = [], topK = 8) => {
  const merged = [];
  const seen = new Set();
  for (const batch of batches) {
    for (const row of Array.isArray(batch?.results) ? batch.results : []) {
      const key = normalizeContent(row.content || '') || `${row.origin}:${row.memory_id}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      merged.push(row);
      if (merged.length >= topK) return merged;
    }
  }
  return merged;
};

const fetchRemoteJson = async ({
  baseUrl,
  token,
  pathname,
  method = 'GET',
  body = null,
  timeoutMs = 8000,
} = {}) => {
  const response = await fetch(`${String(baseUrl || '').replace(/\/+$/g, '')}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.detail ? String(payload.detail) : `remote bridge request failed (${response.status})`);
  }
  return payload;
};

const recallRemoteBridge = async ({
  config,
  query,
  scope = '',
  topK = 8,
} = {}) => {
  if (config?.remoteBridge?.enabled !== true || !config?.remoteBridge?.baseUrl) {
    return null;
  }
  const params = {
    query,
    scope,
    topK,
  };
  const [recallPayload, explainPayload] = await Promise.all([
    fetchRemoteJson({
      baseUrl: config.remoteBridge.baseUrl,
      token: config.remoteBridge.authToken,
      pathname: '/gb/recall',
      method: 'POST',
      body: params,
      timeoutMs: config.remoteBridge.timeoutMs,
    }),
    fetchRemoteJson({
      baseUrl: config.remoteBridge.baseUrl,
      token: config.remoteBridge.authToken,
      pathname: '/gb/recall/explain',
      method: 'POST',
      body: {
        query,
        scope,
      },
      timeoutMs: config.remoteBridge.timeoutMs,
    }),
  ]);
  return {
    origin: 'remote',
    strategy: String(explainPayload?.strategy || recallPayload?.strategy || '').trim(),
    rankingMode: String(explainPayload?.ranking_mode || recallPayload?.ranking_mode || '').trim(),
    usedWorldModel: explainPayload?.used_world_model === true,
    confidence: Number(explainPayload?.confidence || 0),
    explain: explainPayload?.explain || {},
    results: Array.isArray(recallPayload?.results) ? recallPayload.results : [],
  };
};

const bootstrapStandaloneStore = (options = {}) => {
  const context = loadCodexContext(options);
  const stores = {};
  let projectStats = {
    total: 0,
    status: {},
  };
  for (const target of ['project', 'user']) {
    const config = getTargetConfig(context, target);
    if (!config) continue;
    const prepared = openPreparedDb({
      config,
      syncNative: true,
      rebuildWorldOnNativeChange: true,
    });
    try {
      const stats = tableStats(prepared.db);
      stores[target] = {
        dbPath: prepared.dbPath,
        projectionImported: prepared.projectionImported,
        nativeSync: prepared.nativeSync,
        stats,
      };
      if (target === 'project') {
        projectStats = stats;
      }
    } finally {
      closeDbQuietly(prepared.db);
    }
  }
  return {
    ok: true,
    source: context.source,
    configPath: context.configPath,
    dbPath: String(stores.project?.dbPath || '').trim(),
    projectionImported: Number(stores.project?.projectionImported || 0),
    nativeSync: stores.project?.nativeSync || { changed_files: 0, inserted_chunks: 0 },
    stats: projectStats,
    stores,
  };
};

const runRemember = (options = {}) => {
  const context = loadCodexContext(options);
  const target = normalizeTarget(options.target, String(context?.projectConfig?.codex?.defaultTarget || 'project'));
  if (target === 'both') throw new Error('remember target must be project or user');
  const config = getTargetConfig(context, target);
  if (!config) throw new Error(`target store '${target}' is not configured`);

  const type = normalizeType(options.type, 'USER_FACT');
  const durability = normalizeDurability(options.durability, 'durable');
  const scope = resolveScopeForTarget(config, target, options.scope);
  const allowedUserTypes = new Set(
    (Array.isArray(config?.codex?.userOverlayTypes) ? config.codex.userOverlayTypes : Array.from(USER_OVERLAY_ALLOWED_TYPES))
      .map((item) => String(item || '').trim().toUpperCase())
      .filter(Boolean),
  );
  if (target === 'user') {
    if (durability !== 'durable') {
      throw new Error('user overlay writes must be durable');
    }
    if (!allowedUserTypes.has(type) || (type === 'DECISION' && options.target !== 'user')) {
      throw new Error(`type '${type}' is not allowed for the user overlay`);
    }
  }

  const content = String(options.content || '').trim();
  if (!content) throw new Error('content is required');
  const confidence = Number.isFinite(Number(options.confidence)) ? Number(options.confidence) : 0.9;
  const prepared = openPreparedDb({
    config,
    syncNative: false,
    rebuildWorldOnNativeChange: false,
  });

  try {
    const summary = captureFromEvent({
      db: prepared.db,
      config,
      event: {
        scope,
        agentId: scope,
        sessionKey: `codex:${target}:${Date.now()}`,
        prompt: durability === 'ephemeral' ? 'remember this temporarily' : 'remember this',
        messages: [
          {
            role: 'user',
            content: durability === 'ephemeral' ? 'remember this temporarily' : 'remember this',
          },
        ],
        output: `<memory_note type="${type}" confidence="${confidence}" durability="${durability}">${escapeXml(content)}</memory_note>`,
      },
    });
    const nativeSync = summary.native_written > 0
      ? (syncNativeMemory({ db: prepared.db, config, dryRun: false }) || { changed_files: 0, inserted_chunks: 0 })
      : { changed_files: 0, inserted_chunks: 0 };
    const writeRecord = Array.isArray(summary.write_records) && summary.write_records.length > 0
      ? summary.write_records[summary.write_records.length - 1]
      : null;
    return {
      ok: true,
      target,
      type,
      durability,
      scope,
      memory_id: String(writeRecord?.memory_id || summary.inserted_ids?.[0] || '').trim(),
      written_native: Number(summary.native_written || 0) > 0,
      written_registry: Number(summary.inserted || 0) > 0,
      source_path: String(writeRecord?.source_path || '').trim(),
      source_line: Number.isFinite(Number(writeRecord?.source_line)) ? Number(writeRecord.source_line) : null,
      source_kind: String(writeRecord?.source_kind || '').trim(),
      duplicate: String(writeRecord?.duplicate || '').trim(),
      queued_review: Number(summary.queued_review || 0),
      native_sync: nativeSync,
    };
  } finally {
    closeDbQuietly(prepared.db);
  }
};

const runCheckpoint = (options = {}) => {
  const context = loadCodexContext(options);
  const target = normalizeTarget(options.target, 'project');
  if (target !== 'project') {
    throw new Error('checkpoint target must be project');
  }
  const config = getTargetConfig(context, 'project');
  if (!config) throw new Error('project store is not configured');

  const scope = resolveScopeForTarget(config, 'project', options.scope);
  const sessionLabel = String(options.sessionLabel || options.session_label || '').trim();
  const summary = String(options.summary || '').replace(/\s+/g, ' ').trim();
  const decisions = normalizeStringList(options.decisions);
  const openLoops = normalizeStringList(options.openLoops || options.open_loops);
  const touchedFiles = normalizeStringList(options.touchedFiles || options.touched_files);
  const durableCandidates = normalizeStringList(options.durableCandidates || options.durable_candidates);
  if (!summary && decisions.length === 0 && openLoops.length === 0 && touchedFiles.length === 0 && durableCandidates.length === 0) {
    throw new Error('checkpoint requires summary or at least one structured field');
  }

  const prepared = openPreparedDb({
    config,
    syncNative: false,
    rebuildWorldOnNativeChange: false,
  });
  try {
    const writeResult = writeNativeSessionCheckpoint({
      config,
      timestamp: options.timestamp || new Date().toISOString(),
      sessionLabel,
      summary,
      scope,
      decisions,
      openLoops,
      touchedFiles,
      durableCandidates,
    });
    const nativeSync = writeResult.written
      ? (syncNativeMemory({ db: prepared.db, config, dryRun: false }) || { changed_files: 0, inserted_chunks: 0 })
      : { changed_files: 0, inserted_chunks: 0 };
    if (Number(nativeSync?.changed_files || 0) > 0) {
      rebuildEntityMentions(prepared.db);
    }
    return {
      ok: true,
      target: 'project',
      scope,
      session_label: sessionLabel,
      written_native: writeResult.written === true,
      source_path: String(writeResult.source_path || '').trim(),
      source_line: Number.isFinite(Number(writeResult.source_line)) ? Number(writeResult.source_line) : null,
      source_kind: String(writeResult.source_kind || 'daily_note').trim(),
      written_sections: Array.isArray(writeResult.written_sections) ? writeResult.written_sections : [],
      item_count: Number(writeResult.item_count || 0),
      native_sync: nativeSync,
    };
  } finally {
    closeDbQuietly(prepared.db);
  }
};

const runRecall = async (options = {}) => {
  const context = loadCodexContext(options);
  const target = normalizeTarget(options.target, 'both');
  const query = String(options.query || '').trim();
  if (!query) throw new Error('query is required');
  const topK = Math.max(1, Math.min(25, Number(options.topK || 8) || 8));
  const includeProvenance = options.includeProvenance === true;
  const batches = [];
  let overallStrategy = '';
  let overallRankingMode = '';
  let usedWorldModel = false;
  let confidence = 0;

  for (const storeTarget of resolveStoreOrder(context.projectConfig, target)) {
    if (storeTarget === 'remote') continue;
    const config = getTargetConfig(context, storeTarget);
    if (!config) continue;
    const scope = resolveScopeForTarget(config, storeTarget, options.scope);
    const prepared = openPreparedDb({
      config,
      syncNative: true,
      rebuildWorldOnNativeChange: true,
    });
    try {
      const recall = orchestrateRecall({
        db: prepared.db,
        config,
        query,
        scope,
      });
      const results = (recall.results || []).map((row) => annotateLocalRecallRow(prepared.db, row, storeTarget, includeProvenance));
      batches.push({
        origin: storeTarget,
        results,
      });
      if (!overallStrategy) overallStrategy = recall.strategy;
      if (!overallRankingMode) overallRankingMode = recall.rankingMode;
      usedWorldModel = usedWorldModel || recall.usedWorldModel === true;
      confidence = Math.max(confidence, Number(recall.confidence || 0));
    } finally {
      closeDbQuietly(prepared.db);
    }
  }

  if (resolveStoreOrder(context.projectConfig, target).includes('remote') && context.projectConfig?.remoteBridge?.enabled === true) {
    const remoteRecall = await recallRemoteBridge({
      config: context.projectConfig,
      query,
      scope: String(options.scope || '').trim(),
      topK,
    });
    if (remoteRecall) {
      batches.push({
        origin: 'remote',
        results: remoteRecall.results.map((row) => annotateRemoteRecallRow(row, includeProvenance)),
      });
      if (!overallStrategy) overallStrategy = remoteRecall.strategy;
      if (!overallRankingMode) overallRankingMode = remoteRecall.rankingMode;
      usedWorldModel = usedWorldModel || remoteRecall.usedWorldModel === true;
      confidence = Math.max(confidence, Number(remoteRecall.confidence || 0));
    }
  }

  return {
    ok: true,
    query,
    target,
    strategy: overallStrategy || 'quick_context',
    ranking_mode: overallRankingMode || 'broad',
    used_world_model: usedWorldModel,
    confidence,
    results: mergeAnnotatedResults(batches, topK),
  };
};

const runProvenance = async (options = {}) => {
  const target = normalizeTarget(options.target, 'both');
  const memoryId = String(options.memoryId || options.memory_id || '').trim();
  if (memoryId) {
    const context = loadCodexContext(options);
    const batches = [];
    for (const storeTarget of resolveStoreOrder(context.projectConfig, target)) {
      if (storeTarget === 'remote') continue;
      const config = getTargetConfig(context, storeTarget);
      if (!config) continue;
      const prepared = openPreparedDb({
        config,
        syncNative: false,
        rebuildWorldOnNativeChange: false,
      });
      try {
        const row = getCurrentMemory(prepared.db, memoryId);
        if (row) {
          batches.push({
            origin: storeTarget,
            results: [annotateLocalRecallRow(prepared.db, row, storeTarget, true)],
          });
          continue;
        }
        const nativeRow = getNativeChunkByMemoryId(prepared.db, memoryId);
        if (!nativeRow) continue;
        batches.push({
          origin: storeTarget,
          results: [annotateNativeChunkRow(nativeRow, storeTarget, true, resolveScopeForTarget(config, storeTarget, options.scope))],
        });
      } finally {
        closeDbQuietly(prepared.db);
      }
    }
    return {
      ok: true,
      memory_id: memoryId,
      target,
      strategy: 'memory_lookup',
      ranking_mode: 'memory_id',
      results: mergeAnnotatedResults(batches, 10),
    };
  }
  const direct = await runRecall({
    ...options,
    target,
    includeProvenance: true,
  });
  if (Array.isArray(direct.results) && direct.results.length > 0) {
    return direct;
  }

  const context = loadCodexContext(options);
  const query = String(options.query || '').trim();
  const batches = [];
  for (const storeTarget of resolveStoreOrder(context.projectConfig, target)) {
    if (storeTarget === 'remote') continue;
    const config = getTargetConfig(context, storeTarget);
    if (!config) continue;
    const scope = resolveScopeForTarget(config, storeTarget, options.scope);
    const prepared = openPreparedDb({
      config,
      syncNative: false,
      rebuildWorldOnNativeChange: false,
    });
    try {
      const registry = searchCurrentMemories(prepared.db, {
        query,
        scope,
        topK: 10,
        statuses: ['active'],
      }).map((row) => annotateLocalRecallRow(prepared.db, row, storeTarget, true));
      const native = queryNativeChunks(prepared.db, {
        query,
        scope,
        topK: 10,
      }).map((row) => annotateNativeChunkRow(row, storeTarget, true, scope));
      if (registry.length > 0 || native.length > 0) {
        batches.push({
          origin: storeTarget,
          results: [...registry, ...native],
        });
      }
    } finally {
      closeDbQuietly(prepared.db);
    }
  }

  const merged = mergeAnnotatedResults(batches, 10);
  if (merged.length === 0) return direct;
  return {
    ...direct,
    ranking_mode: direct.ranking_mode ? `${direct.ranking_mode}+provenance_fallback` : 'provenance_fallback',
    results: merged,
  };
};

const runRecent = (options = {}) => {
  const context = loadCodexContext(options);
  const target = normalizeTarget(options.target, 'both');
  const limit = Math.max(1, Math.min(50, Number(options.limit || 10) || 10));
  const rows = [];
  for (const storeTarget of resolveStoreOrder(context.projectConfig, target)) {
    if (storeTarget === 'remote') continue;
    const config = getTargetConfig(context, storeTarget);
    if (!config) continue;
    const scope = resolveScopeForTarget(config, storeTarget, options.scope);
    const prepared = openPreparedDb({
      config,
      syncNative: false,
      rebuildWorldOnNativeChange: false,
    });
    try {
      const current = listCurrentMemories(prepared.db, {
        statuses: ['active'],
        scope,
        limit: Math.max(limit * 2, 20),
      }).map((row) => annotateLocalRecallRow(prepared.db, row, storeTarget, true));
      rows.push(...current);
    } finally {
      closeDbQuietly(prepared.db);
    }
  }
  rows.sort((a, b) => Date.parse(String(b.updated_at || b.created_at || '')) - Date.parse(String(a.updated_at || a.created_at || '')));
  return {
    ok: true,
    target,
    results: rows.slice(0, limit),
  };
};

const readLocalStoreHealth = (config = {}, target = 'project') => {
  const dbPath = String(config?.runtime?.paths?.registryPath || '').trim();
  const memoryMdPath = String(config?.native?.memoryMdPath || '').trim();
  const workspaceRoot = String(config?.runtime?.paths?.workspaceRoot || '').trim();
  const exists = Boolean(workspaceRoot && fs.existsSync(workspaceRoot));
  const dbExists = Boolean(dbPath && fs.existsSync(dbPath));
  const memoryExists = Boolean(memoryMdPath && fs.existsSync(memoryMdPath));
  const health = {
    target,
    ok: exists,
    workspace_root: workspaceRoot,
    db_path: dbPath,
    db_exists: dbExists,
    memory_md_path: memoryMdPath,
    memory_md_exists: memoryExists,
    stats: {
      total: 0,
      status: {},
    },
  };
  if (!dbExists) return health;
  const db = openDatabase(dbPath);
  try {
    health.stats = tableStats(db);
    health.ok = true;
    return health;
  } finally {
    closeDbQuietly(db);
  }
};

const missingStoreHealth = (target = 'user', reason = '') => ({
  target,
  ok: false,
  workspace_root: '',
  db_path: '',
  db_exists: false,
  memory_md_path: '',
  memory_md_exists: false,
  stats: {
    total: 0,
    status: {},
  },
  error: reason || `target store '${target}' is not configured`,
});

const runDoctor = async (options = {}) => {
  const context = loadCodexContext(options);
  const target = normalizeTarget(options.target, 'both');
  const standalonePath = describeStandaloneConfigPath({
    configPath: context.configPath,
    projectRoot: String(context.projectConfig?.codex?.projectRoot || '').trim(),
    storeMode: String(context.projectConfig?.codex?.storeMode || 'global').trim(),
  });
  const out = {
    ok: true,
    source: context.source,
    config_path: context.configPath,
    sharing_mode: standalonePath.sharingMode,
    standalone_path_kind: standalonePath.pathKind,
    canonical_config_path: standalonePath.canonicalConfigPath,
    legacy_config_path: standalonePath.legacyConfigPath,
    project_root: String(context.projectConfig?.codex?.projectRoot || '').trim(),
    store_mode: String(context.projectConfig?.codex?.storeMode || 'global').trim(),
    project_scope: String(context.projectConfig?.codex?.projectScope || '').trim(),
    primary_store_path: String(context.projectConfig?.runtime?.paths?.workspaceRoot || '').trim(),
    project_store_path: String(context.projectConfig?.codex?.projectStorePath || context.projectConfig?.runtime?.paths?.workspaceRoot || '').trim(),
    user_profile_path: String(context.projectConfig?.codex?.userProfilePath || '').trim(),
    stores: [],
    remote_bridge: {
      enabled: context.projectConfig?.remoteBridge?.enabled === true,
      ok: context.projectConfig?.remoteBridge?.enabled !== true,
      base_url: String(context.projectConfig?.remoteBridge?.baseUrl || '').trim(),
    },
  };

  for (const storeTarget of resolveDoctorTargets(target)) {
    const config = getTargetConfig(context, storeTarget);
    if (!config) {
      const missing = missingStoreHealth(storeTarget, `target store '${storeTarget}' is not configured`);
      out.stores.push(missing);
      out.ok = false;
      continue;
    }
    const health = readLocalStoreHealth(config, storeTarget);
    out.stores.push(health);
    out.ok = out.ok && health.ok;
  }

  if (target === 'both' && context.projectConfig?.remoteBridge?.enabled === true) {
    try {
      await fetchRemoteJson({
        baseUrl: context.projectConfig.remoteBridge.baseUrl,
        token: context.projectConfig.remoteBridge.authToken,
        pathname: '/gb/health',
        method: 'GET',
        timeoutMs: context.projectConfig.remoteBridge.timeoutMs,
      });
      out.remote_bridge.ok = true;
    } catch (err) {
      out.remote_bridge.ok = false;
      out.remote_bridge.error = err instanceof Error ? err.message : String(err);
      out.ok = false;
    }
  }

  return out;
};

export {
  loadCodexContext,
  bootstrapStandaloneStore,
  runCheckpoint,
  runRemember,
  runRecall,
  runProvenance,
  runRecent,
  runDoctor,
};
