import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadResolvedConfig, normalizeConfig } from './config.js';
import { openDatabase } from './sqlite.js';
import { describeStandaloneConfigPath } from './standalone-client.js';
import { ensureProjectionStore, getCurrentMemory, listAdjudications, listBeliefsAsOf, listCurrentMemories, materializeProjectionFromMemories, rowVisibleForRequestedScope, searchCurrentMemories, tableStats } from './projection-store.js';
import { classifyHostTier, hostTrustScore } from './host-trust.js';
import { ensureEventStore } from './event-store.js';
import { ensureNativeStore, queryNativeChunks, syncNativeMemory } from './native-sync.js';
import { expandMemorySourceLinks, exportMemoryBrief, getSyncStatus, listMemorySources } from './host-memory-sync.js';
import { ensurePersonStore, rebuildEntityMentions } from './person-service.js';
import { ensureWorldModelReady, ensureWorldModelStore, projectArbitrationBeliefRows, rebuildWorldModel, resolveMemoryTier, getEntityDetail, getEntityEvolution, findEntityMatches, listBeliefs, listContradictions, listEntities, listRelationshipDetails, suggestContradictionResolution } from './world-model.js';
import { runBeliefArbitration } from './belief-arbitration.js';
import { orchestrateRecall } from './orchestrator.js';
import { captureFromEvent } from './capture-service.js';
import { listQueueEntries } from './review-queue.js';
import { writeNativeSessionCheckpoint } from './native-memory.js';
import { normalizeContent } from './policy.js';
import { buildHttpEndpoint } from './url-safety.js';
import { createFileExclusiveSync } from './safe-fs.js';
import {
  appendCheckpointEpisode,
  appendClaimDecision,
  appendClaimProposal,
  appendMemoryReceipt,
  ensureControlPlaneStore,
  getCheckpointEpisode,
  getClaimProposal,
  getMemoryReceipt,
  hashRecord,
  listCheckpointEpisodes,
  listClaimProposals,
} from './control-plane.js';

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

const detectCheckpointSurface = (config = {}, requestedSurface = '') => {
  const explicit = String(requestedSurface || '').trim().toLowerCase();
  if (explicit === 'codex' || explicit === 'claude' || explicit === 'openclaw' || explicit === 'agent') {
    return explicit;
  }

  const projectRoot = String(config?.codex?.projectRoot || '').trim();
  if (!projectRoot) return 'codex';

  const hasClaudeMarkers = fs.existsSync(path.join(projectRoot, '.claude'))
    || fs.existsSync(path.join(projectRoot, 'CLAUDE.md'))
    || fs.existsSync(path.join(projectRoot, '.mcp.json'));
  const hasCodexMarkers = fs.existsSync(path.join(projectRoot, '.codex'))
    || fs.existsSync(path.join(projectRoot, 'AGENTS.md'));

  if (hasClaudeMarkers && !hasCodexMarkers) return 'claude';
  if (hasCodexMarkers && !hasClaudeMarkers) return 'codex';
  if (hasClaudeMarkers && hasCodexMarkers) return 'agent';
  return 'codex';
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
  if (memoryMdPath) createFileExclusiveSync(memoryMdPath, '# MEMORY\n\n', { mode: 0o600 });
};

