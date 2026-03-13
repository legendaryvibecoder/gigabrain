import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_BROKEN_PHRASE_PATTERNS_BASE,
  DEFAULT_DURABLE_PATTERNS_BASE,
  DEFAULT_HIGH_VALUE_SHORT_PATTERNS_BASE,
  DEFAULT_JUNK_PATTERNS_BASE,
  DEFAULT_SEMANTIC_ANCHORS_BASE,
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

const DEFAULT_LLM_TASK_PROFILES = Object.freeze({
  memory_review: Object.freeze({
    model: 'qwen3.5:9b',
    temperature: 0.15,
    top_p: 0.8,
    top_k: 20,
    max_tokens: 180,
    reasoning: 'off',
  }),
  extraction_json: Object.freeze({
    model: 'qwen3.5:9b',
    temperature: 0.1,
    top_p: 0.75,
    top_k: 20,
    max_tokens: 220,
    reasoning: 'off',
  }),
  memory_canonicalize: Object.freeze({
    model: 'qwen3.5:9b',
    temperature: 0.2,
    top_p: 0.85,
    top_k: 30,
    max_tokens: 220,
    reasoning: 'off',
  }),
  chat_general: Object.freeze({
    model: 'qwen3.5:latest',
    temperature: 1,
    top_p: 0.95,
    top_k: 40,
    max_tokens: 1200,
    reasoning: 'default',
  }),
});

const DEFAULT_REMEMBER_INTENT_PHRASES_BASE = Object.freeze([
  'remember this',
  'remember that',
  'merk dir',
  'note this',
  'note that',
  'note this down',
  'save this',
  'save this preference',
]);

