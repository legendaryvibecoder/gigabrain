import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_DURABLE_PATTERNS_BASE,
  DEFAULT_HIGH_VALUE_SHORT_PATTERNS_BASE,
  DEFAULT_JUNK_PATTERNS_BASE,
} from './policy.js';

const FORBIDDEN_LEGACY_KEYS = Object.freeze([
  'memoryRegistryPath',
  'ollamaUrl',
  'translationModel',
  'captureWriteMode',
  'captureEnabled',
  'memoryJunkPatterns',
  'memoryJunkPatternsAppend',
  'memoryJunkPatternsReplace',
  'memoryHighValueShortPatterns',
  'memoryHighValueShortPatternsAppend',
  'memoryDurablePatterns',
  'memoryDurablePatternsAppend',
  'memoryMinContentChars',
  'memoryMinConfidence',
  'memoryReviewEnabled',
  'memoryArchiveEnabled',
  'memoryQualityMode',
  'memoryValueThresholds',
  'memoryReviewSampling',
]);

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  runtime: {
    timezone: 'local',
    cleanupVersion: 'v3.0.0',
    paths: {
      workspaceRoot: '',
      memoryRoot: 'memory',
      registryPath: '',
      outputDir: 'output',
      reviewQueuePath: 'output/memory-review-queue.jsonl',
    },
    reviewQueueRetention: {
      enabled: true,
      keepPendingOnly: true,
      requireExcerptForPending: true,
      maxRows: 2000,
      maxPendingRows: 600,
      maxNonPendingRows: 0,
      maxPendingAgeDays: 21,
      relevantReasons: [
        'llm_unavailable',
        'capture_note_parse_failed',
        'semantic_borderline',
        'capture_parse_failed',
        'duplicate_semantic',
        'capture_review_required',
      ],
    },
  },
  capture: {
    enabled: true,
    requireMemoryNote: true,
    minConfidence: 0.65,
    minContentChars: 25,
    queueOnModelUnavailable: true,
  },
  dedupe: {
    exactEnabled: true,
    semanticEnabled: true,
    autoThreshold: 0.92,
    reviewThreshold: 0.85,
    crossScopeGlobal: false,
  },
  recall: {
    topK: 8,
    minScore: 0.45,
    maxTokens: 1200,
    archiveFallbackEnabled: true,
    mode: 'hybrid',
    classBudgets: {
      core: 0.45,
      situational: 0.3,
      decisions: 0.25,
    },
  },
  quality: {
    mode: 'knowledge_rich',
    junkFilterEnabled: true,
    minContentChars: 25,
    junkPatternsBase: [...DEFAULT_JUNK_PATTERNS_BASE],
    junkPatternsAppend: [],
    junkPatternsReplace: false,
    highValueShortEnabled: true,
    highValueShortPatternsBase: [...DEFAULT_HIGH_VALUE_SHORT_PATTERNS_BASE],
    highValueShortPatternsAppend: [],
    durableEnabled: true,
    durablePatternsBase: [...DEFAULT_DURABLE_PATTERNS_BASE],
    durablePatternsAppend: [],
    valueThresholds: {
      keep: 0.75,
      archive: 0.45,
      reject: 0.45,
    },
  },
  llm: {
    provider: 'none',
    baseUrl: '',
    model: '',
    apiKey: '',
    timeoutMs: 12000,
    review: {
      enabled: false,
      limit: 200,
      minScore: 0.24,
      maxScore: 0.52,
      minConfidence: 0.7,
    },
  },
  maintenance: {
    snapshotDir: 'memory/backups',
    eventsPath: 'output/memory-events.jsonl',
    usageLogPath: 'memory/usage-log.md',
    compactDays: 30,
    emergencyUnvacuumedDays: 7,
    maxEmergencyFiles: 1,
    vacuum: true,
    harmonize: {
      enabled: false,
      outPath: 'memory/gigabrain-harmonized.md',
      statuses: ['active', 'archived'],
      maxRows: 420,
      perTypeLimit: 120,
      minConfidence: 0,
      syncNative: true,
      includeInNative: true,
      backup: true,
    },
  },
  native: {
    enabled: true,
    memoryMdPath: 'MEMORY.md',
    dailyNotesGlob: 'memory/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*.md',
    includeFiles: [
      'memory/latest.md',
      'memory/recent-changes.md',
      'memory/whois.md',
      'memory/pinned-core-people.md',
      'memory/pinned/core-people.md',
      'memory/gigabrain-harmonized.md',
    ],
    excludeGlobs: [
      'memory/archive/**',
      'memory/debug/**',
      'memory/private/**',
      'memory/working.md',
      'memory/*-captured.md',
    ],
    syncMode: 'hybrid',
    maxChunkChars: 900,
    onDemandTemporalDays: 3650,
    sparkAdvisory: {
      dedupeEnabled: true,
      maxChunks: 260,
      nearDuplicateThreshold: 0.9,
    },
  },
  person: {
    keepPublicFacts: true,
    relationshipPriorityBoost: 0.35,
    publicProfileBoost: 0.1,
    requireWordBoundaryMatch: true,
  },
});