const openPreparedDb = ({
  config,
  syncNative = false,
  rebuildWorldOnNativeChange = false,
  allowMaintenance = true,
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
    ensureControlPlaneStore(db);
    const count = Number(db.prepare('SELECT COUNT(*) AS c FROM memory_current').get()?.c || 0);
    if (allowMaintenance && count === 0) {
      projectionImported = Number(materializeProjectionFromMemories(db)?.imported || 0);
    }
    if (allowMaintenance && syncNative) {
      nativeSync = syncNativeMemory({ db, config, dryRun: false }) || nativeSync;
      if (Number(nativeSync?.changed_files || 0) > 0) {
        rebuildEntityMentions(db);
        if (rebuildWorldOnNativeChange) {
          if (config?.worldModel?.enabled !== false) {
            rebuildWorldModel({ db, config });
          } else {
            // U17: worldModel.enabled gates the world-model SURFACES only —
            // freshly synced cross-store rows still get arbitrated.
            runBeliefArbitration({ db, config, projectBeliefRows: projectArbitrationBeliefRows });
          }
        }
      }
    }
    if (allowMaintenance) {
      ensureWorldModelReady({ db, config, rebuildIfEmpty: true });
    }
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

const normalizedAuthorizedScopes = (options = {}) => normalizeStringList(
  options.allowedScopes || options.allowed_scopes || options.authorization?.memoryScopes || [],
);

const assertScopeAuthorized = (scope, options = {}) => {
  const allowed = normalizedAuthorizedScopes(options);
  if (allowed.length === 0) return scope;
  const explicitlyRequested = String(options.scope || options.memoryScope || options.memory_scope || '').trim();
  if (!explicitlyRequested && allowed.length === 1) return allowed[0];
  if (!allowed.includes(String(scope || '').trim())) {
    throw new Error('memory scope is not authorized');
  }
  return scope;
};

const storeTargetForAuthorizedScope = (scope = '') => (
  String(scope || '').trim().startsWith('profile:') ? 'user' : 'project'
);

const resolveReadStoreQueries = (context = {}, target = 'both', options = {}) => {
  const allowedScopes = normalizedAuthorizedScopes(options);
  const requestedStores = resolveStoreOrder(context.projectConfig, target)
    .filter((storeTarget) => storeTarget === 'project' || storeTarget === 'user');
  const explicitScope = String(options.scope || options.memoryScope || options.memory_scope || '').trim();

  if (allowedScopes.length === 0 && explicitScope) {
    const normalized = explicitScope.toLowerCase();
    const storeTarget = ['user', 'profile', 'personal'].includes(normalized)
      ? 'user'
      : (['project', 'repo', 'workspace'].includes(normalized)
        ? 'project'
        : storeTargetForAuthorizedScope(explicitScope));
    if (!requestedStores.includes(storeTarget)) {
      throw new Error('memory scope does not match the requested target');
    }
    const config = getTargetConfig(context, storeTarget);
    if (!config) throw new Error(`target store '${storeTarget}' is not configured`);
    return [{
      storeTarget,
      config,
      scope: resolveScopeForTarget(config, storeTarget, explicitScope),
      exactScope: true,
    }];
  }

  if (allowedScopes.length === 0) {
    return requestedStores
      .map((storeTarget) => {
        const config = getTargetConfig(context, storeTarget);
        if (!config) return null;
        return {
          storeTarget,
          config,
          scope: resolveScopeForTarget(config, storeTarget, ''),
          exactScope: false,
        };
      })
      .filter(Boolean);
  }

  if (!explicitScope && allowedScopes.length > 1) {
    throw new Error('scope is required when multiple memory scopes are authorized');
  }
  const scopes = explicitScope ? [assertScopeAuthorized(explicitScope, options)] : allowedScopes;
  const queries = [];
  const seen = new Set();
  for (const scope of scopes) {
    const storeTarget = storeTargetForAuthorizedScope(scope);
    if (!requestedStores.includes(storeTarget)) continue;
    const config = getTargetConfig(context, storeTarget);
    if (!config) continue;
    const key = `${storeTarget}\u0000${scope}`;
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push({ storeTarget, config, scope, exactScope: true });
  }
  if (queries.length === 0) {
    throw new Error('memory scope is not authorized for the requested target');
  }
  return queries;
};

const getTargetConfig = (context = {}, target = 'project') => {
  if (target === 'project') return context.projectConfig;
  if (target === 'user') return context.userConfig;
  return null;
};

// U15: every recall surface (MCP results included) carries the same arbitrated
// provenance the injection renders — {source_agent, trust_tier, trust_score,
// verdict_ref?, valid_window, unresolved_conflict} plus the hybrid strength
// channel (review F5: _hybrid_strength forwarded as hybrid_strength). Rows
// arriving from orchestrateRecall already carry these (recall-service attaches
// them); rows fetched directly (recent/provenance paths) fall back to the
// stored columns. verdict_ref is forwarded, never re-queried here — the
// drill-down tools (gigabrain_arbitrate / gigabrain_adjudications) own the
// ledger lookups.
const buildRowProvenanceFields = (row = {}, localRow = {}, sourceHost = 'gigabrain') => {
  const validWindow = row.valid_window && typeof row.valid_window === 'object'
    ? row.valid_window
    : {
      from: String(localRow.valid_from || localRow.created_at || row.created_at || '').trim() || null,
      until: String(localRow.valid_until || '').trim() || null,
    };
  return {
    hybrid_strength: Number.isFinite(Number(row._hybrid_strength)) ? Number(row._hybrid_strength) : null,
    source_agent: String(row.source_agent || localRow.source_agent || '').trim() || null,
    trust_tier: String(row.trust_tier || '').trim() || classifyHostTier(sourceHost),
    trust_score: Number.isFinite(Number(row.trust_score)) ? Number(row.trust_score) : hostTrustScore(sourceHost),
    verdict_ref: String(row.verdict_ref || '').trim() || null,
    valid_window: {
      from: String(validWindow?.from || '').trim() || null,
      until: String(validWindow?.until || '').trim() || null,
    },
    unresolved_conflict: row.unresolved_conflict === true,
  };
};

const annotateLocalRecallRow = (db, row = {}, origin = 'project', includeProvenance = false) => {
  const memoryId = String(row.memory_id || row.id || '').trim();
  const localRow = memoryId && !memoryId.startsWith('native:')
    ? (getCurrentMemory(db, memoryId) || {})
    : {};
  const sourceLayer = String(row.source_layer || localRow.source_layer || (memoryId.startsWith('native:') ? 'native' : 'registry') || '').trim();
  const sourcePath = String(row.source_path || localRow.source_path || '').trim();
  const sourceHost = String(row.source_host || localRow.source_host || 'gigabrain').trim();
  const sourceKind = String(row.source_kind || localRow.source_kind || (memoryId.startsWith('native:') ? 'native_memory' : 'registry')).trim();
  const syncPolicy = String(row.sync_policy || localRow.sync_policy || 'read_only').trim();
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
    source_host: sourceHost,
    source_kind: sourceKind,
    sync_policy: syncPolicy,
    source_path: includeProvenance ? sourcePath : '',
    source_line: includeProvenance ? sourceLine : null,
    source_links: includeProvenance && memoryId && !memoryId.startsWith('native:')
      ? expandMemorySourceLinks(db, memoryId)
      : [],
    score: Number(row._score || row.score || 0),
    confidence: Number(row.confidence || localRow.confidence || 0),
    updated_at: String(row.updated_at || localRow.updated_at || '').trim(),
    created_at: String(row.created_at || localRow.created_at || '').trim(),
    memory_tier: String(row._memory_tier || row.memory_tier || '').trim(),
    // Stable relevance signals for the MCP-boundary floor. The internal
    // _-prefixed channels are stripped by this whitelist, so the floor's
    // inputs must be carried explicitly: raw dense cosine (absolute,
    // calibratable) and entity match. Borda _score stays ordering-only.
    relevance: {
      dense_cosine: Number.isFinite(Number(row._semantic_score)) ? Number(row._semantic_score) : null,
      entity_match: Number(row._entity_match || 0) === 1,
    },
    ...buildRowProvenanceFields(row, localRow, sourceHost || (memoryId.startsWith('native:') ? 'native' : 'gigabrain')),
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
  source_host: 'hermes',
  source_kind: 'native_memory',
  sync_policy: 'read_only',
  source_path: includeProvenance ? String(row.source_path || '').trim() : '',
  source_line: includeProvenance && Number.isFinite(Number(row.source_line)) ? Number(row.source_line) : null,
  source_links: [],
  score: Number(row.score || 0),
  confidence: Number(row.confidence || 0),
  updated_at: String(row.updated_at || '').trim(),
  created_at: String(row.created_at || '').trim(),
  memory_tier: '',
  // U15 schema parity: remote rows carry the same provenance keys; the bridge
  // payload supplies what it knows, host trust covers the rest.
  ...buildRowProvenanceFields(row, {}, 'hermes'),
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
  source_host: 'openclaw',
  source_kind: String(row.source_kind || 'native_memory').trim() || 'native_memory',
  sync_policy: 'read_only',
  source_path: includeProvenance ? String(row.source_path || '').trim() : '',
  source_line: includeProvenance && Number.isFinite(Number(row.line_start)) ? Number(row.line_start) : null,
  source_links: [],
  score: Number(row._score || row.score_total || row.score || 0),
  confidence: Number(row.confidence || 0.7),
  updated_at: String(row.updated_at || row.last_seen_at || '').trim(),
  created_at: String(row.created_at || row.first_seen_at || '').trim(),
    memory_tier: memoryTier || 'working_reference',
    // U15 schema parity: native chunks are first-party memory (host 'openclaw').
    ...buildRowProvenanceFields(row, { created_at: row.first_seen_at || null }, 'openclaw'),
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
      COALESCE(CASE WHEN linked.status = 'active' THEN linked.scope END, chunk.scope, CASE
        WHEN chunk.source_kind = 'curated' THEN 'shared'
        WHEN chunk.source_kind = 'memory_md' THEN 'profile:main'
        WHEN chunk.source_kind = 'vault' THEN 'profile:user'
        ELSE ''
      END) AS scope,
      chunk.linked_memory_id,
      linked.status AS linked_status,
      chunk.first_seen_at,
      chunk.last_seen_at,
      chunk.status
    FROM memory_native_chunks AS chunk
    LEFT JOIN memory_current AS linked
      ON linked.memory_id = chunk.linked_memory_id
    WHERE chunk.chunk_id = ?
      AND chunk.status = 'active'
      AND (linked.status IS NULL OR linked.status NOT IN ('superseded', 'rejected'))
    LIMIT 1
  `).get(chunkId) || null;
};

// Cross-store scores are pool-relative and cannot be compared directly. Fuse
// each store's ranking with reciprocal-rank fusion, then damp weak rows with
// query-token coverage or an absolute dense-cosine signal.
const RRF_K = 10;
const MERGE_QUALITY_FLOOR = 0.35;

const mergeRowQuality = (tokens, row) => {
  if (tokens.length === 0) return 1;
  const cosine = Number(row?.relevance?.dense_cosine);
  const dense = Number.isFinite(cosine) ? Math.max(0, Math.min(1, cosine)) : 0;
  const coverage = relevanceMatchedTokens(tokens, row?.content || '') / tokens.length;
  return Math.max(0, Math.min(1, Math.max(coverage, dense)));
};

const mergeAnnotatedResults = (batches = [], topK = 8, query = '') => {
  const tokens = relevanceQueryTokens(query);
  const byKey = new Map();
  const order = [];
  for (const batch of batches) {
    const rows = Array.isArray(batch?.results) ? batch.results : [];
    rows.forEach((row, index) => {
      const key = normalizeContent(row.content || '') || `${row.origin}:${row.memory_id}`;
      if (!key) return;
      const contribution = 1 / (RRF_K + index + 1);
      const prev = byKey.get(key);
      if (!prev) {
        byKey.set(key, { row, rrf: contribution, best: contribution });
        order.push(key);
        return;
      }
      prev.rrf += contribution;
      if (contribution > prev.best) {
        prev.best = contribution;
        prev.row = row;
      }
    });
  }
  return order
    .map((key) => {
      const entry = byKey.get(key);
      const quality = mergeRowQuality(tokens, entry.row);
      return {
        row: entry.row,
        fused: entry.rrf * (MERGE_QUALITY_FLOOR + ((1 - MERGE_QUALITY_FLOOR) * quality)),
      };
    })
    .sort((a, b) => b.fused - a.fused)
    .slice(0, topK)
    .map((entry) => entry.row);
};

const fetchRemoteJson = async ({
  baseUrl,
  token,
  pathname,
  method = 'GET',
  body = null,
  timeoutMs = 8000,
} = {}) => {
  const endpoint = buildHttpEndpoint(baseUrl, pathname, { label: 'remote bridge endpoint' });
  const response = await fetch(endpoint, {
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
  const scope = assertScopeAuthorized(resolveScopeForTarget(config, target, options.scope), options);
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
        remember_intent: true,
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
    const memoryId = String(writeRecord?.memory_id || summary.inserted_ids?.[0] || '').trim();
    const duplicateOf = String(writeRecord?.duplicate || '').trim();
    const effectiveMemoryId = memoryId || duplicateOf;
    const wroteAnything = Number(summary.native_written || 0) > 0 || Number(summary.inserted || 0) > 0;
    // Honest acknowledgement: ok:true used to be returned even when nothing
    // became recallable (intent parked in the review queue). Callers must be
    // able to tell committed from parked.
    let status = 'not_stored';
    if (memoryId || wroteAnything) status = 'committed';
    else if (duplicateOf) status = 'deduplicated';
    else if (Number(summary.queued_review || 0) > 0) status = 'pending_review';
    return {
      ok: true,
      status,
      recallable: status === 'committed' || status === 'deduplicated',
      target,
      type,
      durability,
      scope,
      // A deduplicated write is still recallable and must identify the existing
      // committed row. Promotion callers use this id to bind the terminal
      // proposal decision to the durable memory that satisfied the write.
      memory_id: effectiveMemoryId,
      written_native: Number(summary.native_written || 0) > 0,
      written_registry: Number(summary.inserted || 0) > 0,
      source_path: options.includeLocalPaths === false ? '' : String(writeRecord?.source_path || '').trim(),
      source_line: options.includeLocalPaths === false
        ? null
        : (Number.isFinite(Number(writeRecord?.source_line)) ? Number(writeRecord.source_line) : null),
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

  const scope = assertScopeAuthorized(resolveScopeForTarget(config, 'project', options.scope), options);
  const surface = detectCheckpointSurface(config, options.surface || options.sessionSurface || options.session_surface);
  const sessionLabel = String(options.sessionLabel || options.session_label || '').trim();
  const summary = String(options.summary || '').replace(/\s+/g, ' ').trim();
  const decisions = normalizeStringList(options.decisions);
  const openLoops = normalizeStringList(options.openLoops || options.open_loops);
  const touchedFiles = normalizeStringList(options.touchedFiles || options.touched_files);
  const durableCandidates = normalizeStringList(options.durableCandidates || options.durable_candidates);
  if (!summary && decisions.length === 0 && openLoops.length === 0 && touchedFiles.length === 0 && durableCandidates.length === 0) {
    throw new Error('checkpoint requires summary or at least one structured field');
  }

  const checkpointTimestamp = options.timestamp || new Date().toISOString();
  const sourceAgent = String(options.sourceAgent || options.source_agent || (surface === 'claude' ? 'claude_code' : surface)).trim() || 'unknown';
  const sessionId = String(options.sessionId || options.session_id || '').trim()
    || `ses_${hashRecord({
      date: String(checkpointTimestamp).slice(0, 10),
      surface,
      scope,
      label: sessionLabel || summary,
    }).slice(0, 24)}`;
  const prepared = openPreparedDb({
    config,
    syncNative: false,
    rebuildWorldOnNativeChange: false,
  });
  try {
    const existing = listCheckpointEpisodes(prepared.db, {
      scope,
      sessionId,
      limit: 1,
      includeLocalPaths: options.includeLocalPaths !== false,
    }).results[0];
    if (existing) {
      const receipt = appendMemoryReceipt(prepared.db, {
        createdAt: checkpointTimestamp,
        receiptType: 'checkpoint',
        status: 'deduplicated',
        scope,
        actorId: sourceAgent,
        actorHost: options.sourceHost || options.source_host,
        sessionId,
        outputRefs: [existing.checkpoint_id],
        summary: 'Checkpoint already exists for this session.',
      });
      return {
        ok: true,
        target: 'project',
        schema_version: existing.schema_version,
        checkpoint_id: existing.checkpoint_id,
        session_id: existing.session_id,
        receipt_id: receipt.receipt_id,
        proposal_ids: existing.proposal_ids,
        scope,
        session_label: String(existing.payload?.session_label || sessionLabel),
        deduplicated: true,
        written_native: false,
        source_path: options.includeLocalPaths === false ? '' : String(existing.source_ref?.path || ''),
        source_line: options.includeLocalPaths === false ? null : existing.source_ref?.line ?? null,
        source_kind: String(existing.source_ref?.kind || 'daily_note'),
        written_sections: [],
        item_count: 0,
        native_sync: { changed_files: 0, inserted_chunks: 0 },
      };
    }
    const writeResult = writeNativeSessionCheckpoint({
      config,
      timestamp: checkpointTimestamp,
      surface,
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

    const episode = appendCheckpointEpisode(prepared.db, {
      timestamp: checkpointTimestamp,
      sessionId,
      parentCheckpointId: options.parentCheckpointId || options.parent_checkpoint_id,
      scope,
      sourceAgent,
      sourceClient: surface,
      sourceHost: options.sourceHost || options.source_host,
      projectRoot: String(config?.codex?.projectRoot || '').trim(),
      summary,
      decisions,
      openLoops,
      touchedFiles,
      durableCandidates,
      evidence: options.evidence || options.evidenceRefs || options.evidence_refs,
      outcomeStatus: options.outcomeStatus || options.outcome_status,
      sourcePath: writeResult.source_path,
      sourceLine: writeResult.source_line,
      sourceKind: writeResult.source_kind || 'daily_note',
      payload: {
        session_label: sessionLabel,
        native_written: writeResult.written === true,
      },
    });
    return {
      ok: true,
      target: 'project',
      schema_version: episode.checkpoint.schema_version,
      checkpoint_id: episode.checkpoint.checkpoint_id,
      session_id: episode.checkpoint.session_id,
      receipt_id: episode.receipt_id,
      proposal_ids: episode.checkpoint.proposal_ids,
      scope,
      session_label: sessionLabel,
      deduplicated: false,
      written_native: writeResult.written === true,
      source_path: options.includeLocalPaths === false ? '' : String(writeResult.source_path || '').trim(),
      source_line: options.includeLocalPaths === false
        ? null
        : (Number.isFinite(Number(writeResult.source_line)) ? Number(writeResult.source_line) : null),
      source_kind: String(writeResult.source_kind || 'daily_note').trim(),
      written_sections: Array.isArray(writeResult.written_sections) ? writeResult.written_sections : [],
      item_count: Number(writeResult.item_count || 0),
      native_sync: nativeSync,
    };
  } finally {
    closeDbQuietly(prepared.db);
  }
};

// Relevance floor at the public boundary. Queries with at least four
// informative tokens require more than one lexical match; shorter queries
// still accept one. Dense cosine remains an absolute fallback signal.
// ---------------------------------------------------------------------------
const RELEVANCE_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'what', 'who', 'how', 'does', 'did', 'are', 'is',
  'was', 'were', 'this', 'that', 'from', 'into', 'about', 'app', 'user', 'und',
  'fuer', 'mit', 'der', 'die', 'das', 'wer', 'wie', 'ist', 'sind', 'dem', 'den',
  'ein', 'eine', 'auf', 'von', 'zur', 'zum', 'bei', 'nach', 'welche', 'welcher',
]);

const relevanceQueryTokens = (query) => Array.from(new Set(
  String(query || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token.length >= 3 && !RELEVANCE_STOPWORDS.has(token)),
));

const relevanceMatchedTokens = (tokens, text) => {
  if (tokens.length === 0) return 0;
  const haystack = String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  let hits = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) hits += 1;
  }
  return hits;
};

const resolveRelevanceFloor = (config = {}) => {
  const floor = config?.recall?.relevanceFloor || {};
  return {
    enabled: floor.enabled !== false,
    minMatchedTokens: Math.max(1, Number(floor.minMatchedTokens ?? 2) || 2),
    denseCosine: Math.max(0, Math.min(1, Number(floor.denseCosine ?? 0.65))),
  };
};

const applyRelevanceFloor = (query, rows, floor) => {
  const tokens = relevanceQueryTokens(query);
  const lexicalApplicable = tokens.length > 0;
  const requiredMatchedTokens = tokens.length >= 4
    ? Math.min(tokens.length, floor.minMatchedTokens)
    : 1;
  let topCosine = null;
  let topCoverage = 0;
  let denseAvailable = false;
  const evaluated = rows.map((row) => {
    const matched = relevanceMatchedTokens(tokens, row.content || '');
    const coverage = lexicalApplicable ? matched / tokens.length : 0;
    const cosine = Number.isFinite(Number(row?.relevance?.dense_cosine)) ? Number(row.relevance.dense_cosine) : null;
    if (cosine !== null) {
      denseAvailable = true;
      if (topCosine === null || cosine > topCosine) topCosine = cosine;
    }
    if (coverage > topCoverage) topCoverage = coverage;
    const accepted = !lexicalApplicable
      || matched >= requiredMatchedTokens
      || (cosine !== null && cosine >= floor.denseCosine);
    return {
      accepted,
      row: {
        ...row,
        relevance: {
          ...(row.relevance || {}),
          matched_tokens: matched,
          lexical_coverage: Number(coverage.toFixed(3)),
          accepted,
        },
      },
    };
  });
  return {
    results: evaluated.filter((entry) => entry.accepted).map((entry) => entry.row),
    diagnostics: {
      applied: true,
      min_matched_tokens: requiredMatchedTokens,
      dense_cosine_threshold: floor.denseCosine,
      query_tokens: tokens.length,
      candidates_considered: rows.length,
      top_dense_cosine: topCosine,
      top_lexical_coverage: Number(topCoverage.toFixed(3)),
      dense_available: denseAvailable,
    },
  };
};

const runRecall = async (options = {}) => {
  const context = loadCodexContext(options);
  const target = normalizeTarget(options.target, 'both');
  const query = String(options.query || '').trim();
  if (!query) throw new Error('query is required');
  const topK = Math.max(1, Math.min(25, Number(options.topK || 8) || 8));
  const includeProvenance = options.includeProvenance === true;
  const includeLocalPaths = options.includeLocalPaths !== false;
  const batches = [];
  let overallStrategy = '';
  let overallRankingMode = '';
  let usedWorldModel = false;
  let confidence = 0;
  const readQueries = resolveReadStoreQueries(context, target, options);

  for (const { storeTarget, config, scope, exactScope } of readQueries) {
    const prepared = openPreparedDb({
      config,
      syncNative: false,
      rebuildWorldOnNativeChange: false,
      allowMaintenance: false,
    });
    try {
      const recall = orchestrateRecall({
        db: prepared.db,
        // The caller's topK must reach ranking/budgeting: recall-service reads
        // config.recall.topK, and the MCP topK arg was previously accepted but
        // silently ignored (the bench adapter patched config to work around it).
        config: {
          ...config,
          recall: { ...(config.recall || {}), topK },
        },
        query,
        scope,
        scopeVisibility: {
          includeProfile: storeTarget === 'user' && !exactScope,
          includeShared: !exactScope,
          allowMaintenance: false,
        },
      });
      const results = (recall.results || []).map((row) => annotateLocalRecallRow(
        prepared.db,
        row,
        storeTarget,
        includeProvenance && includeLocalPaths,
      ));
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

  if (normalizedAuthorizedScopes(options).length === 0
    && resolveStoreOrder(context.projectConfig, target).includes('remote')
    && context.projectConfig?.remoteBridge?.enabled === true) {
    const remoteRecall = await recallRemoteBridge({
      config: context.projectConfig,
      query,
      scope: String(options.scope || '').trim(),
      topK,
    });
    if (remoteRecall) {
      batches.push({
        origin: 'remote',
        results: remoteRecall.results.map((row) => annotateRemoteRecallRow(row, includeProvenance && includeLocalPaths)),
      });
      if (!overallStrategy) overallStrategy = remoteRecall.strategy;
      if (!overallRankingMode) overallRankingMode = remoteRecall.rankingMode;
      usedWorldModel = usedWorldModel || remoteRecall.usedWorldModel === true;
      confidence = Math.max(confidence, Number(remoteRecall.confidence || 0));
    }
  }

  const merged = mergeAnnotatedResults(batches, topK, query);
  const floor = resolveRelevanceFloor(context.projectConfig);
  const floored = floor.enabled
    ? applyRelevanceFloor(query, merged, floor)
    : { results: merged, diagnostics: { applied: false } };
  const matchStatus = floored.results.length > 0 ? 'ok' : 'no_match';
  const response = {
    ok: true,
    query,
    target,
    strategy: overallStrategy || 'quick_context',
    ranking_mode: overallRankingMode || 'broad',
    used_world_model: usedWorldModel,
    confidence,
    match_status: matchStatus,
    relevance_floor: floored.diagnostics,
    guidance: matchStatus === 'no_match'
      ? 'No sufficiently relevant memory found; do not assume prior context.'
      : '',
    results: floored.results,
  };
  if (options.recordReceipt === true || options.record_receipt === true) {
    const receiptQuery = readQueries[0] || null;
    const receiptTarget = receiptQuery?.storeTarget || (target === 'user' ? 'user' : 'project');
    const receiptConfig = receiptQuery?.config || getTargetConfig(context, receiptTarget);
    if (receiptConfig) {
      const receiptScope = receiptQuery?.scope
        || assertScopeAuthorized(resolveScopeForTarget(receiptConfig, receiptTarget, options.scope), options);
      const prepared = openPreparedDb({
        config: receiptConfig,
        syncNative: false,
        rebuildWorldOnNativeChange: false,
        allowMaintenance: false,
      });
      try {
        const receipt = appendMemoryReceipt(prepared.db, {
          receiptType: 'recall',
          status: matchStatus === 'ok' ? 'supported' : 'no_match',
          scope: receiptScope,
          actorId: options.actorId || options.actor_id || options.sourceAgent || options.source_agent || 'mcp-client',
          actorHost: options.actorHost || options.actor_host || options.sourceHost || options.source_host,
          sessionId: options.sessionId || options.session_id,
          inputRefs: [`query:sha256:${hashRecord(query)}`],
          outputRefs: floored.results.map((row) => String(row.memory_id || '')).filter(Boolean),
          evidenceRefs: floored.results.map((row) => String(row.memory_id || '')).filter(Boolean),
          summary: matchStatus === 'ok'
            ? 'Recorded the evidence set returned by recall.'
            : 'Recorded a no-match recall outcome.',
          payload: {
            target,
            result_count: floored.results.length,
            ranking_mode: response.ranking_mode,
          },
        });
        response.receipt_id = receipt.receipt_id;
        response.policy_version = receipt.policy_version;
        response.ledger_snapshot = receipt.ledger_snapshot;
      } finally {
        closeDbQuietly(prepared.db);
      }
    }
  }
  return response;
};

const runProvenance = async (options = {}) => {
  const target = normalizeTarget(options.target, 'both');
  const includeLocalPaths = options.includeLocalPaths !== false;
  const memoryId = String(options.memoryId || options.memory_id || '').trim();
  if (memoryId) {
    const context = loadCodexContext(options);
    const batches = [];
    for (const {
      storeTarget,
      config,
      scope: lookupScope,
      exactScope,
    } of resolveReadStoreQueries(context, target, options)) {
      const prepared = openPreparedDb({
        config,
        syncNative: false,
        rebuildWorldOnNativeChange: false,
        allowMaintenance: !exactScope,
      });
      try {
        const row = getCurrentMemory(prepared.db, memoryId);
        if (row && rowVisibleForRequestedScope(row.scope, lookupScope, {
          includeProfile: !exactScope,
          includeShared: !exactScope,
        })) {
          batches.push({
            origin: storeTarget,
            results: [annotateLocalRecallRow(prepared.db, row, storeTarget, includeLocalPaths)],
          });
          continue;
        }
        const nativeRow = getNativeChunkByMemoryId(prepared.db, memoryId);
        if (!nativeRow) continue;
        // Never let an unscoped native row inherit the caller's authorized
        // scope. getNativeChunkByMemoryId resolves source-kind defaults; an
        // empty scope therefore remains unauthorized for an exact lookup.
        const nativeScope = String(nativeRow.scope || '').trim();
        if (!rowVisibleForRequestedScope(nativeScope, lookupScope, {
          includeProfile: !exactScope,
          includeShared: !exactScope,
        })) continue;
        batches.push({
          origin: storeTarget,
          results: [annotateNativeChunkRow(nativeRow, storeTarget, includeLocalPaths, lookupScope)],
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
  for (const {
    storeTarget,
    config,
    scope,
    exactScope,
  } of resolveReadStoreQueries(context, target, options)) {
    const prepared = openPreparedDb({
      config,
      syncNative: false,
      rebuildWorldOnNativeChange: false,
      allowMaintenance: !exactScope,
    });
    try {
      const registry = searchCurrentMemories(prepared.db, {
        query,
        scope,
        topK: 10,
        statuses: ['active'],
        includeProfile: !exactScope,
        includeShared: !exactScope,
      }).map((row) => annotateLocalRecallRow(prepared.db, row, storeTarget, includeLocalPaths));
      const native = queryNativeChunks({
        db: prepared.db,
        config,
        query,
        scope,
        includeShared: !exactScope,
        limit: 10,
      }).map((row) => annotateNativeChunkRow(row, storeTarget, includeLocalPaths, scope));
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
  for (const {
    storeTarget,
    config,
    scope,
    exactScope,
  } of resolveReadStoreQueries(context, target, options)) {
    const prepared = openPreparedDb({
      config,
      syncNative: false,
      rebuildWorldOnNativeChange: false,
      allowMaintenance: !exactScope,
    });
    try {
      const current = listCurrentMemories(prepared.db, {
        statuses: ['active'],
        scope,
        limit: Math.max(limit * 2, 20),
        includeProfile: !exactScope,
        includeShared: !exactScope,
      }).map((row) => annotateLocalRecallRow(
        prepared.db,
        row,
        storeTarget,
        options.includeLocalPaths !== false,
      ));
      rows.push(...current);
    } finally {
      closeDbQuietly(prepared.db);
    }
  }
  // Recency = event time, matching listCurrentMemories ordering. updated_at is
  // a physical row-mutation timestamp (maintenance passes rewrite it in bulk)
  // and must not drive "recent".
  const recentTime = (row) => Date.parse(String(row.content_time || row.valid_from || row.created_at || '')) || 0;
  rows.sort((a, b) => recentTime(b) - recentTime(a));
  return {
    ok: true,
    target,
    results: rows.slice(0, limit),
  };
};

const runSources = (options = {}) => {
  const context = loadCodexContext(options);
  const target = normalizeTarget(options.target, 'project');
  const stores = [];
  for (const storeTarget of resolveDoctorTargets(target)) {
    const config = getTargetConfig(context, storeTarget);
    if (!config) {
      stores.push({
        target: storeTarget,
        ok: false,
        sources: [],
        discovered: [],
        error: `target store '${storeTarget}' is not configured`,
      });
      continue;
    }
    const prepared = openPreparedDb({
      config,
      syncNative: false,
      rebuildWorldOnNativeChange: false,
    });
    try {
      stores.push({
        target: storeTarget,
        ...listMemorySources({
          db: prepared.db,
          config,
          includeDiscovery: options.includeDiscovery === true,
          hosts: options.hosts,
          codexHome: options.codexHome,
          claudeHome: options.claudeHome,
          workspaceRoot: options.workspaceRoot,
        }),
      });
    } finally {
      closeDbQuietly(prepared.db);
    }
  }
  return {
    ok: stores.every((store) => store.ok !== false),
    target,
    stores,
  };
};

const runSyncStatus = (options = {}) => {
  const context = loadCodexContext(options);
  const target = normalizeTarget(options.target, 'project');
  const stores = [];
  for (const storeTarget of resolveDoctorTargets(target)) {
    const config = getTargetConfig(context, storeTarget);
    if (!config) {
      stores.push({
        target: storeTarget,
        ok: false,
        hosts: [],
        error: `target store '${storeTarget}' is not configured`,
      });
      continue;
    }
    const prepared = openPreparedDb({
      config,
      syncNative: false,
      rebuildWorldOnNativeChange: false,
    });
    try {
      stores.push({
        target: storeTarget,
        ...getSyncStatus({
          db: prepared.db,
          config,
          hosts: options.hosts,
          codexHome: options.codexHome,
          claudeHome: options.claudeHome,
          workspaceRoot: options.workspaceRoot,
        }),
      });
    } finally {
      closeDbQuietly(prepared.db);
    }
  }
  return {
    ok: stores.every((store) => store.ok !== false),
    target,
    stores,
  };
};

const runExportBrief = (options = {}) => {
  const context = loadCodexContext(options);
  const target = normalizeTarget(options.target, 'project');
  if (target === 'both') throw new Error('export brief target must be project or user');
  const config = getTargetConfig(context, target);
  if (!config) throw new Error(`target store '${target}' is not configured`);
  const scope = assertScopeAuthorized(resolveScopeForTarget(config, target, options.scope), options);
  const prepared = openPreparedDb({
    config,
    syncNative: false,
    rebuildWorldOnNativeChange: false,
  });
  try {
    return {
      target,
      ...exportMemoryBrief({
        db: prepared.db,
        config,
        targetHost: options.targetHost || options.target_host,
        scope,
        limit: options.limit,
        allowAllScopes: options.allowAllScopes === true,
      }),
    };
  } finally {
    closeDbQuietly(prepared.db);
  }
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

// Runtime build provenance: every doctor response identifies which
// checkout or packaged build actually served the request.
const describeBuildProvenance = () => {
  const modulePath = fileURLToPath(import.meta.url);
  let commit = '';
  try {
    commit = execFileSync('git', ['-C', path.dirname(modulePath), 'rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { /* not a git checkout (packaged install) — commit stays '' */ }
  return { module_path: modulePath, commit };
};

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
    build: describeBuildProvenance(),
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

const runEntity = (options = {}) => {
  const context = loadCodexContext(options);
  const config = getTargetConfig(context, 'project');
  if (!config) throw new Error('project store is not configured');
  const prepared = openPreparedDb({ config, syncNative: false, rebuildWorldOnNativeChange: false });
  try {
    const entityId = String(options.entityId || options.entity_id || '').trim();
    if (!entityId) throw new Error('entity_id is required');

    const detail = getEntityDetail(prepared.db, entityId);
    if (!detail) return { ok: true, entity_id: entityId, entity: null, beliefs: [], episodes: [], evolution: [] };
    const {
      beliefs = [],
      episodes = [],
      open_loops: openLoops = [],
      syntheses = [],
      ...entity
    } = detail;

    const result = { ok: true, entity_id: entityId, entity };

    if (options.include_beliefs !== false || options.includeBeliefs !== false) {
      result.beliefs = beliefs;
    }

    result.episodes = episodes;
    result.open_loops = openLoops;
    result.syntheses = syntheses;

    if (options.include_evolution === true || options.includeEvolution === true) {
      result.evolution = getEntityEvolution(prepared.db, entityId);
    }

    return result;
  } finally {
    closeDbQuietly(prepared.db);
  }
};

const runContradictions = (options = {}) => {
  const context = loadCodexContext(options);
  const config = getTargetConfig(context, 'project');
  if (!config) throw new Error('project store is not configured');
  const prepared = openPreparedDb({ config, syncNative: false, rebuildWorldOnNativeChange: false });
  try {
    let contradictions = listContradictions(prepared.db);
    const entityId = String(options.entityId || options.entity_id || '').trim();
    if (entityId) {
      contradictions = contradictions.filter((row) => String(row.related_entity_id || '') === entityId);
    }
    if (options.include_suggestions === true || options.includeSuggestions === true) {
      const suggestions = suggestContradictionResolution(prepared.db);
      const sugMap = new Map(suggestions.map((row) => [row.loop_id, row]));
      contradictions = contradictions.map((row) => ({
        ...row,
        suggestion: sugMap.get(row.loop_id) || null,
      }));
    }
    return { ok: true, contradictions, total: contradictions.length };
  } finally {
    closeDbQuietly(prepared.db);
  }
};

// gigabrain_arbitrate (U12): expose the cross-store de-conflict verdict as a
// first-class, agent-callable surface. This REUSES the Phase-1 arbiter +
// arbitration ledger — it does not reimplement belief resolution. The world
// model build (ensureWorldModelReady, run by openPreparedDb) already runs
// consolidateBeliefRows + recordVerdict, persisting verdict/supersede events in
// memory_events and superseded_by/status on memory_current. Here we read those
// receipts back, optionally scoped to a subject/entity or claim slot, and
// return the winning belief + the losers it superseded + a `why` (the signals:
// trust tier, corroboration/support, recency) + provenance (source_agent).
//
// Agent-native parity: this is the same de-conflicted view a user sees in the
// Memory Audit, made callable by an agent. It reports verdicts only — it does
// NOT assert an unverified comparative benchmark claim.
const summarizeArbitrateContent = (value, limit = 200) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trim()}…`;
};

const describeMemoryForVerdict = (db, memoryId) => {
  const id = String(memoryId || '').trim();
  if (!id) return null;
  const row = getCurrentMemory(db, id);
  if (!row) {
    // The memory may have been pruned since the verdict was recorded; still
    // report the id + null provenance rather than dropping it.
    return { memory_id: id, content: '', source_agent: null, present: false };
  }
  return {
    memory_id: id,
    type: String(row.type || ''),
    content: summarizeArbitrateContent(row.content),
    source_agent: row.source_agent ? String(row.source_agent) : null,
    source: row.source ? String(row.source) : null,
    source_host: row.source_host ? String(row.source_host) : null,
    source_path: row.source_path ? String(row.source_path) : null,
    scope: row.scope ? String(row.scope) : null,
    claim_slot: row.claim_slot ? String(row.claim_slot) : null,
    confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : null,
    content_time: row.content_time || null,
    created_at: row.created_at || null,
    status: String(row.status || ''),
    superseded_by: row.superseded_by ? String(row.superseded_by) : null,
    present: true,
  };
};

const runArbitrate = (options = {}) => {
  const context = loadCodexContext(options);
  const config = getTargetConfig(context, 'project');
  if (!config) throw new Error('project store is not configured');
  // openPreparedDb runs ensureWorldModelReady(rebuildIfEmpty:true), which builds
  // the world model and records verdicts to the ledger when the world model is
  // enabled. U17: when it is disabled (config.worldModel.enabled === false) the
  // tool no longer degrades to an empty verdict set — arbitration runs through
  // the extracted belief-arbitration module instead (the toggle gates the
  // world-model SURFACES, never the verdicts).
  const prepared = openPreparedDb({ config, syncNative: false, rebuildWorldOnNativeChange: false });
  try {
    const worldModelEnabled = config?.worldModel?.enabled !== false;

    // Ensure the verdict ledger reflects the current memory state before we
    // report. openPreparedDb already builds-if-empty; here we additionally
    // refresh entity mentions + the projection so freshly ingested cross-store
    // memories that have not yet been arbitrated produce their verdicts. This
    // reuses the existing arbiter + recordVerdict ledger (it does not
    // reimplement resolution) and is idempotent: a repeat call does not append
    // duplicate verdict events. With the world model OFF the same belief rows
    // flow through belief-arbitration.js directly (U17).
    rebuildEntityMentions(prepared.db);
    if (worldModelEnabled) {
      rebuildWorldModel({ db: prepared.db, config });
    } else {
      runBeliefArbitration({ db: prepared.db, config, projectBeliefRows: projectArbitrationBeliefRows });
    }

    const subject = String(options.subject || options.entity || '').trim();
    const explicitEntityId = String(options.entityId || options.entity_id || '').trim();
    const slot = String(options.slot || options.claim_slot || '').trim();
    const limit = Math.max(1, Math.min(200, Number(options.limit || 50) || 50));

    // Resolve the subject scope: an explicit entity_id, else best-match by name.
    const subjectRequested = Boolean(subject || explicitEntityId);
    let resolvedEntity = null;
    if (explicitEntityId) {
      resolvedEntity = { entity_id: explicitEntityId, display_name: '', score: null };
    } else if (subject) {
      const matches = findEntityMatches(prepared.db, subject, { limit: 1 });
      if (matches.length > 0) resolvedEntity = matches[0];
    }

    // The set of memory_ids that belong to the subject (via its beliefs), used
    // to scope verdicts. null => no subject requested (slot/global only). An
    // empty set => a subject WAS requested but grounded to no memories, so the
    // result is intentionally empty (the subject doesn't match anything here).
    let subjectMemoryIds = null;
    if (resolvedEntity?.entity_id) {
      const beliefs = listBeliefs(prepared.db, { entityId: resolvedEntity.entity_id, limit: 1000 });
      subjectMemoryIds = new Set(
        beliefs.map((b) => String(b.source_memory_id || '').trim()).filter(Boolean),
      );
    } else if (subjectRequested) {
      subjectMemoryIds = new Set();
    }

    // Read the arbitration ledger: every recorded verdict, newest first.
    // event_id doubles as verdict_ref (U15): recall provenance stamps the SAME
    // id on winner rows, so an agent can correlate a recalled fact with the
    // verdict that de-conflicted it — one ledger, two views.
    const verdictRows = prepared.db.prepare(`
      SELECT event_id, memory_id AS winner_id, agent_id, reason_codes, payload, timestamp
      FROM memory_events
      WHERE action = 'arbiter:verdict'
      ORDER BY timestamp DESC, rowid DESC
    `).all();

    const verdicts = [];
    for (const eventRow of verdictRows) {
      const payload = (() => {
        try { return JSON.parse(String(eventRow.payload || '{}')); } catch { return {}; }
      })();
      const winnerId = String(payload.winnerId || eventRow.winner_id || '').trim();
      if (!winnerId) continue;
      const loserIds = (Array.isArray(payload.loserIds) ? payload.loserIds : [])
        .map((id) => String(id || '').trim())
        .filter(Boolean);

      const winner = describeMemoryForVerdict(prepared.db, winnerId);
      const losers = loserIds.map((id) => describeMemoryForVerdict(prepared.db, id)).filter(Boolean);

      // Subject (entity) scoping: when a subject was requested, keep only
      // verdicts touching one of its memories. A requested-but-ungrounded
      // subject (empty set) matches nothing. Slot scoping: keep verdicts whose
      // winner is in that slot.
      if (subjectMemoryIds) {
        const touchesSubject = subjectMemoryIds.size > 0
          && (subjectMemoryIds.has(winnerId) || loserIds.some((id) => subjectMemoryIds.has(id)));
        if (!touchesSubject) continue;
      }
      if (slot && String(winner?.claim_slot || '') !== slot) continue;

      const signals = payload.signals && typeof payload.signals === 'object' ? payload.signals : {};
      const reasonCodes = (() => {
        try { return JSON.parse(String(eventRow.reason_codes || '[]')); } catch { return []; }
      })();

      verdicts.push({
        // U15 parity: the ledger event id recall rows carry as verdict_ref.
        verdict_ref: String(eventRow.event_id || ''),
        winner,
        losers,
        // The `why`: the deterministic signals the arbiter resolved on, in
        // precedence order (trust tier > corroboration/support > recency).
        why: {
          rule: 'trust > corroboration > recency',
          trust_tier: Number.isFinite(Number(signals.maxTrust)) ? Number(signals.maxTrust) : null,
          corroboration_support: Number.isFinite(Number(signals.support)) ? Number(signals.support) : null,
          recency: Number.isFinite(Number(signals.recency)) ? Number(signals.recency) : null,
          // U13 records WHICH dimension decided and HOW positions clustered;
          // an agent needs both to explain a verdict (agent-native review F4).
          decided_by: signals.decided_by ? String(signals.decided_by) : null,
          clustering: signals.clustering && typeof signals.clustering === 'object' ? signals.clustering : null,
          reason_codes: reasonCodes,
        },
        // Provenance: source_agent per row (winner + each loser).
        provenance: {
          winner_agent: winner?.source_agent || (eventRow.agent_id ? String(eventRow.agent_id) : null),
          loser_agents: losers.map((l) => ({ memory_id: l.memory_id, source_agent: l.source_agent })),
        },
        recorded_at: eventRow.timestamp || null,
      });
      if (verdicts.length >= limit) break;
    }

    return {
      ok: true,
      subject: subject || null,
      entity_id: resolvedEntity?.entity_id || (explicitEntityId || null),
      entity_display_name: resolvedEntity?.display_name || null,
      slot: slot || null,
      world_model_enabled: worldModelEnabled,
      verdicts,
      total: verdicts.length,
      // Honest note: this tool reports recorded verdicts; it does not assert a
      // benchmark number or unverified comparative claim.
      note: 'Reports cross-store arbitration verdicts (de-conflicted winning belief + superseded losers + why + provenance). Does not assert any published benchmark number.',
    };
  } finally {
    closeDbQuietly(prepared.db);
  }
};

// U15 drill-down surfaces (agent-native review F2/F1): the write-time
// adjudication ledger and the bi-temporal as-of view become agent-callable.
// Both are thin reads over existing projection-store queries — no new
// resolution logic lives here.
const runListAdjudications = (options = {}) => {
  const context = loadCodexContext(options);
  const config = getTargetConfig(context, 'project');
  if (!config) throw new Error('project store is not configured');
  const prepared = openPreparedDb({ config, syncNative: false, rebuildWorldOnNativeChange: false });
  try {
    const memoryId = String(options.memoryId || options.memory_id || '').trim();
    const states = (Array.isArray(options.states) ? options.states : [])
      .map((item) => String(item || '').trim().toUpperCase())
      .filter(Boolean);
    const limit = Math.max(1, Math.min(1000, Number(options.limit || 100) || 100));
    const rows = listAdjudications(prepared.db, { memoryId, states, limit });
    return {
      ok: true,
      memory_id: memoryId || null,
      states: states.length > 0 ? states : null,
      adjudications: rows.map((row) => ({
        event_id: String(row.event_id || ''),
        timestamp: row.timestamp || null,
        memory_id: String(row.memory_id || ''),
        agent_id: row.agent_id ? String(row.agent_id) : null,
        state: String(row.state || ''),
        decision_op: String(row.payload?.decision_op || ''),
        candidate_content: summarizeArbitrateContent(row.payload?.candidate_content),
        confidence: Number.isFinite(Number(row.payload?.confidence)) ? Number(row.payload.confidence) : null,
        reason: String(row.payload?.reason || ''),
        scope: String(row.payload?.scope || ''),
      })),
      total: rows.length,
    };
  } finally {
    closeDbQuietly(prepared.db);
  }
};

const runBeliefsAsOf = (options = {}) => {
  const context = loadCodexContext(options);
  const config = getTargetConfig(context, 'project');
  if (!config) throw new Error('project store is not configured');
  const at = String(options.at || '').trim();
  if (!at || !Number.isFinite(Date.parse(at))) {
    throw new Error('beliefs_as_of requires a parseable ISO `at` timestamp');
  }
  const prepared = openPreparedDb({ config, syncNative: false, rebuildWorldOnNativeChange: false });
  try {
    const scope = String(options.scope || '').trim();
    const limit = Math.max(1, Math.min(1000, Number(options.limit || 200) || 200));
    const rows = listBeliefsAsOf(prepared.db, { at, scope, limit });
    return {
      ok: true,
      at,
      scope: scope || null,
      beliefs: rows.map((row) => ({
        memory_id: String(row.memory_id || ''),
        type: String(row.type || ''),
        content: summarizeArbitrateContent(row.content),
        scope: String(row.scope || ''),
        status: String(row.status || ''),
        confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : null,
        valid_from: row.valid_from || null,
        valid_until: row.valid_until || null,
        superseded_by: row.superseded_by ? String(row.superseded_by) : null,
        content_time: row.content_time || null,
      })),
      total: rows.length,
    };
  } finally {
    closeDbQuietly(prepared.db);
  }
};

// U16 read surface (agent-native review F3): the capture/maintenance review
// queue becomes agent-readable — the entries Gigabrain deliberately did NOT
// auto-resolve (U11 adjudication escalations, U13c contradiction ties, etc.).
// READ-ONLY this unit: resolving or acting on an entry is future scope and is
// intentionally not exposed here. File-based JSONL — no db handle needed.
const runReviewQueue = (options = {}) => {
  const context = loadCodexContext(options);
  const config = getTargetConfig(context, 'project');
  if (!config) throw new Error('project store is not configured');
  const queuePath = String(config?.runtime?.paths?.reviewQueuePath || '').trim();
  const status = String(options.status || 'pending').trim().toLowerCase();
  const reasonCode = String(options.reasonCode || options.reason_code || '').trim().toLowerCase();
  const limit = Math.max(1, Math.min(1000, Number(options.limit || 100) || 100));
  const listed = listQueueEntries(queuePath, { status, reasonCode, limit });
  return {
    ok: true,
    read_only: true,
    status: status || null,
    reason_code: reasonCode || null,
    entries: listed.entries.map((row) => ({
      status: String(row?.status || ''),
      reason: String(row?.reason || ''),
      reason_code: String(row?.reason_code || row?.reason || ''),
      action: String(row?.action || ''),
      queued_at: String(row?.queued_at || '').trim() || null,
      matched_memory_id: row?.matched_memory_id ? String(row.matched_memory_id) : null,
      scope: String(row?.payload?.scope || ''),
      excerpt: summarizeArbitrateContent(row?.payload?.excerpt || row?.payload?.content),
      decision_op: String(row?.payload?.op || row?.payload?.decision_op || ''),
      target_id: row?.payload?.target_id ? String(row.payload.target_id) : null,
      decision_confidence: Number.isFinite(Number(row?.payload?.decision_confidence))
        ? Number(row.payload.decision_confidence)
        : null,
      arbiter: row?.payload?.arbiter && typeof row.payload.arbiter === 'object' ? row.payload.arbiter : null,
    })),
    total: listed.total,
    malformed_rows: listed.malformed,
  };
};

const runRelationships = (options = {}) => {
  const context = loadCodexContext(options);
  const config = getTargetConfig(context, 'project');
  if (!config) throw new Error('project store is not configured');
  const prepared = openPreparedDb({ config, syncNative: false, rebuildWorldOnNativeChange: false });
  try {
    const entityId = String(options.entityId || options.entity_id || '').trim();
    const minEvidence = Math.max(1, Number(options.min_evidence || options.minEvidence || 1) || 1);
    const relationships = listRelationshipDetails(prepared.db, {
      entityId,
      minEvidence,
      limit: Number(options.limit || 200),
    });

    return { ok: true, relationships, total: relationships.length };
  } finally {
    closeDbQuietly(prepared.db);
  }
};

const openProjectControlPlane = (options = {}, settings = {}) => {
  const context = loadCodexContext(options);
  const config = getTargetConfig(context, 'project');
  if (!config) throw new Error('project store is not configured');
  const defaultScope = resolveScopeForTarget(config, 'project', options.scope);
  const scope = settings.authorizeScope === false ? defaultScope : assertScopeAuthorized(defaultScope, options);
  const prepared = openPreparedDb({
    config,
    syncNative: false,
    rebuildWorldOnNativeChange: false,
    // An authenticated remote read must be observational apart from its
    // explicit receipt write. In particular, listing/getting checkpoints may
    // not opportunistically rebuild a stale or empty world model.
    allowMaintenance: normalizedAuthorizedScopes(options).length === 0,
  });
  return { context, config, scope, prepared };
};

const runCheckpointList = (options = {}) => {
  const opened = openProjectControlPlane(options);
  try {
    const allowedScopes = normalizedAuthorizedScopes(options);
    const useAllLocalScopes = options.allScopes === true || options.all_scopes === true;
    const scope = useAllLocalScopes && allowedScopes.length === 0
      ? ''
      : (String(options.scope || '').trim() || (allowedScopes.length > 1 ? '' : opened.scope));
    const listed = listCheckpointEpisodes(opened.prepared.db, {
      scope,
      sourceAgent: options.sourceAgent || options.source_agent,
      sessionId: options.sessionId || options.session_id,
      repoCommit: options.repoCommit || options.repo_commit,
      since: options.since,
      until: options.until,
      limit: options.limit,
      cursor: options.cursor,
      allowedScopes,
      includeLocalPaths: allowedScopes.length === 0
        && options.includeLocalPaths !== false
        && options.include_local_paths !== false,
    });
    return {
      ok: true,
      target: 'project',
      scope: scope || null,
      schema_version: listed.schema_version,
      checkpoints: listed.results,
      next_cursor: listed.next_cursor,
    };
  } finally {
    closeDbQuietly(opened.prepared.db);
  }
};

const runCheckpointGet = (options = {}) => {
  const checkpointId = String(options.checkpointId || options.checkpoint_id || '').trim();
  if (!checkpointId) throw new Error('checkpoint_id is required');
  const opened = openProjectControlPlane(options);
  try {
    const authorized = normalizedAuthorizedScopes(options);
    const allowedScopes = authorized.length > 0 ? authorized : [opened.scope];
    const checkpoint = getCheckpointEpisode(opened.prepared.db, checkpointId, {
      allowedScopes,
      includeLocalPaths: authorized.length === 0
        && options.includeLocalPaths !== false
        && options.include_local_paths !== false,
    });
    if (!checkpoint) throw new Error('checkpoint not found or not authorized');
    return {
      ok: true,
      target: 'project',
      checkpoint,
    };
  } finally {
    closeDbQuietly(opened.prepared.db);
  }
};

const runClaimPropose = (options = {}) => {
  const opened = openProjectControlPlane(options);
  try {
    const proposal = appendClaimProposal(opened.prepared.db, {
      checkpointId: options.checkpointId || options.checkpoint_id,
      checkpointItemId: options.checkpointItemId || options.checkpoint_item_id,
      scope: opened.scope,
      claimType: normalizeType(options.claimType || options.claim_type || options.type, 'CONTEXT'),
      content: options.content,
      evidenceClass: options.evidenceClass || options.evidence_class,
      evidenceRefs: options.evidenceRefs || options.evidence_refs,
      sourceAgent: options.sourceAgent || options.source_agent || 'mcp-client',
      sourceHost: options.sourceHost || options.source_host,
      confidence: options.confidence,
      validFrom: options.validFrom || options.valid_from,
      validUntil: options.validUntil || options.valid_until,
      payload: {
        promotion: 'manual_review_required',
        ...(options.payload && typeof options.payload === 'object' ? options.payload : {}),
      },
    });
    return {
      ok: true,
      status: 'proposed',
      recallable: false,
      proposal,
      receipt_id: proposal.receipt_id,
    };
  } finally {
    closeDbQuietly(opened.prepared.db);
  }
};

const runClaimReview = (options = {}) => {
  const opened = openProjectControlPlane(options);
  try {
    const authorized = normalizedAuthorizedScopes(options);
    const proposals = listClaimProposals(opened.prepared.db, {
      scope: String(options.scope || '').trim() || (authorized.length > 1 ? '' : opened.scope),
      statuses: options.statuses || options.status,
      limit: options.limit,
      allowedScopes: authorized,
    });
    return {
      ok: true,
      read_only: true,
      proposals,
      total: proposals.length,
    };
  } finally {
    closeDbQuietly(opened.prepared.db);
  }
};

const assertPromotionPreconditions = (proposal, options = {}) => {
  const reason = String(options.reason || '').trim();
  if (!reason) throw new Error('claim decisions require a reason');
  const authenticatedAuthority = options.authorization && typeof options.authorization === 'object'
    ? String(options.authorization.authority || '').trim().toLowerCase()
    : '';
  const authority = authenticatedAuthority || (
    options.authorization && typeof options.authorization === 'object'
      ? ''
      : String(options.authority || '').trim().toLowerCase()
  );
  if (proposal.evidence_class === 'owner_assertion') {
    if (authority !== 'owner' && authority !== 'delegated_owner') {
      throw new Error('owner_assertion promotion requires owner authority');
    }
  }
  if (proposal.evidence_class === 'agent_inference'
    && proposal.evidence_refs.length === 0
    && authority !== 'owner'
    && authority !== 'delegated_owner') {
    throw new Error('unevidenced agent_inference promotion requires owner authority');
  }
  if (proposal.evidence_class === 'project_decision' && proposal.claim_type !== 'DECISION') {
    throw new Error('project_decision proposals must use claim_type DECISION');
  }
  if (['operational_observation', 'evaluation_result', 'external_reference'].includes(proposal.evidence_class)
    && proposal.evidence_refs.length === 0) {
    throw new Error(`${proposal.evidence_class} promotion requires evidence_refs`);
  }
};

const runClaimDecide = (options = {}) => {
  const proposalId = String(options.proposalId || options.proposal_id || '').trim();
  if (!proposalId) throw new Error('proposal_id is required');
  const action = String(options.action || '').trim().toLowerCase();
  if (!['accepted', 'rejected', 'superseded'].includes(action)) {
    throw new Error('action must be accepted, rejected, or superseded');
  }
  const opened = openProjectControlPlane(options);
  let proposal;
  try {
    const authorized = normalizedAuthorizedScopes(options);
    proposal = getClaimProposal(opened.prepared.db, proposalId, {
      allowedScopes: authorized.length > 0 ? authorized : [opened.scope],
    });
    if (!proposal) throw new Error('claim proposal not found or not authorized');
  } finally {
    closeDbQuietly(opened.prepared.db);
  }

  let memoryResult = null;
  if (action === 'accepted') {
    assertPromotionPreconditions(proposal, options);
    memoryResult = runRemember({
      ...options,
      target: 'project',
      scope: proposal.scope,
      content: proposal.content,
      type: proposal.claim_type,
      durability: options.durability || 'durable',
      confidence: options.confidence ?? proposal.confidence ?? 0.9,
    });
    if (memoryResult.recallable !== true || !memoryResult.memory_id) {
      throw new Error(`claim was not committed; remember status=${memoryResult.status || 'unknown'}`);
    }
  }

  const reopened = openProjectControlPlane({ ...options, scope: proposal.scope });
  try {
    const decision = appendClaimDecision(reopened.prepared.db, {
      proposalId,
      action,
      reason: options.reason,
      memoryId: memoryResult?.memory_id || options.memoryId || options.memory_id,
      actorId: options.actorId || options.actor_id || options.sourceAgent || options.source_agent || 'mcp-client',
      actorHost: options.actorHost || options.actor_host || options.sourceHost || options.source_host,
      allowedScopes: normalizedAuthorizedScopes(options),
    });
    return {
      ok: true,
      action,
      proposal_id: proposalId,
      memory: memoryResult,
      ...decision,
    };
  } finally {
    closeDbQuietly(reopened.prepared.db);
  }
};

const runReceiptWrite = (options = {}) => {
  const opened = openProjectControlPlane(options);
  try {
    const status = String(options.status || '').trim().toLowerCase() || 'recorded';
    const evidenceRefs = normalizeStringList(options.evidenceRefs || options.evidence_refs);
    if (status === 'supported' && evidenceRefs.length === 0) {
      throw new Error('supported receipts require at least one evidence_ref');
    }
    const receipt = appendMemoryReceipt(opened.prepared.db, {
      receiptType: options.receiptType || options.receipt_type || 'answer',
      status,
      scope: opened.scope,
      actorId: options.actorId || options.actor_id || options.sourceAgent || options.source_agent || 'mcp-client',
      actorHost: options.actorHost || options.actor_host || options.sourceHost || options.source_host,
      sessionId: options.sessionId || options.session_id,
      inputRefs: options.inputRefs || options.input_refs,
      outputRefs: options.outputRefs || options.output_refs,
      evidenceRefs,
      summary: options.summary,
      payload: options.payload,
    });
    return { ok: true, receipt };
  } finally {
    closeDbQuietly(opened.prepared.db);
  }
};

const runReceiptGet = (options = {}) => {
  const receiptId = String(options.receiptId || options.receipt_id || '').trim();
  if (!receiptId) throw new Error('receipt_id is required');
  const opened = openProjectControlPlane(options);
  try {
    const authorized = normalizedAuthorizedScopes(options);
    const receipt = getMemoryReceipt(opened.prepared.db, receiptId, {
      allowedScopes: authorized.length > 0 ? authorized : [opened.scope],
    });
    if (!receipt) throw new Error('receipt not found or not authorized');
    return { ok: true, receipt };
  } finally {
    closeDbQuietly(opened.prepared.db);
  }
};

export {
  loadCodexContext,
  bootstrapStandaloneStore,
  runCheckpoint,
  runRemember,
  runRecall,
  runProvenance,
  runRecent,
  runSources,
  runSyncStatus,
  runExportBrief,
  runDoctor,
  runEntity,
  runContradictions,
  runArbitrate,
  runListAdjudications,
  runBeliefsAsOf,
  runReviewQueue,
  runRelationships,
  runCheckpointList,
  runCheckpointGet,
  runClaimPropose,
  runClaimReview,
  runClaimDecide,
  runReceiptWrite,
  runReceiptGet,
  mergeAnnotatedResults,
  resolveReadStoreQueries,
};