const DEFAULT_GLOBAL_CODEX_STORE = path.join(os.homedir(), '.codex', 'gigabrain');
const DEFAULT_GLOBAL_CODEX_PROFILE_STORE = path.join(DEFAULT_GLOBAL_CODEX_STORE, 'profile');
const DEFAULT_CODEX_RECALL_ORDER = Object.freeze(['project', 'user', 'remote']);
const DEFAULT_CODEX_USER_OVERLAY_TYPES = Object.freeze([
  'PREFERENCE',
  'USER_FACT',
  'AGENT_IDENTITY',
  'DECISION',
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
        'remember_intent_missing_note',
        'capture_note_parse_failed',
        'semantic_borderline',
        'capture_missing_note',
        'capture_parse_failed',
        'duplicate_semantic',
        'capture_review_required',
        'memory_action_review',
      ],
    },
  },
  capture: {
    enabled: true,
    requireMemoryNote: true,
    minConfidence: 0.65,
    minContentChars: 25,
    queueOnModelUnavailable: true,
    rememberIntent: {
      enabled: true,
      phrasesBase: [...DEFAULT_REMEMBER_INTENT_PHRASES_BASE],
      writeNative: true,
      writeRegistry: true,
    },
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
  orchestrator: {
    defaultStrategy: 'auto',
    allowDeepLookup: true,
    deepLookupRequires: ['explicit', 'exact_date', 'source_request', 'exact_wording', 'low_confidence_no_brief'],
    profileFirst: true,
    entityLockEnabled: true,
    strategyRerankEnabled: true,
    lowConfidenceNoBriefThreshold: 0.62,
    entityLockMinScore: 0.58,
    temporalEntityPenaltyKinds: ['topic'],
  },
  worldModel: {
    enabled: true,
    entityKinds: ['person', 'project', 'organization', 'place', 'topic'],
    surfaceEntityMinConfidence: 0.78,
    surfaceEntityMinEvidence: 2,
    surfaceEntityKinds: ['person', 'project', 'organization'],
    topicEntities: {
      mode: 'strict_hidden',
      minEvidenceCount: 2,
      requireCuratedOrMemoryMd: true,
      minAliasLength: 4,
      exportToSurface: false,
      allowForRecall: true,
      maxGenerated: 80,
    },
  },
  synthesis: {
    enabled: true,
    briefing: {
      enabled: true,
      includeSessionPrelude: true,
    },
  },
  control: {
    memoryActions: {
      enabled: true,
    },
  },
  surface: {
    obsidian: {
      mode: 'curated',
      exportDiagnostics: false,
      exportEntityPages: 'stable_only',
      entityPages: true,
    },
    webConsole: {
      recallTrace: true,
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
    plausibility: {
      enabled: true,
      brokenPhrasePatternsBase: [...DEFAULT_BROKEN_PHRASE_PATTERNS_BASE],
      brokenPhrasePatternsAppend: [],
      semanticAnchorsBase: [...DEFAULT_SEMANTIC_ANCHORS_BASE],
      semanticAnchorsAppend: [],
    },
    valueThresholds: {
      keep: 0.78,
      archive: 0.3,
      reject: 0.18,
    },
  },
  llm: {
    provider: 'none',
    baseUrl: '',
    model: '',
    apiKey: '',
    timeoutMs: 12000,
    taskProfiles: {
      ...DEFAULT_LLM_TASK_PROFILES,
    },
    review: {
      enabled: false,
      limit: 200,
      minScore: 0.18,
      maxScore: 0.62,
      minConfidence: 0.8,
      profile: 'memory_review',
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
  nativePromotion: {
    enabled: true,
    promoteFromDaily: true,
    promoteFromMemoryMd: true,
    minConfidence: 0.72,
  },
  vault: {
    enabled: false,
    path: 'obsidian-vault',
    subdir: 'Gigabrain',
    clean: true,
    homeNoteName: 'Home',
    exportActiveNodes: false,
    exportRecentArchivesLimit: 200,
    manualFolders: ['Inbox', 'Manual'],
    views: {
      enabled: true,
    },
    reports: {
      enabled: true,
    },
  },
  person: {
    keepPublicFacts: true,
    relationshipPriorityBoost: 0.35,
    publicProfileBoost: 0.1,
    requireWordBoundaryMatch: true,
  },
  codex: {
    enabled: true,
    storeMode: 'global',
    projectRoot: '',
    projectStorePath: DEFAULT_GLOBAL_CODEX_STORE,
    userProfilePath: DEFAULT_GLOBAL_CODEX_PROFILE_STORE,
    projectScope: '',
    defaultProjectScope: '',
    defaultUserScope: 'profile:user',
    defaultTarget: 'project',
    recallOrder: [...DEFAULT_CODEX_RECALL_ORDER],
    userOverlayTypes: [...DEFAULT_CODEX_USER_OVERLAY_TYPES],
  },
  remoteBridge: {
    enabled: false,
    baseUrl: '',
    authToken: '',
    timeoutMs: 8000,
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
        rememberIntent: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean', default: true },
            phrasesBase: {
              type: 'array',
              items: { type: 'string' },
              default: [...DEFAULT_REMEMBER_INTENT_PHRASES_BASE],
            },
            writeNative: { type: 'boolean', default: true },
            writeRegistry: { type: 'boolean', default: true },
          },
        },
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
    orchestrator: {
      type: 'object',
      additionalProperties: false,
      properties: {
        defaultStrategy: { type: 'string', default: 'auto' },
        allowDeepLookup: { type: 'boolean', default: true },
        deepLookupRequires: {
          type: 'array',
          items: { type: 'string' },
          default: ['explicit', 'exact_date', 'source_request', 'exact_wording', 'low_confidence_no_brief'],
        },
        profileFirst: { type: 'boolean', default: true },
        entityLockEnabled: { type: 'boolean', default: true },
        strategyRerankEnabled: { type: 'boolean', default: true },
        lowConfidenceNoBriefThreshold: { type: 'number', default: 0.62 },
        entityLockMinScore: { type: 'number', default: 0.58 },
        temporalEntityPenaltyKinds: {
          type: 'array',
          items: { type: 'string' },
          default: ['topic'],
        },
      },
    },
    worldModel: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', default: true },
        entityKinds: {
          type: 'array',
          items: { type: 'string' },
          default: ['person', 'project', 'organization', 'place', 'topic'],
        },
        surfaceEntityMinConfidence: { type: 'number', default: 0.78 },
        surfaceEntityMinEvidence: { type: 'number', default: 2 },
        surfaceEntityKinds: {
          type: 'array',
          items: { type: 'string' },
          default: ['person', 'project', 'organization'],
        },
        topicEntities: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mode: { type: 'string', enum: ['off', 'strict', 'strict_hidden', 'balanced', 'broad'], default: 'strict_hidden' },
            minEvidenceCount: { type: 'number', default: 2 },
            requireCuratedOrMemoryMd: { type: 'boolean', default: true },
            minAliasLength: { type: 'number', default: 4 },
            exportToSurface: { type: 'boolean', default: false },
            allowForRecall: { type: 'boolean', default: true },
            maxGenerated: { type: 'number', default: 80 },
          },
        },
      },
    },
    synthesis: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', default: true },
        briefing: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean', default: true },
            includeSessionPrelude: { type: 'boolean', default: true },
          },
        },
      },
    },
    control: {
      type: 'object',
      additionalProperties: false,
      properties: {
        memoryActions: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean', default: true },
          },
        },
      },
    },
    surface: {
      type: 'object',
      additionalProperties: false,
      properties: {
        obsidian: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mode: { type: 'string', enum: ['curated', 'diagnostic'], default: 'curated' },
            exportDiagnostics: { type: 'boolean', default: false },
            exportEntityPages: { type: 'string', enum: ['off', 'stable_only', 'all'], default: 'stable_only' },
            entityPages: { type: 'boolean', default: true },
          },
        },
        webConsole: {
          type: 'object',
          additionalProperties: false,
          properties: {
            recallTrace: { type: 'boolean', default: true },
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
        plausibility: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean', default: true },
            brokenPhrasePatternsBase: { type: 'array', items: { type: 'string' }, default: [...DEFAULT_BROKEN_PHRASE_PATTERNS_BASE] },
            brokenPhrasePatternsAppend: { type: 'array', items: { type: 'string' }, default: [] },
            semanticAnchorsBase: { type: 'array', items: { type: 'string' }, default: [...DEFAULT_SEMANTIC_ANCHORS_BASE] },
            semanticAnchorsAppend: { type: 'array', items: { type: 'string' }, default: [] },
          },
        },
        valueThresholds: {
          type: 'object',
          additionalProperties: false,
          properties: {
            keep: { type: 'number', default: 0.78 },
            archive: { type: 'number', default: 0.3 },
            reject: { type: 'number', default: 0.18 },
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
        taskProfiles: {
          type: 'object',
          additionalProperties: false,
          properties: {
            memory_review: {
              type: 'object',
              additionalProperties: false,
              properties: {
                model: { type: 'string' },
                temperature: { type: 'number', default: 0.15 },
                top_p: { type: 'number', default: 0.8 },
                top_k: { type: 'number', default: 20 },
                max_tokens: { type: 'number', default: 180 },
                reasoning: { type: 'string', enum: ['off', 'default'], default: 'off' },
              },
            },
            extraction_json: {
              type: 'object',
              additionalProperties: false,
              properties: {
                model: { type: 'string' },
                temperature: { type: 'number', default: 0.1 },
                top_p: { type: 'number', default: 0.75 },
                top_k: { type: 'number', default: 20 },
                max_tokens: { type: 'number', default: 220 },
                reasoning: { type: 'string', enum: ['off', 'default'], default: 'off' },
              },
            },
            memory_canonicalize: {
              type: 'object',
              additionalProperties: false,
              properties: {
                model: { type: 'string' },
                temperature: { type: 'number', default: 0.2 },
                top_p: { type: 'number', default: 0.85 },
                top_k: { type: 'number', default: 30 },
                max_tokens: { type: 'number', default: 220 },
                reasoning: { type: 'string', enum: ['off', 'default'], default: 'off' },
              },
            },
            chat_general: {
              type: 'object',
              additionalProperties: false,
              properties: {
                model: { type: 'string' },
                temperature: { type: 'number', default: 1 },
                top_p: { type: 'number', default: 0.95 },
                top_k: { type: 'number', default: 40 },
                max_tokens: { type: 'number', default: 1200 },
                reasoning: { type: 'string', enum: ['off', 'default'], default: 'default' },
              },
            },
          },
        },
        review: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean', default: false },
            limit: { type: 'number', default: 200 },
            minScore: { type: 'number', default: 0.18 },
            maxScore: { type: 'number', default: 0.62 },
            minConfidence: { type: 'number', default: 0.8 },
            profile: { type: 'string', default: 'memory_review' },
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
    nativePromotion: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', default: true },
        promoteFromDaily: { type: 'boolean', default: true },
        promoteFromMemoryMd: { type: 'boolean', default: true },
        minConfidence: { type: 'number', default: 0.72 },
      },
    },
    vault: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', default: false },
        path: { type: 'string', default: 'obsidian-vault' },
        subdir: { type: 'string', default: 'Gigabrain' },
        clean: { type: 'boolean', default: true },
        homeNoteName: { type: 'string', default: 'Home' },
        exportActiveNodes: { type: 'boolean', default: true },
        exportRecentArchivesLimit: { type: 'number', default: 200 },
        manualFolders: {
          type: 'array',
          items: { type: 'string' },
          default: ['Inbox', 'Manual'],
        },
        views: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean', default: true },
          },
        },
        reports: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean', default: true },
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
    codex: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', default: true },
        storeMode: { type: 'string', default: 'global' },
        projectRoot: { type: 'string' },
        projectStorePath: { type: 'string', default: DEFAULT_GLOBAL_CODEX_STORE },
        userProfilePath: { type: 'string', default: DEFAULT_GLOBAL_CODEX_PROFILE_STORE },
        projectScope: { type: 'string', default: '' },
        defaultProjectScope: { type: 'string', default: '' },
        defaultUserScope: { type: 'string', default: 'profile:user' },
        defaultTarget: { type: 'string', enum: ['project', 'user'], default: 'project' },
        recallOrder: {
          type: 'array',
          items: { type: 'string', enum: ['project', 'user', 'remote'] },
          default: [...DEFAULT_CODEX_RECALL_ORDER],
        },
        userOverlayTypes: {
          type: 'array',
          items: { type: 'string' },
          default: [...DEFAULT_CODEX_USER_OVERLAY_TYPES],
        },
      },
    },
    remoteBridge: {
      type: 'object',
      additionalProperties: false,
      properties: {
        enabled: { type: 'boolean', default: false },
        baseUrl: { type: 'string', default: '' },
        authToken: { type: 'string', default: '' },
        timeoutMs: { type: 'number', default: 8000 },
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

const normalizeManualFolders = (value, fallback = ['Inbox', 'Manual']) => {
  const list = normalizeStringArray(value);
  const out = list.length > 0 ? list : [...fallback];
  return Array.from(new Set(out))
    .filter((item) => !item.includes('/') && !item.includes('\\'))
    .filter(Boolean);
};

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

const slugify = (value = '') => {
  const input = String(value || '').toLowerCase();
  let out = '';
  let lastWasDash = false;
  for (const char of input) {
    const code = char.charCodeAt(0);
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (isLower || isDigit) {
      out += char;
      lastWasDash = false;
      continue;
    }
    if (!lastWasDash && out) {
      out += '-';
      lastWasDash = true;
    }
  }
  if (out.endsWith('-')) out = out.slice(0, -1);
  return out.slice(0, 40);
};

const trimTrailingChar = (value = '', trailingChar = '') => {
  const input = String(value || '');
  if (!input || !trailingChar) return input;
  let end = input.length;
  while (end > 0 && input[end - 1] === trailingChar) end -= 1;
  return input.slice(0, end);
};

const deriveCodexProjectScope = (projectRoot = '') => {
  const resolved = path.resolve(String(projectRoot || process.cwd()));
  const base = slugify(path.basename(resolved)) || 'workspace';
  const hash = crypto.createHash('sha1').update(resolved).digest('hex').slice(0, 8);
  return `project:${base}:${hash}`;
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

const normalizeReasoningMode = (value, fallback = 'off') => {
  const key = String(value || fallback).trim().toLowerCase();
  if (['off', 'default'].includes(key)) return key;
  return fallback;
};

const normalizeTopicEntityMode = (value, fallback = 'strict_hidden') => {
  const key = String(value || fallback).trim().toLowerCase();
  if (['off', 'strict', 'strict_hidden', 'balanced', 'broad'].includes(key)) return key;
  return fallback;
};

const normalizeObsidianMode = (value, fallback = 'curated') => {
  const key = String(value || fallback).trim().toLowerCase();
  if (['curated', 'diagnostic'].includes(key)) return key;
  return fallback;
};

const normalizeObsidianEntityExportMode = (value, fallback = 'stable_only') => {
  if (typeof value === 'boolean') return value ? 'stable_only' : 'off';
  const key = String(value || fallback).trim().toLowerCase();
  if (['off', 'stable_only', 'all'].includes(key)) return key;
  return fallback;
};

const normalizeTaskProfiles = (taskProfiles = {}) => {
  const out = {};
  for (const [key, defaults] of Object.entries(DEFAULT_LLM_TASK_PROFILES)) {
    const raw = isObject(taskProfiles?.[key]) ? taskProfiles[key] : {};
    out[key] = {
      model: String(raw.model || defaults.model || ''),
      temperature: clamp01(raw.temperature ?? defaults.temperature),
      top_p: clamp01(raw.top_p ?? defaults.top_p),
      top_k: clampInt(raw.top_k ?? defaults.top_k, 1, 200, defaults.top_k),
      max_tokens: clampInt(raw.max_tokens ?? defaults.max_tokens, 32, 8192, defaults.max_tokens),
      reasoning: normalizeReasoningMode(raw.reasoning ?? defaults.reasoning, defaults.reasoning),
    };
  }
  return out;
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
  const valueKeep = clamp01(merged?.quality?.valueThresholds?.keep ?? 0.78);
  const valueArchive = clamp01(merged?.quality?.valueThresholds?.archive ?? 0.3);
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
  const rawCodex = isObject(rawConfig?.codex) ? rawConfig.codex : {};
  const codexStoreMode = ['project-local', 'project_local', 'local', 'repo', 'repo-local'].includes(String(merged?.codex?.storeMode || '').trim().toLowerCase())
    ? 'project_local'
    : 'global';
  const codexProjectRoot = resolvePathMaybeRelative(
    workspaceRoot,
    merged?.codex?.projectRoot,
    DEFAULT_CONFIG.codex.projectRoot || workspaceRoot,
  );
  const codexProjectStorePath = resolvePathMaybeRelative(
    workspaceRoot,
    merged?.codex?.projectStorePath,
    DEFAULT_CONFIG.codex.projectStorePath || workspaceRoot,
  );
  const defaultCodexUserProfilePath = path.join(codexProjectStorePath, 'profile');
  const codexUserProfileProvided = Object.prototype.hasOwnProperty.call(rawCodex, 'userProfilePath');
  const codexUserProfilePath = codexUserProfileProvided
    ? resolvePathMaybeRelative(workspaceRoot, rawCodex.userProfilePath, '')
    : resolvePathMaybeRelative(
      workspaceRoot,
      merged?.codex?.userProfilePath,
      defaultCodexUserProfilePath,
    );
  const codexProjectScope = String(merged?.codex?.projectScope || '').trim()
    || deriveCodexProjectScope(codexProjectRoot || workspaceRoot);
  const requestedDefaultProjectScope = String(merged?.codex?.defaultProjectScope || '').trim();
  const codexDefaultProjectScope = requestedDefaultProjectScope && requestedDefaultProjectScope !== 'codex:global'
    ? requestedDefaultProjectScope
    : codexProjectScope;
  const codexRecallOrder = (Array.isArray(merged?.codex?.recallOrder) ? merged.codex.recallOrder : DEFAULT_CONFIG.codex.recallOrder)
    .map((item) => String(item || '').trim().toLowerCase())
    .filter((item, index, list) => ['project', 'user', 'remote'].includes(item) && list.indexOf(item) === index);
  if (codexUserProfilePath && !codexRecallOrder.includes('user')) {
    const projectIndex = codexRecallOrder.indexOf('project');
    if (projectIndex === -1) codexRecallOrder.unshift('user');
    else codexRecallOrder.splice(projectIndex + 1, 0, 'user');
  }
  if (!codexUserProfilePath) {
    const userIndex = codexRecallOrder.indexOf('user');
    if (userIndex !== -1) codexRecallOrder.splice(userIndex, 1);
  }

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
      rememberIntent: {
        ...merged?.capture?.rememberIntent,
        enabled: merged?.capture?.rememberIntent?.enabled !== false,
        phrasesBase: (() => {
          const phrases = normalizeStringArray(merged?.capture?.rememberIntent?.phrasesBase);
          return phrases.length > 0 ? phrases : [...DEFAULT_REMEMBER_INTENT_PHRASES_BASE];
        })(),
        writeNative: merged?.capture?.rememberIntent?.writeNative !== false,
        writeRegistry: merged?.capture?.rememberIntent?.writeRegistry !== false,
      },
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
    orchestrator: {
      ...merged?.orchestrator,
      defaultStrategy: String(merged?.orchestrator?.defaultStrategy || 'auto').trim() || 'auto',
      allowDeepLookup: merged?.orchestrator?.allowDeepLookup !== false,
      deepLookupRequires: (() => {
        const list = normalizeStringArray(merged?.orchestrator?.deepLookupRequires);
        return list.length > 0 ? list : [...DEFAULT_CONFIG.orchestrator.deepLookupRequires];
      })(),
      profileFirst: merged?.orchestrator?.profileFirst !== false,
      entityLockEnabled: merged?.orchestrator?.entityLockEnabled !== false,
      strategyRerankEnabled: merged?.orchestrator?.strategyRerankEnabled !== false,
      lowConfidenceNoBriefThreshold: clamp01(
        merged?.orchestrator?.lowConfidenceNoBriefThreshold ?? DEFAULT_CONFIG.orchestrator.lowConfidenceNoBriefThreshold,
      ),
      entityLockMinScore: clamp01(
        merged?.orchestrator?.entityLockMinScore ?? DEFAULT_CONFIG.orchestrator.entityLockMinScore,
      ),
      temporalEntityPenaltyKinds: (() => {
        const list = normalizeStringArray(merged?.orchestrator?.temporalEntityPenaltyKinds);
        return list.length > 0 ? list : [...DEFAULT_CONFIG.orchestrator.temporalEntityPenaltyKinds];
      })(),
    },
    worldModel: {
      ...merged?.worldModel,
      enabled: merged?.worldModel?.enabled !== false,
      entityKinds: (() => {
        const list = normalizeStringArray(merged?.worldModel?.entityKinds);
        return list.length > 0 ? list : [...DEFAULT_CONFIG.worldModel.entityKinds];
      })(),
      surfaceEntityMinConfidence: clamp01(
        merged?.worldModel?.surfaceEntityMinConfidence ?? DEFAULT_CONFIG.worldModel.surfaceEntityMinConfidence,
      ),
      surfaceEntityMinEvidence: clampInt(
        merged?.worldModel?.surfaceEntityMinEvidence,
        1,
        100,
        DEFAULT_CONFIG.worldModel.surfaceEntityMinEvidence,
      ),
      surfaceEntityKinds: (() => {
        const list = normalizeStringArray(merged?.worldModel?.surfaceEntityKinds);
        return list.length > 0 ? list : [...DEFAULT_CONFIG.worldModel.surfaceEntityKinds];
      })(),
      topicEntities: {
        ...merged?.worldModel?.topicEntities,
        mode: normalizeTopicEntityMode(
          merged?.worldModel?.topicEntities?.mode,
          DEFAULT_CONFIG.worldModel.topicEntities.mode,
        ),
        minEvidenceCount: clampInt(
          merged?.worldModel?.topicEntities?.minEvidenceCount,
          1,
          1000,
          DEFAULT_CONFIG.worldModel.topicEntities.minEvidenceCount,
        ),
        requireCuratedOrMemoryMd:
          merged?.worldModel?.topicEntities?.requireCuratedOrMemoryMd !== false,
        minAliasLength: clampInt(
          merged?.worldModel?.topicEntities?.minAliasLength,
          1,
          64,
          DEFAULT_CONFIG.worldModel.topicEntities.minAliasLength,
        ),
        exportToSurface: merged?.worldModel?.topicEntities?.exportToSurface === true,
        allowForRecall: merged?.worldModel?.topicEntities?.allowForRecall !== false,
        maxGenerated: clampInt(
          merged?.worldModel?.topicEntities?.maxGenerated,
          1,
          10000,
          DEFAULT_CONFIG.worldModel.topicEntities.maxGenerated,
        ),
      },
    },
    synthesis: {
      ...merged?.synthesis,
      enabled: merged?.synthesis?.enabled !== false,
      briefing: {
        ...merged?.synthesis?.briefing,
        enabled: merged?.synthesis?.briefing?.enabled !== false,
        includeSessionPrelude: merged?.synthesis?.briefing?.includeSessionPrelude !== false,
      },
    },
    control: {
      ...merged?.control,
      memoryActions: {
        ...merged?.control?.memoryActions,
        enabled: merged?.control?.memoryActions?.enabled !== false,
      },
    },
    surface: {
      ...merged?.surface,
      obsidian: {
        ...merged?.surface?.obsidian,
        mode: normalizeObsidianMode(
          merged?.surface?.obsidian?.mode,
          DEFAULT_CONFIG.surface.obsidian.mode,
        ),
        exportDiagnostics: merged?.surface?.obsidian?.exportDiagnostics === true,
        exportEntityPages: normalizeObsidianEntityExportMode(
          merged?.surface?.obsidian?.exportEntityPages ?? merged?.surface?.obsidian?.entityPages,
          DEFAULT_CONFIG.surface.obsidian.exportEntityPages,
        ),
        entityPages: merged?.surface?.obsidian?.entityPages !== false,
      },
      webConsole: {
        ...merged?.surface?.webConsole,
        recallTrace: merged?.surface?.webConsole?.recallTrace !== false,
      },
    },
    quality: {
      ...merged.quality,
      minContentChars: Math.max(1, Number(merged?.quality?.minContentChars ?? 25) || 25),
      plausibility: {
        enabled: merged?.quality?.plausibility?.enabled !== false,
        brokenPhrasePatternsBase: normalizeStringArray(
          merged?.quality?.plausibility?.brokenPhrasePatternsBase || DEFAULT_BROKEN_PHRASE_PATTERNS_BASE,
        ),
        brokenPhrasePatternsAppend: normalizeStringArray(merged?.quality?.plausibility?.brokenPhrasePatternsAppend || []),
        semanticAnchorsBase: normalizeStringArray(
          merged?.quality?.plausibility?.semanticAnchorsBase || DEFAULT_SEMANTIC_ANCHORS_BASE,
        ),
        semanticAnchorsAppend: normalizeStringArray(merged?.quality?.plausibility?.semanticAnchorsAppend || []),
      },
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
      taskProfiles: normalizeTaskProfiles(merged?.llm?.taskProfiles),
      review: {
        ...merged.llm.review,
        enabled: merged?.llm?.review?.enabled === true,
        limit: Math.max(0, Math.min(5000, Number(merged?.llm?.review?.limit ?? 200) || 200)),
        minScore: clamp01(merged?.llm?.review?.minScore ?? 0.18),
        maxScore: clamp01(merged?.llm?.review?.maxScore ?? 0.62),
        minConfidence: clamp01(merged?.llm?.review?.minConfidence ?? 0.8),
        profile: String(merged?.llm?.review?.profile || 'memory_review').trim() || 'memory_review',
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
    nativePromotion: {
      ...merged?.nativePromotion,
      enabled: merged?.nativePromotion?.enabled !== false,
      promoteFromDaily: merged?.nativePromotion?.promoteFromDaily !== false,
      promoteFromMemoryMd: merged?.nativePromotion?.promoteFromMemoryMd !== false,
      minConfidence: clamp01(
        merged?.nativePromotion?.minConfidence ?? DEFAULT_CONFIG.nativePromotion.minConfidence,
      ),
    },
    vault: {
      ...merged.vault,
      enabled: merged?.vault?.enabled === true,
      path: resolvePathMaybeRelative(workspaceRoot, merged?.vault?.path, DEFAULT_CONFIG.vault.path),
      subdir: String(merged?.vault?.subdir || DEFAULT_CONFIG.vault.subdir).trim() || DEFAULT_CONFIG.vault.subdir,
      clean: merged?.vault?.clean !== false,
      homeNoteName: String(merged?.vault?.homeNoteName || DEFAULT_CONFIG.vault.homeNoteName).trim() || DEFAULT_CONFIG.vault.homeNoteName,
      exportActiveNodes: merged?.vault?.exportActiveNodes === true,
      exportRecentArchivesLimit: clampInt(
        merged?.vault?.exportRecentArchivesLimit,
        1,
        5000,
        Number(DEFAULT_CONFIG.vault.exportRecentArchivesLimit),
      ),
      manualFolders: normalizeManualFolders(
        merged?.vault?.manualFolders,
        DEFAULT_CONFIG.vault.manualFolders,
      ),
      views: {
        enabled: merged?.vault?.views?.enabled !== false,
      },
      reports: {
        enabled: merged?.vault?.reports?.enabled !== false,
      },
    },
    person: {
      ...merged.person,
      keepPublicFacts: merged?.person?.keepPublicFacts !== false,
      relationshipPriorityBoost: Math.max(0, Math.min(2, Number(merged?.person?.relationshipPriorityBoost ?? DEFAULT_CONFIG.person.relationshipPriorityBoost) || DEFAULT_CONFIG.person.relationshipPriorityBoost)),
      publicProfileBoost: Math.max(0, Math.min(2, Number(merged?.person?.publicProfileBoost ?? DEFAULT_CONFIG.person.publicProfileBoost) || DEFAULT_CONFIG.person.publicProfileBoost)),
      requireWordBoundaryMatch: merged?.person?.requireWordBoundaryMatch !== false,
    },
    codex: {
      ...merged?.codex,
      enabled: merged?.codex?.enabled !== false,
      storeMode: codexStoreMode,
      projectRoot: codexProjectRoot,
      projectStorePath: codexProjectStorePath,
      userProfilePath: codexUserProfilePath,
      projectScope: codexProjectScope,
      defaultProjectScope: codexDefaultProjectScope || codexProjectScope || deriveCodexProjectScope(workspaceRoot || process.cwd()),
      defaultUserScope: String(merged?.codex?.defaultUserScope || DEFAULT_CONFIG.codex.defaultUserScope).trim() || DEFAULT_CONFIG.codex.defaultUserScope,
      defaultTarget: String(merged?.codex?.defaultTarget || DEFAULT_CONFIG.codex.defaultTarget).trim().toLowerCase() === 'user'
        ? 'user'
        : 'project',
      recallOrder: codexRecallOrder,
      userOverlayTypes: (Array.isArray(merged?.codex?.userOverlayTypes) ? merged.codex.userOverlayTypes : DEFAULT_CONFIG.codex.userOverlayTypes)
        .map((item) => String(item || '').trim().toUpperCase())
        .filter((item, index, list) => item && list.indexOf(item) === index),
    },
    remoteBridge: {
      ...merged?.remoteBridge,
      enabled: merged?.remoteBridge?.enabled === true,
      baseUrl: trimTrailingChar(String(merged?.remoteBridge?.baseUrl || '').trim(), '/'),
      authToken: String(merged?.remoteBridge?.authToken || '').trim(),
      timeoutMs: clampInt(
        merged?.remoteBridge?.timeoutMs,
        1000,
        120000,
        Number(DEFAULT_CONFIG.remoteBridge.timeoutMs),
      ),
    },
  };
  if (out.codex.recallOrder.length === 0) {
    out.codex.recallOrder = [...DEFAULT_CONFIG.codex.recallOrder];
  }
  if (out.codex.userOverlayTypes.length === 0) {
    out.codex.userOverlayTypes = [...DEFAULT_CONFIG.codex.userOverlayTypes];
  }
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

const STANDALONE_CONFIG_RELATIVE_PATH = path.join('.gigabrain', 'config.json');

const findDefaultStandaloneConfigPath = (workspaceRoot = process.cwd()) => {
  const root = path.resolve(String(workspaceRoot || process.cwd()));
  const candidate = path.join(root, STANDALONE_CONFIG_RELATIVE_PATH);
  return fs.existsSync(candidate) ? candidate : '';
};

const isStandaloneGigabrainConfig = (value = {}) => {
  if (!isObject(value)) return false;
  if (isObject(value?.plugins?.entries?.gigabrain)) return false;
  return [
    'enabled',
    'runtime',
    'capture',
    'dedupe',
    'recall',
    'orchestrator',
    'worldModel',
    'synthesis',
    'control',
    'surface',
    'quality',
    'llm',
    'maintenance',
    'native',
    'nativePromotion',
    'vault',
    'person',
    'codex',
    'remoteBridge',
  ].some((key) => key in value);
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
  const mode = String(options.mode || '').trim().toLowerCase();
  const directConfig = isObject(options.config) ? options.config : null;
  if (directConfig) {
    const pluginConfig = resolveGigabrainConfig(directConfig);
    if (mode === 'openclaw' || (Object.keys(pluginConfig).length > 0 && mode !== 'standalone')) {
      return {
        configPath: options.configPath || '',
        source: 'openclaw',
        rawConfig: pluginConfig,
        config: normalizeConfig(pluginConfig, options),
      };
    }
    return {
      configPath: options.configPath || '',
      source: 'standalone',
      rawConfig: directConfig,
      config: normalizeConfig(directConfig, options),
    };
  }
  if (options.configPath) {
    const loadedConfig = loadJsonIfExists(options.configPath, {});
    const pluginConfig = resolveGigabrainConfig(loadedConfig);
    if (mode === 'openclaw' || (Object.keys(pluginConfig).length > 0 && mode !== 'standalone')) {
      return {
        configPath: options.configPath,
        source: 'openclaw',
        rawConfig: pluginConfig,
        config: normalizeConfig(pluginConfig, options),
      };
    }
    if (mode === 'standalone' || isStandaloneGigabrainConfig(loadedConfig)) {
      return {
        configPath: options.configPath,
        source: 'standalone',
        rawConfig: loadedConfig,
        config: normalizeConfig(loadedConfig, options),
      };
    }
  }
  if (mode === 'standalone') {
    const standalonePath = findDefaultStandaloneConfigPath(options.workspaceRoot || process.cwd());
    const rawConfig = loadJsonIfExists(standalonePath, {});
    return {
      configPath: standalonePath,
      source: 'standalone',
      rawConfig,
      config: normalizeConfig(rawConfig, options),
    };
  }
  const loaded = loadOpenclawConfig(options.configPath || '');
  const pluginConfig = resolveGigabrainConfig(loaded.config);
  return {
    configPath: loaded.configPath,
    source: 'openclaw',
    rawConfig: pluginConfig,
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
  findDefaultStandaloneConfigPath,
  isStandaloneGigabrainConfig,
};