const V3_CONFIG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    enabled: { type: 'boolean', default: true },
    runtime: {
      type: 'object',
      additionalProperties: false,
      properties: {
        timezone: { type: 'string', default: 'local' },
        cleanupVersion: { type: 'string', default: 'v3.0.0' },
        paths: {
          type: 'object',
          additionalProperties: false,
          properties: {
            workspaceRoot: { type: 'string' },
            memoryRoot: { type: 'string', default: 'memory' },
            registryPath: { type: 'string' },
            outputDir: { type: 'string', default: 'output' },
            reviewQueuePath: { type: 'string', default: 'output/memory-review-queue.jsonl' },
          },
        },
        reviewQueueRetention: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean', default: true },
            keepPendingOnly: { type: 'boolean', default: true },
            requireExcerptForPending: { type: 'boolean', default: true },
            maxRows: { type: 'number', default: 2000 },
            maxPendingRows: { type: 'number', default: 600 },
            maxNonPendingRows: { type: 'number', default: 0 },
            maxPendingAgeDays: { type: 'number', default: 21 },
            relevantReasons: {
              type: 'array',
              items: { type: 'string' },
              default: [
                'llm_unavailable',
                'capture_note_parse_failed',
                'semantic_borderline',
                'capture_parse_failed',
                'duplicate_semantic',
                'capture_review_required',
              ],
            },
          },
        },
      },
    },
    capture: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', default: true },
        requireMemoryNote: { type: 'boolean', default: true },
        minConfidence: { type: 'number', default: 0.65 },
        minContentChars: { type: 'number', default: 25 },
        queueOnModelUnavailable: { type: 'boolean', default: true },
      },
    },
    dedupe: {
      type: 'object',
      additionalProperties: false,
      properties: {
        exactEnabled: { type: 'boolean', default: true },
        semanticEnabled: { type: 'boolean', default: true },
        autoThreshold: { type: 'number', default: 0.92 },
        reviewThreshold: { type: 'number', default: 0.85 },
        crossScopeGlobal: { type: 'boolean', default: false },
      },
    },
    recall: {
      type: 'object',
      additionalProperties: false,
      properties: {
        topK: { type: 'number', default: 8 },
        minScore: { type: 'number', default: 0.45 },
        maxTokens: { type: 'number', default: 1200 },
        archiveFallbackEnabled: { type: 'boolean', default: true },
        mode: { type: 'string', enum: ['personal_core', 'project_context', 'hybrid'], default: 'hybrid' },
        classBudgets: {
          type: 'object',
          additionalProperties: false,
          properties: {
            core: { type: 'number', default: 0.45 },
            situational: { type: 'number', default: 0.3 },
            decisions: { type: 'number', default: 0.25 },
          },
        },
      },
    },
    quality: {
      type: 'object',
      additionalProperties: false,
      properties: {
        mode: { type: 'string', enum: ['knowledge_rich'], default: 'knowledge_rich' },
        junkFilterEnabled: { type: 'boolean', default: true },
        minContentChars: { type: 'number', default: 25 },
        junkPatternsBase: { type: 'array', items: { type: 'string' }, default: [...DEFAULT_JUNK_PATTERNS_BASE] },
        junkPatternsAppend: { type: 'array', items: { type: 'string' }, default: [] },
        junkPatternsReplace: { type: 'boolean', default: false },
        highValueShortEnabled: { type: 'boolean', default: true },
        highValueShortPatternsBase: { type: 'array', items: { type: 'string' }, default: [...DEFAULT_HIGH_VALUE_SHORT_PATTERNS_BASE] },
        highValueShortPatternsAppend: { type: 'array', items: { type: 'string' }, default: [] },
        durableEnabled: { type: 'boolean', default: true },
        durablePatternsBase: { type: 'array', items: { type: 'string' }, default: [...DEFAULT_DURABLE_PATTERNS_BASE] },
        durablePatternsAppend: { type: 'array', items: { type: 'string' }, default: [] },
        valueThresholds: {
          type: 'object',
          additionalProperties: false,
          properties: {
            keep: { type: 'number', default: 0.75 },
            archive: { type: 'number', default: 0.45 },
            reject: { type: 'number', default: 0.45 },
          },
        },
      },
    },
    llm: {
      type: 'object',
      additionalProperties: false,
      properties: {
        provider: { type: 'string', enum: ['openclaw', 'openai_compatible', 'ollama', 'none'], default: 'none' },
        baseUrl: { type: 'string' },
        model: { type: 'string' },
        apiKey: { type: 'string' },
        timeoutMs: { type: 'number', default: 12000 },
        review: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean', default: false },
            limit: { type: 'number', default: 200 },
            minScore: { type: 'number', default: 0.24 },
            maxScore: { type: 'number', default: 0.52 },
            minConfidence: { type: 'number', default: 0.7 },
          },
        },
      },
    },
    maintenance: {
      type: 'object',
      additionalProperties: false,
      properties: {
        snapshotDir: { type: 'string', default: 'memory/backups' },
        eventsPath: { type: 'string', default: 'output/memory-events.jsonl' },
        usageLogPath: { type: 'string', default: 'memory/usage-log.md' },
        compactDays: { type: 'number', default: 30 },
        emergencyUnvacuumedDays: { type: 'number', default: 7 },
        maxEmergencyFiles: { type: 'number', default: 1 },
        vacuum: { type: 'boolean', default: true },
        harmonize: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean', default: false },
            outPath: { type: 'string', default: 'memory/gigabrain-harmonized.md' },
            statuses: {
              type: 'array',
              items: { type: 'string' },
              default: ['active', 'archived'],
            },
            maxRows: { type: 'number', default: 420 },
            perTypeLimit: { type: 'number', default: 120 },
            minConfidence: { type: 'number', default: 0 },
            syncNative: { type: 'boolean', default: true },
            includeInNative: { type: 'boolean', default: true },
            backup: { type: 'boolean', default: true },
          },
        },
      },
    },
    native: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', default: true },
        memoryMdPath: { type: 'string', default: 'MEMORY.md' },
        dailyNotesGlob: { type: 'string', default: 'memory/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*.md' },
        includeFiles: {
          type: 'array',
          items: { type: 'string' },
          default: ['memory/latest.md', 'memory/recent-changes.md', 'memory/whois.md', 'memory/pinned-core-people.md', 'memory/pinned/core-people.md', 'memory/gigabrain-harmonized.md'],
        },
        excludeGlobs: {
          type: 'array',
          items: { type: 'string' },
          default: ['memory/archive/**', 'memory/debug/**', 'memory/private/**', 'memory/working.md', 'memory/*-captured.md'],
        },
        syncMode: { type: 'string', enum: ['hybrid'], default: 'hybrid' },
        maxChunkChars: { type: 'number', default: 900 },
        onDemandTemporalDays: { type: 'number', default: 3650 },
        sparkAdvisory: {
          type: 'object',
          additionalProperties: false,
          properties: {
            dedupeEnabled: { type: 'boolean', default: true },
            maxChunks: { type: 'number', default: 260 },
            nearDuplicateThreshold: { type: 'number', default: 0.9 },
          },
        },
      },
    },
    person: {
      type: 'object',
      additionalProperties: false,
      properties: {
        keepPublicFacts: { type: 'boolean', default: true },
        relationshipPriorityBoost: { type: 'number', default: 0.35 },
        publicProfileBoost: { type: 'number', default: 0.1 },
        requireWordBoundaryMatch: { type: 'boolean', default: true },
      },
    },
  },
};

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));
const clampInt = (value, min, max, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
};

const isObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const normalizeStringArray = (value) => (
  Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : []
);

const deepMerge = (base, override) => {
  if (!isObject(base)) return override;
  if (!isObject(override)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (isObject(value) && isObject(out[key])) out[key] = deepMerge(out[key], value);
    else out[key] = value;
  }
  return out;
};

const resolvePathMaybeRelative = (workspaceRoot, value, fallback = '') => {
  const raw = String(value || fallback || '').trim();
  if (!raw) return '';
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(workspaceRoot, raw);
};

const resolveWorkspaceRoot = (config = {}, fallback = process.cwd()) => {
  const configured = String(config?.runtime?.paths?.workspaceRoot || '').trim();
  if (configured) return path.resolve(configured);
  const envWorkspace = String(process.env.OPENCLAW_WORKSPACE || '').trim();
  if (envWorkspace) return path.resolve(envWorkspace);
  return path.resolve(fallback || process.cwd());
};

const assertNoLegacyKeys = (config = {}) => {
  const found = FORBIDDEN_LEGACY_KEYS.filter((key) => Object.prototype.hasOwnProperty.call(config || {}, key));
  if (found.length === 0) return;
  throw new Error(
    `Gigabrain v3 config rejects deprecated keys: ${found.join(', ')}. Run scripts/migrate-v3.js --apply to migrate.`,
  );
};

const normalizeBudgets = (budgets = {}) => {
  const core = Math.max(0, Number(budgets.core ?? 0.45) || 0);
  const situational = Math.max(0, Number(budgets.situational ?? 0.3) || 0);
  const decisions = Math.max(0, Number(budgets.decisions ?? 0.25) || 0);
  const total = core + situational + decisions;
  if (total <= 0) return { core: 0.45, situational: 0.3, decisions: 0.25 };
  return {
    core: core / total,
    situational: situational / total,
    decisions: decisions / total,
  };
};

const normalizeConfig = (rawConfig = {}, options = {}) => {
  assertNoLegacyKeys(rawConfig);
  const merged = deepMerge(DEFAULT_CONFIG, rawConfig || {});
  const workspaceRoot = resolveWorkspaceRoot(merged, options.workspaceRoot || process.cwd());
  const memoryRoot = resolvePathMaybeRelative(workspaceRoot, merged?.runtime?.paths?.memoryRoot, 'memory');
  const outputDir = resolvePathMaybeRelative(workspaceRoot, merged?.runtime?.paths?.outputDir, 'output');
  const registryPath = resolvePathMaybeRelative(workspaceRoot, merged?.runtime?.paths?.registryPath, path.join(memoryRoot, 'registry.sqlite'));
  const reviewQueuePath = resolvePathMaybeRelative(workspaceRoot, merged?.runtime?.paths?.reviewQueuePath, path.join(outputDir, 'memory-review-queue.jsonl'));

  const cleanupVersion = String(merged?.runtime?.cleanupVersion || 'v3.0.0').trim() || 'v3.0.0';
  const timezone = String(merged?.runtime?.timezone || 'local').trim() || 'local';

  const dedupeAuto = clamp01(merged?.dedupe?.autoThreshold ?? 0.92);
  const dedupeReview = clamp01(merged?.dedupe?.reviewThreshold ?? 0.85);
  const valueKeep = clamp01(merged?.quality?.valueThresholds?.keep ?? 0.75);
  const valueArchive = clamp01(merged?.quality?.valueThresholds?.archive ?? 0.45);
  const valueReject = clamp01(merged?.quality?.valueThresholds?.reject ?? valueArchive);
  const configuredIncludeFiles = normalizeStringArray(merged?.native?.includeFiles)
    .map((item) => resolvePathMaybeRelative(workspaceRoot, item));
  const defaultIncludeFiles = normalizeStringArray(DEFAULT_CONFIG.native.includeFiles)
    .map((item) => resolvePathMaybeRelative(workspaceRoot, item));
  const nativeIncludeFiles = Array.from(new Set([...configuredIncludeFiles, ...defaultIncludeFiles])).filter(Boolean);
  const nativeExcludeGlobs = normalizeStringArray(merged?.native?.excludeGlobs || DEFAULT_CONFIG.native.excludeGlobs);
  const queueRetentionReasons = normalizeStringArray(merged?.runtime?.reviewQueueRetention?.relevantReasons);
  const harmonizeAllowedStatuses = new Set(['active', 'archived', 'rejected', 'superseded']);
  const harmonizeStatusesRaw = normalizeStringArray(merged?.maintenance?.harmonize?.statuses)
    .map((item) => item.toLowerCase());
  const harmonizeStatuses = harmonizeStatusesRaw.filter((item) => harmonizeAllowedStatuses.has(item));
  const sparkNearThresholdRaw = merged?.native?.sparkAdvisory?.nearDuplicateThreshold;
  const sparkNearThreshold = Number.isFinite(Number(sparkNearThresholdRaw))
    ? clamp01(sparkNearThresholdRaw)
    : Number(DEFAULT_CONFIG.native.sparkAdvisory.nearDuplicateThreshold);

  const out = {
    ...merged,
    runtime: {
      ...merged.runtime,
      timezone,
      cleanupVersion,
      paths: {
        workspaceRoot,
        memoryRoot,
        registryPath,
        outputDir,
        reviewQueuePath,
      },
      reviewQueueRetention: {
        ...merged?.runtime?.reviewQueueRetention,
        enabled: merged?.runtime?.reviewQueueRetention?.enabled !== false,
        keepPendingOnly: merged?.runtime?.reviewQueueRetention?.keepPendingOnly !== false,
        requireExcerptForPending: merged?.runtime?.reviewQueueRetention?.requireExcerptForPending !== false,
        maxRows: clampInt(
          merged?.runtime?.reviewQueueRetention?.maxRows,
          10,
          200000,
          Number(DEFAULT_CONFIG.runtime.reviewQueueRetention.maxRows),
        ),
        maxPendingRows: clampInt(
          merged?.runtime?.reviewQueueRetention?.maxPendingRows,
          1,
          200000,
          Number(DEFAULT_CONFIG.runtime.reviewQueueRetention.maxPendingRows),
        ),
        maxNonPendingRows: clampInt(
          merged?.runtime?.reviewQueueRetention?.maxNonPendingRows,
          0,
          200000,
          Number(DEFAULT_CONFIG.runtime.reviewQueueRetention.maxNonPendingRows),
        ),
        maxPendingAgeDays: clampInt(
          merged?.runtime?.reviewQueueRetention?.maxPendingAgeDays,
          1,
          3650,
          Number(DEFAULT_CONFIG.runtime.reviewQueueRetention.maxPendingAgeDays),
        ),
        relevantReasons: queueRetentionReasons.length > 0
          ? queueRetentionReasons
          : [...DEFAULT_CONFIG.runtime.reviewQueueRetention.relevantReasons],
      },
    },
    capture: {
      ...merged.capture,
      minConfidence: clamp01(merged?.capture?.minConfidence ?? 0.65),
      minContentChars: Math.max(1, Number(merged?.capture?.minContentChars ?? merged?.quality?.minContentChars ?? 25)),
    },
    dedupe: {
      ...merged.dedupe,
      autoThreshold: Math.max(dedupeAuto, dedupeReview),
      reviewThreshold: Math.min(dedupeReview, dedupeAuto),
    },
    recall: {
      ...merged.recall,
      topK: Math.max(1, Math.min(50, Number(merged?.recall?.topK ?? 8) || 8)),
      minScore: clamp01(merged?.recall?.minScore ?? 0.45),
      maxTokens: Math.max(100, Math.min(8000, Number(merged?.recall?.maxTokens ?? 1200) || 1200)),
      mode: ['personal_core', 'project_context', 'hybrid'].includes(String(merged?.recall?.mode || 'hybrid'))
        ? String(merged?.recall?.mode)
        : 'hybrid',
      classBudgets: normalizeBudgets(merged?.recall?.classBudgets || {}),
    },
    quality: {
      ...merged.quality,
      minContentChars: Math.max(1, Number(merged?.quality?.minContentChars ?? 25) || 25),
      valueThresholds: {
        keep: Math.max(valueKeep, valueArchive),
        archive: Math.min(valueArchive, valueKeep),
        reject: Math.min(valueReject, valueArchive),
      },
    },
    llm: {
      ...merged.llm,
      provider: ['openclaw', 'openai_compatible', 'ollama', 'none'].includes(String(merged?.llm?.provider || 'none'))
        ? String(merged?.llm?.provider)
        : 'none',
      timeoutMs: Math.max(1000, Math.min(120000, Number(merged?.llm?.timeoutMs ?? 12000) || 12000)),
      review: {
        ...merged.llm.review,
        enabled: merged?.llm?.review?.enabled === true,
        limit: Math.max(0, Math.min(5000, Number(merged?.llm?.review?.limit ?? 200) || 200)),
        minScore: clamp01(merged?.llm?.review?.minScore ?? 0.24),
        maxScore: clamp01(merged?.llm?.review?.maxScore ?? 0.52),
        minConfidence: clamp01(merged?.llm?.review?.minConfidence ?? 0.7),
      },
    },
    maintenance: {
      ...merged.maintenance,
      snapshotDir: resolvePathMaybeRelative(workspaceRoot, merged?.maintenance?.snapshotDir, path.join(memoryRoot, 'backups')),
      eventsPath: resolvePathMaybeRelative(workspaceRoot, merged?.maintenance?.eventsPath, path.join(outputDir, 'memory-events.jsonl')),
      usageLogPath: resolvePathMaybeRelative(workspaceRoot, merged?.maintenance?.usageLogPath, path.join(memoryRoot, 'usage-log.md')),
      compactDays: Math.max(1, Number(merged?.maintenance?.compactDays ?? 30) || 30),
      emergencyUnvacuumedDays: Math.max(1, Number(merged?.maintenance?.emergencyUnvacuumedDays ?? 7) || 7),
      maxEmergencyFiles: Math.max(1, Number(merged?.maintenance?.maxEmergencyFiles ?? 1) || 1),
      vacuum: merged?.maintenance?.vacuum !== false,
      harmonize: {
        ...merged?.maintenance?.harmonize,
        enabled: merged?.maintenance?.harmonize?.enabled === true,
        outPath: resolvePathMaybeRelative(
          workspaceRoot,
          merged?.maintenance?.harmonize?.outPath,
          DEFAULT_CONFIG.maintenance.harmonize.outPath,
        ),
        statuses: harmonizeStatuses.length > 0
          ? harmonizeStatuses
          : [...DEFAULT_CONFIG.maintenance.harmonize.statuses],
        maxRows: clampInt(
          merged?.maintenance?.harmonize?.maxRows,
          10,
          5000,
          Number(DEFAULT_CONFIG.maintenance.harmonize.maxRows),
        ),
        perTypeLimit: clampInt(
          merged?.maintenance?.harmonize?.perTypeLimit,
          1,
          2000,
          Number(DEFAULT_CONFIG.maintenance.harmonize.perTypeLimit),
        ),
        minConfidence: clamp01(
          merged?.maintenance?.harmonize?.minConfidence
            ?? DEFAULT_CONFIG.maintenance.harmonize.minConfidence,
        ),
        syncNative: merged?.maintenance?.harmonize?.syncNative !== false,
        includeInNative: merged?.maintenance?.harmonize?.includeInNative !== false,
        backup: merged?.maintenance?.harmonize?.backup !== false,
      },
    },
    native: {
      ...merged.native,
      enabled: merged?.native?.enabled !== false,
      memoryMdPath: resolvePathMaybeRelative(workspaceRoot, merged?.native?.memoryMdPath, DEFAULT_CONFIG.native.memoryMdPath),
      dailyNotesGlob: String(merged?.native?.dailyNotesGlob || DEFAULT_CONFIG.native.dailyNotesGlob).trim() || DEFAULT_CONFIG.native.dailyNotesGlob,
      includeFiles: nativeIncludeFiles,
      excludeGlobs: nativeExcludeGlobs,
      syncMode: 'hybrid',
      maxChunkChars: Math.max(120, Math.min(8000, Number(merged?.native?.maxChunkChars ?? DEFAULT_CONFIG.native.maxChunkChars) || DEFAULT_CONFIG.native.maxChunkChars)),
      onDemandTemporalDays: Math.max(30, Math.min(36500, Number(merged?.native?.onDemandTemporalDays ?? DEFAULT_CONFIG.native.onDemandTemporalDays) || DEFAULT_CONFIG.native.onDemandTemporalDays)),
      sparkAdvisory: {
        ...merged?.native?.sparkAdvisory,
        dedupeEnabled: merged?.native?.sparkAdvisory?.dedupeEnabled !== false,
        maxChunks: clampInt(
          merged?.native?.sparkAdvisory?.maxChunks,
          16,
          5000,
          Number(DEFAULT_CONFIG.native.sparkAdvisory.maxChunks),
        ),
        nearDuplicateThreshold: sparkNearThreshold,
      },
    },
    person: {
      ...merged.person,
      keepPublicFacts: merged?.person?.keepPublicFacts !== false,
      relationshipPriorityBoost: Math.max(0, Math.min(2, Number(merged?.person?.relationshipPriorityBoost ?? DEFAULT_CONFIG.person.relationshipPriorityBoost) || DEFAULT_CONFIG.person.relationshipPriorityBoost)),
      publicProfileBoost: Math.max(0, Math.min(2, Number(merged?.person?.publicProfileBoost ?? DEFAULT_CONFIG.person.publicProfileBoost) || DEFAULT_CONFIG.person.publicProfileBoost)),
      requireWordBoundaryMatch: merged?.person?.requireWordBoundaryMatch !== false,
    },
  };
  return out;
};

const resolveGigabrainConfig = (openclawConfig = {}) => {
  const entry = openclawConfig?.plugins?.entries?.gigabrain;
  if (!isObject(entry)) return {};
  return isObject(entry.config) ? entry.config : {};
};

const loadJsonIfExists = (filePath, fallback = {}) => {
  if (!filePath) return fallback;
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
};

const findDefaultOpenclawConfigPath = () => {
  const home = process.env.HOME || os.homedir() || '';
  const candidates = [
    process.env.OPENCLAW_CONFIG,
    path.join(home, '.openclaw', 'openclaw.json'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
};

const loadOpenclawConfig = (configPath = '') => {
  const resolvedPath = configPath || findDefaultOpenclawConfigPath();
  if (!resolvedPath) return { configPath: '', config: {} };
  return {
    configPath: resolvedPath,
    config: loadJsonIfExists(resolvedPath, {}),
  };
};

const loadResolvedConfig = (options = {}) => {
  const directConfig = isObject(options.config) ? options.config : null;
  if (directConfig) {
    return {
      configPath: options.configPath || '',
      config: normalizeConfig(directConfig, options),
    };
  }
  const loaded = loadOpenclawConfig(options.configPath || '');
  const pluginConfig = resolveGigabrainConfig(loaded.config);
  return {
    configPath: loaded.configPath,
    config: normalizeConfig(pluginConfig, options),
  };
};

export {
  FORBIDDEN_LEGACY_KEYS,
  DEFAULT_CONFIG,
  V3_CONFIG_SCHEMA,
  normalizeConfig,
  resolveGigabrainConfig,
  loadOpenclawConfig,
  loadResolvedConfig,
  findDefaultOpenclawConfigPath,
};
