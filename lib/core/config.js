import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_GLOBAL_STANDALONE_STORE,
  defaultUserOverlayPathForStore,
} from './standalone-client.js';
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

const DEFAULT_GLOBAL_CODEX_STORE = DEFAULT_GLOBAL_STANDALONE_STORE;
const DEFAULT_GLOBAL_CODEX_PROFILE_STORE = defaultUserOverlayPathForStore(DEFAULT_GLOBAL_STANDALONE_STORE);
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
        'memory_note_oversized',
        'capture_note_oversized',
        'semantic_borderline',
        'capture_missing_note',
        'capture_parse_failed',
        'duplicate_semantic',
        'capture_review_required',
        'capture_contradiction_unverified',
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
    // Configuration drift review found that these were read but undeclared.
    thresholdsByType: {},
    autoResolvePendingDays: 7,
    autoResolveArchive: false,
  },
  recall: {
    autoInjectEnabled: false,
    topK: 8,
    maxTokens: 1200,
    archiveFallbackEnabled: true,
    mode: 'hybrid',
    classBudgets: {
      core: 0.45,
      situational: 0.3,
      decisions: 0.25,
    },
    // U14 (R11, KTD7): hybrid dense+lexical recall is the DEFAULT. The flip is
    // protected by the enforced recall floor (recall@8 >= 0.6310) and degrades
    // to lexical-only when Ollama is unreachable or no embeddings are cached —
    // no crash, no per-query log spam (same convention as capture's U10
    // jaccard fallback). Capture's embedding-kNN neighbor selection reads the
    // same flag on purpose: one flag, one semantics.
    semanticRerankEnabled: true,
    relevanceFloor: {
      enabled: true,
      minMatchedTokens: 2,
      denseCosine: 0.65,
    },
    // E2 (vault recall): NEUTRAL ranking knob for source_kind='vault' chunks
    // (the read-only Obsidian reference corpus E1 ingests at scope='profile:user').
    // It scales ONLY the vault row's lexical/semantic match contribution; default
    // 1.0 = neutral (vault ranks like any other native reference). It is CLAMPED
    // to <= 1.0 in normalize so vault can NEVER be boosted above a native memory
    // — vault is reference, not belief. Lower it to demote vault; you cannot
    // promote it past 1.0.
    vaultWeight: 1.0,
    // U14(e): cross-encoder rerank over the fused candidate set. SEAM ONLY —
    // default OFF until a measured experiment justifies the latency.
    crossEncoderRerankEnabled: false,
    ollamaUrl: 'http://127.0.0.1:11434',
    embeddingModel: 'bge-m3',
    embeddingTimeoutMs: 5000,
    adaptiveBudgeting: {
      enabled: true,
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
    multiEntityEnabled: true,
    fallbackChainEnabled: true,
  },
  worldModel: {
    // worldModel.enabled — clean toggle for the entity/belief/contradiction
    // world-model SURFACES (entities, briefs, syntheses, open loops). Set to
    // false to skip world-model rebuilds entirely.
    // U17: ARBITRATION NO LONGER DEPENDS ON THIS FLAG. When OFF, capture/
    // maintenance/codex/startup route the same projected belief rows through
    // lib/core/belief-arbitration.js (runBeliefArbitration), so verdicts and
    // supersession keep flowing; only the surfaces (gigabrain_contradictions,
    // entity briefs) degrade to empty results — nothing crashes.
    // DEFAULT = true (ON): offline contract tests confirm that verdicts are
    // toggle-independent BY CONSTRUCTION. The default stays ON because the
    // toggle's remaining scope is the recall/brief
    // surfaces, which carry product value evidenced by the recall eval; the
    // red-team flip would change SURFACE behavior, not arbitration, and is no
    // longer motivated by verdict independence (that is achieved).
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
    evolutionEnabled: true,
    autoResolveLoops: true,
    llmContradictionReview: false,
    // U13 arbiter robustness knobs (see docs/configuration.md#worldmodelarbiter).
    arbiter: {
      clusterThreshold: 0.55,
      clusterLlmRefinement: false,
      recencyAmbiguityWindowMs: 300000,
      independenceWindowMs: 600000,
      supportCapPerSource: 1,
    },
  },
  // Explicit trust policy. Two host-to-score maps that
  // used to share the ambiguous name "hostTrust" in two different places:
  //  - arbitrationHostTrust drives SUPERSESSION (belief-arbitration trust tier /
  //    rank; a pin decides who wins a claim slot). Legacy source: top-level
  //    `hostTrust`.
  //  - scoringHostTrust is a belief-SCORE weighting bonus only (never changes
  //    the supersession tier). Legacy source: `worldModel.hostTrust`.
  // normalizeConfig migrates the legacy keys into these and THROWS if a legacy
  // key and its canonical counterpart are both set and disagree (no silent
  // mirror — an operator trust pin is a security control).
  trust: {
    arbitrationHostTrust: {},
    scoringHostTrust: {},
  },
  synthesis: {
    enabled: true,
    briefing: {
      enabled: true,
      includeSessionPrelude: false,
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
    maxCompactFiles: 5,
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
    // E1 (vault-sync): READ-ONLY reference corpora. Each entry is
    // { path, glob?, weight? }. DEFAULT [] → vault-sync is a silent no-op at
    // zero cost. Vault chunks NEVER become beliefs and NEVER write
    // memory_current (R2 keystone, enforced in vault-sync.js).
    vaults: [],
    // E3 (vault operability): BUDGET for the nightly vault-sync step. Hard cap
    // on CHANGED vault files processed per nightly run; excess files defer to
    // the next run. Keeps a large vault from dominating a maintenance pass.
    // vaults:[] default → step is a zero-cost no-op regardless of this value.
    vaultSyncMaxFiles: 2000,
    // #6 (cloud-agent ingest via watched export DROP-FOLDER). Closed cloud
    // products (ChatGPT/Gemini/Copilot) are CLOUD_MANUAL_HOSTS — reachable ONLY
    // via user-initiated, vendor-sanctioned exports. This watches a local drop
    // folder for those official exports and ingests them HONESTLY: NO scraping,
    // NO upload, raw export text never leaves the machine (it passes through the
    // SAME local-redaction prefilter as host_sync). DEFAULT enabled:false → the
    // scanner is an entire no-op at ZERO cost. Per-vendor sub-dirs
    // {chatgpt,gemini,copilot}/ live under `dir`. `staleDays` drives the doctor
    // nudge when a configured source's newest export ages out.
    cloudInbox: {
      enabled: false,
      dir: '~/.gigabrain/cloud-inbox',
      staleDays: 30,
    },
    // GigaBrain idea #1 (transcript / rollout CDC harvester). Tails the RAW
    // session rollouts agents already write (~/.codex/sessions, ~/.claude/
    // projects) so facts from a session that ended abruptly (crash / /clear /
    // OOM) aren't lost. READ-ONLY, LOCAL-ONLY: raw transcript text is distilled
    // ONLY by a local provider (ollama) or an injected hook — never a cloud
    // provider — and lands at the LOW `transcript` trust tier so it can never
    // outrank a deliberate memory. DEFAULT enabled:false → an entire ZERO-COST
    // no-op. `maxFiles`/`maxTurns` bound the work each run does.
    transcripts: {
      enabled: false,
      globs: [
        '~/.codex/sessions/**/*.jsonl',
        '~/.claude/projects/**/*.jsonl',
      ],
      maxFiles: 50,
      maxTurns: 200,
    },
    sparkAdvisory: {
      dedupeEnabled: true,
      maxChunks: 260,
      nearDuplicateThreshold: 0.9,
    },
    // GigaBrain idea #5 (git-versioned LLM-wiki projection of the ledger +
    // human-edit round-trip). The SQLite ledger stays SOURCE OF TRUTH; the wiki
    // is a git-tracked markdown PROJECTION of the arbitrated CURRENT belief set
    // AND a steer surface — a commit a HUMAN makes to the wiki round-trips back
    // as a high-trust `human_wiki` fact that WINS arbitration over an agent
    // fact of the same slot. DEFAULT enabled:false → an entire ZERO-COST no-op:
    // no git repo is created, no disk is touched.
    wiki: {
      enabled: false,
      dir: '~/.gigabrain/wiki',
    },
  },
  nativePromotion: {
    enabled: true,
    promoteFromDaily: true,
    promoteFromMemoryMd: true,
    minConfidence: 0.72,
  },
  person: {
    keepPublicFacts: true,
    relationshipPriorityBoost: 0.35,
    publicProfileBoost: 0.1,
    requireWordBoundaryMatch: true,
  },
  // U16: opt-in LOCAL usage counters (audit/watch runs, findings, verdicts,
  // hook installs). Counts only — no payload, no reconciliation metadata —
  // stored in outputDir and NEVER auto-uploaded.
  telemetry: {
    countersEnabled: false,
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
  vault: {
    inbox: {
      enabled: false,
      apiUrl: 'https://127.0.0.1:27124',
      notePath: 'GigaBrain/Findings.md',
      apiKey: '',
      apiKeyPath: '',
      caPath: '',
      maxFindings: 20,
    },
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
                'remember_intent_missing_note',
                'capture_note_parse_failed',
                'memory_note_oversized',
                'capture_note_oversized',
                'semantic_borderline',
                'capture_missing_note',
                'capture_parse_failed',
                'duplicate_semantic',
                'capture_review_required',
                'capture_contradiction_unverified',
                'memory_action_review',
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
        thresholdsByType: { type: 'object' },
        autoResolvePendingDays: { type: 'number', default: 7 },
        autoResolveArchive: { type: 'boolean', default: false },
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
        autoInjectEnabled: { type: 'boolean', default: false },
        topK: { type: 'number', default: 8 },
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
        semanticRerankEnabled: { type: 'boolean', default: true },
        relevanceFloor: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean', default: true },
            minMatchedTokens: { type: 'number', default: 2 },
            denseCosine: { type: 'number', default: 0.65 },
          },
        },
        vaultWeight: { type: 'number', default: 1.0 },
        crossEncoderRerankEnabled: { type: 'boolean', default: false },
        ollamaUrl: { type: 'string', default: 'http://127.0.0.1:11434' },
        embeddingModel: { type: 'string', default: 'bge-m3' },
        embeddingTimeoutMs: { type: 'number', default: 5000 },
        adaptiveBudgeting: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean', default: true },
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
        multiEntityEnabled: { type: 'boolean', default: true },
        fallbackChainEnabled: { type: 'boolean', default: true },
      },
    },
    worldModel: {
      type: 'object',
      additionalProperties: false,
      properties: {
        // Clean documented toggle. false => skip world-model rebuilds; the
        // contradictions surface degrades to empty (never crashes). Default ON
        // until a proper ON/OFF contradiction eval certifies OFF as flat.
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
        evolutionEnabled: { type: 'boolean', default: true },
        autoResolveLoops: { type: 'boolean', default: true },
        llmContradictionReview: { type: 'boolean', default: false },
        // U13 arbiter robustness: paraphrase clustering, identity and clock defenses.
        arbiter: {
          type: 'object',
          additionalProperties: false,
          properties: {
            clusterThreshold: { type: 'number', default: 0.55 },
            clusterLlmRefinement: { type: 'boolean', default: false },
            recencyAmbiguityWindowMs: { type: 'number', default: 300000 },
            independenceWindowMs: { type: 'number', default: 600000 },
            supportCapPerSource: { type: 'number', default: 1 },
          },
        },
      },
    },
    // Explicit trust policy: the two host->score maps that were formerly the
    // undeclared, same-named `hostTrust` / `worldModel.hostTrust` keys. Declaring
    // them closes the "typo silently disables a trust pin" gap. Values are
    // host(string) -> score(0..1). See normalizeConfig for legacy migration.
    trust: {
      type: 'object',
      additionalProperties: false,
      properties: {
        arbitrationHostTrust: { type: 'object', additionalProperties: { type: 'number' }, default: {} },
        scoringHostTrust: { type: 'object', additionalProperties: { type: 'number' }, default: {} },
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
            includeSessionPrelude: { type: 'boolean', default: false },
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
        maxCompactFiles: { type: 'number', default: 5 },
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
        vaults: {
          type: 'array',
          default: [],
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              path: { type: 'string' },
              glob: { type: 'string' },
              weight: { type: 'number' },
              maxFileKB: { type: 'number' },
            },
          },
        },
        vaultSyncMaxFiles: { type: 'number', default: 2000 },
        cloudInbox: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean', default: false },
            dir: { type: 'string', default: '~/.gigabrain/cloud-inbox' },
            staleDays: { type: 'number', default: 30 },
          },
        },
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
    telemetry: {
      type: 'object',
      additionalProperties: false,
      properties: {
        // U16: opt-in LOCAL counters (counts only, never auto-uploaded).
        countersEnabled: { type: 'boolean', default: false },
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
    vault: {
      type: 'object',
      additionalProperties: false,
      properties: {
        inbox: {
          type: 'object',
          additionalProperties: false,
          properties: {
            enabled: { type: 'boolean', default: false },
            apiUrl: { type: 'string', default: 'https://127.0.0.1:27124' },
            notePath: { type: 'string', default: 'GigaBrain/Findings.md' },
            apiKey: { type: 'string', default: '' },
            apiKeyPath: { type: 'string', default: '' },
            caPath: { type: 'string', default: '' },
            maxFindings: { type: 'number', default: 20 },
          },
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
const isNonEmptyObject = (value) => isObject(value) && Object.keys(value).length > 0;
// Order-insensitive structural equality for plain JSON config maps. Used by the
// trust-policy migration to decide whether a legacy key and its canonical
// counterpart actually disagree (a re-normalized config carries both, deep-equal).
const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
};
const deepEqualJson = (a, b) => stableStringify(a) === stableStringify(b);
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

const formatJsonLoadError = (filePath, err, label = 'Gigabrain config') => {
  const reason = err instanceof Error ? err.message : String(err);
  return new Error(`Invalid JSON in ${label} at ${filePath}: ${reason}`);
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

  // --- Trust policy migration -----------------------------------------------
  // Resolve the two host-trust maps from the explicit `trust.*` section, falling
  // back to the legacy keys. "Set" = a non-empty object in the RAW config (the
  // DEFAULT_CONFIG contributes empty {} maps, which count as unset). If BOTH a
  // legacy key and its canonical counterpart are set and DISAGREE, throw loudly
  // rather than silently pick a precedence — an operator trust pin is a security
  // control and a silent mirror could disable it invisibly. A re-normalized
  // config carries both keys deep-equal, so idempotency does not trip the guard.
  const rawTrust = isObject(rawConfig?.trust) ? rawConfig.trust : {};
  const legacyArb = isObject(rawConfig?.hostTrust) ? rawConfig.hostTrust : null;
  const canonArb = isObject(rawTrust.arbitrationHostTrust) ? rawTrust.arbitrationHostTrust : null;
  const legacyScore = isObject(rawConfig?.worldModel?.hostTrust) ? rawConfig.worldModel.hostTrust : null;
  const canonScore = isObject(rawTrust.scoringHostTrust) ? rawTrust.scoringHostTrust : null;
  if (isNonEmptyObject(canonArb) && isNonEmptyObject(legacyArb) && !deepEqualJson(canonArb, legacyArb)) {
    throw new Error(
      'Conflicting trust config: `trust.arbitrationHostTrust` and legacy `hostTrust` are both set and differ. '
      + 'Remove the legacy `hostTrust` key — it has been renamed to `trust.arbitrationHostTrust`.',
    );
  }
  if (isNonEmptyObject(canonScore) && isNonEmptyObject(legacyScore) && !deepEqualJson(canonScore, legacyScore)) {
    throw new Error(
      'Conflicting trust config: `trust.scoringHostTrust` and legacy `worldModel.hostTrust` are both set and differ. '
      + 'Remove the legacy `worldModel.hostTrust` key — it has been renamed to `trust.scoringHostTrust`.',
    );
  }
  const resolvedArbitrationHostTrust = isNonEmptyObject(canonArb) ? canonArb : (isObject(legacyArb) ? legacyArb : {});
  const resolvedScoringHostTrust = isNonEmptyObject(canonScore) ? canonScore : (isObject(legacyScore) ? legacyScore : {});
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
      autoInjectEnabled: merged?.recall?.autoInjectEnabled === true,
      topK: Math.max(1, Math.min(50, Number(merged?.recall?.topK ?? 8) || 8)),
      // recall.minScore was removed after a drift review: it was declared,
      // consumed by NOTHING — a documented-looking knob that did nothing and
      // shadowed the real floor at recall.relevanceFloor.
      maxTokens: Math.max(100, Math.min(8000, Number(merged?.recall?.maxTokens ?? 1200) || 1200)),
      mode: ['personal_core', 'project_context', 'hybrid'].includes(String(merged?.recall?.mode || 'hybrid'))
        ? String(merged?.recall?.mode)
        : 'hybrid',
      classBudgets: normalizeBudgets(merged?.recall?.classBudgets || {}),
      semanticRerankEnabled: merged?.recall?.semanticRerankEnabled !== false,
      relevanceFloor: {
        enabled: merged?.recall?.relevanceFloor?.enabled !== false,
        minMatchedTokens: Math.max(1, Number(merged?.recall?.relevanceFloor?.minMatchedTokens ?? 2) || 2),
        denseCosine: Math.max(0, Math.min(1, Number(merged?.recall?.relevanceFloor?.denseCosine ?? 0.65))),
      },
      // E2: clamp to (0, 1]. >1.0 is forbidden by design — vault is reference,
      // never belief, and must never outrank a native memory; <=0 falls back to
      // the neutral 1.0 default rather than zeroing vault recall entirely.
      vaultWeight: (() => {
        const raw = Number(merged?.recall?.vaultWeight);
        if (!Number.isFinite(raw) || raw <= 0) return 1.0;
        return Math.min(1.0, raw);
      })(),
      crossEncoderRerankEnabled: merged?.recall?.crossEncoderRerankEnabled === true,
      ollamaUrl: String(merged?.recall?.ollamaUrl || 'http://127.0.0.1:11434').trim(),
      embeddingModel: String(merged?.recall?.embeddingModel || 'bge-m3').trim(),
      embeddingTimeoutMs: Math.max(1000, Math.min(30000, Number(merged?.recall?.embeddingTimeoutMs ?? 5000) || 5000)),
      adaptiveBudgeting: {
        ...merged?.recall?.adaptiveBudgeting,
        enabled: merged?.recall?.adaptiveBudgeting?.enabled !== false,
      },
      // R5: iterative multi-hop recall expansion. Default OFF (the recall gate
      // must be byte-identical when disabled); when ON, walk entity edges for
      // `hops` bounded rounds and union the results (see multi-hop-recall.js).
      multiHop: {
        enabled: merged?.recall?.multiHop?.enabled === true,
        hops: Math.max(0, Math.min(4, Math.trunc(Number(merged?.recall?.multiHop?.hops ?? 2)) || 2)),
        entitiesPerHop: Math.max(1, Math.min(20, Math.trunc(Number(merged?.recall?.multiHop?.entitiesPerHop ?? 5)) || 5)),
        rowsPerEntity: Math.max(1, Math.min(20, Math.trunc(Number(merged?.recall?.multiHop?.rowsPerEntity ?? 6)) || 6)),
        maxTotal: Math.max(1, Math.min(200, Math.trunc(Number(merged?.recall?.multiHop?.maxTotal ?? 40)) || 40)),
      },
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
      multiEntityEnabled: merged?.orchestrator?.multiEntityEnabled !== false,
      fallbackChainEnabled: merged?.orchestrator?.fallbackChainEnabled !== false,
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
      evolutionEnabled: merged?.worldModel?.evolutionEnabled !== false,
      autoResolveLoops: merged?.worldModel?.autoResolveLoops !== false,
      llmContradictionReview: merged?.worldModel?.llmContradictionReview === true,
      arbiter: {
        ...merged?.worldModel?.arbiter,
        clusterThreshold: clamp01(
          merged?.worldModel?.arbiter?.clusterThreshold ?? DEFAULT_CONFIG.worldModel.arbiter.clusterThreshold,
        ),
        clusterLlmRefinement: merged?.worldModel?.arbiter?.clusterLlmRefinement === true,
        recencyAmbiguityWindowMs: clampInt(
          merged?.worldModel?.arbiter?.recencyAmbiguityWindowMs,
          0,
          3600000,
          DEFAULT_CONFIG.worldModel.arbiter.recencyAmbiguityWindowMs,
        ),
        independenceWindowMs: clampInt(
          merged?.worldModel?.arbiter?.independenceWindowMs,
          0,
          86400000,
          DEFAULT_CONFIG.worldModel.arbiter.independenceWindowMs,
        ),
        supportCapPerSource: clampInt(
          merged?.worldModel?.arbiter?.supportCapPerSource,
          1,
          100,
          DEFAULT_CONFIG.worldModel.arbiter.supportCapPerSource,
        ),
      },
    },
    synthesis: {
      ...merged?.synthesis,
      enabled: merged?.synthesis?.enabled !== false,
      briefing: {
        ...merged?.synthesis?.briefing,
        enabled: merged?.synthesis?.briefing?.enabled !== false,
        includeSessionPrelude: merged?.synthesis?.briefing?.includeSessionPrelude === true,
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
      maxCompactFiles: Math.max(1, Number(merged?.maintenance?.maxCompactFiles ?? 5) || 5),
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
      // E1: each vault entry resolves { path (required, absolute), glob?, weight?,
      // maxFileKB? }; entries without a usable path are dropped. Default [] keeps
      // vault-sync a zero-cost no-op.
      vaults: (Array.isArray(merged?.native?.vaults) ? merged.native.vaults : [])
        .map((entry) => {
          if (!entry || typeof entry !== 'object') return null;
          const rawPath = String(entry.path || '').trim();
          if (!rawPath) return null;
          const out = {
            path: resolvePathMaybeRelative(workspaceRoot, rawPath, rawPath),
          };
          const glob = String(entry.glob || '').trim();
          if (glob) out.glob = glob;
          if (Number.isFinite(Number(entry.weight))) out.weight = Number(entry.weight);
          if (Number.isFinite(Number(entry.maxFileKB))) {
            out.maxFileKB = Math.max(1, Math.min(65536, Number(entry.maxFileKB)));
          }
          return out;
        })
        .filter(Boolean),
      vaultSyncMaxFiles: clampInt(
        merged?.native?.vaultSyncMaxFiles,
        0,
        1000000,
        Number(DEFAULT_CONFIG.native.vaultSyncMaxFiles),
      ),
      // #6: cloud-inbox drop folder. `dir` accepts a leading ~ (expanded to the
      // home dir) or a workspace-relative path. enabled:false default → the
      // scanner never touches disk. staleDays drives the doctor nudge.
      cloudInbox: {
        enabled: merged?.native?.cloudInbox?.enabled === true,
        dir: (() => {
          const raw = String(merged?.native?.cloudInbox?.dir || DEFAULT_CONFIG.native.cloudInbox.dir).trim()
            || DEFAULT_CONFIG.native.cloudInbox.dir;
          const home = os.homedir() || process.env.HOME || '';
          const expanded = raw === '~' ? home
            : raw.startsWith('~/') ? path.join(home, raw.slice(2))
              : raw;
          return resolvePathMaybeRelative(workspaceRoot, expanded, expanded);
        })(),
        staleDays: clampInt(
          merged?.native?.cloudInbox?.staleDays,
          1,
          3650,
          Number(DEFAULT_CONFIG.native.cloudInbox.staleDays),
        ),
      },
      // idea #1 (transcript / rollout CDC harvester). enabled:false default →
      // zero-cost no-op. Globs are kept verbatim (tilde-expanded lazily inside
      // the harvester walker, so a ~ stays portable across machines/tests).
      transcripts: {
        enabled: merged?.native?.transcripts?.enabled === true,
        globs: (() => {
          const list = normalizeStringArray(
            (merged?.native?.transcripts?.globs && merged.native.transcripts.globs.length > 0)
              ? merged.native.transcripts.globs
              : DEFAULT_CONFIG.native.transcripts.globs,
          );
          return list.length > 0 ? list : DEFAULT_CONFIG.native.transcripts.globs.slice();
        })(),
        maxFiles: clampInt(
          merged?.native?.transcripts?.maxFiles,
          1,
          1000,
          Number(DEFAULT_CONFIG.native.transcripts.maxFiles),
        ),
        maxTurns: clampInt(
          merged?.native?.transcripts?.maxTurns,
          1,
          20000,
          Number(DEFAULT_CONFIG.native.transcripts.maxTurns),
        ),
      },
      // idea #5 (git-versioned LLM-wiki). enabled:false default → zero-cost
      // no-op. `dir` accepts a leading ~ (expanded to home) or a workspace-
      // relative path; the tilde is expanded lazily inside wiki-project.js so a
      // ~ stays portable across machines/tests.
      wiki: {
        enabled: merged?.native?.wiki?.enabled === true,
        dir: String(merged?.native?.wiki?.dir || DEFAULT_CONFIG.native.wiki.dir).trim()
          || DEFAULT_CONFIG.native.wiki.dir,
      },
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
    person: {
      ...merged.person,
      keepPublicFacts: merged?.person?.keepPublicFacts !== false,
      relationshipPriorityBoost: Math.max(0, Math.min(2, Number(merged?.person?.relationshipPriorityBoost ?? DEFAULT_CONFIG.person.relationshipPriorityBoost) || DEFAULT_CONFIG.person.relationshipPriorityBoost)),
      publicProfileBoost: Math.max(0, Math.min(2, Number(merged?.person?.publicProfileBoost ?? DEFAULT_CONFIG.person.publicProfileBoost) || DEFAULT_CONFIG.person.publicProfileBoost)),
      requireWordBoundaryMatch: merged?.person?.requireWordBoundaryMatch !== false,
    },
    // U16: STRICT opt-in — counters collect only on an explicit `true`.
    telemetry: {
      countersEnabled: merged?.telemetry?.countersEnabled === true,
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
    vault: {
      inbox: {
        enabled: merged?.vault?.inbox?.enabled === true,
        apiUrl: String(merged?.vault?.inbox?.apiUrl || DEFAULT_CONFIG.vault.inbox.apiUrl).trim()
          || DEFAULT_CONFIG.vault.inbox.apiUrl,
        notePath: String(merged?.vault?.inbox?.notePath || DEFAULT_CONFIG.vault.inbox.notePath).trim()
          || DEFAULT_CONFIG.vault.inbox.notePath,
        apiKey: String(merged?.vault?.inbox?.apiKey || '').trim(),
        apiKeyPath: String(merged?.vault?.inbox?.apiKeyPath || '').trim(),
        caPath: String(merged?.vault?.inbox?.caPath || '').trim(),
        maxFindings: clampInt(
          merged?.vault?.inbox?.maxFindings,
          1,
          100,
          Number(DEFAULT_CONFIG.vault.inbox.maxFindings),
        ),
      },
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
  // Canonical resolved trust policy.
  out.trust = {
    arbitrationHostTrust: resolvedArbitrationHostTrust,
    scoringHostTrust: resolvedScoringHostTrust,
  };
  // Belt-and-suspenders: keep the legacy keys populated so any consumer that
  // was not migrated to the canonical paths still resolves the SAME maps.
  // Populate only when non-empty so an unconfigured config stays clean (no
  // stray empty `hostTrust` key) and idempotent under re-normalization.
  if (isNonEmptyObject(resolvedArbitrationHostTrust)) {
    out.hostTrust = resolvedArbitrationHostTrust;
  }
  if (isNonEmptyObject(resolvedScoringHostTrust)) {
    out.worldModel = { ...out.worldModel, hostTrust: resolvedScoringHostTrust };
  }
  return out;
};

const resolveGigabrainConfig = (openclawConfig = {}) => {
  const entry = openclawConfig?.plugins?.entries?.gigabrain;
  if (!isObject(entry)) return {};
  return isObject(entry.config) ? entry.config : {};
};

const loadJsonIfExists = (filePath, fallback = {}, options = {}) => {
  if (!filePath) return fallback;
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (options?.failOnMalformed === false) return fallback;
    throw formatJsonLoadError(filePath, err, options?.label || 'Gigabrain config');
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
    config: loadJsonIfExists(resolvedPath, {}, { label: 'OpenClaw config' }),
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
    const loadedConfig = loadJsonIfExists(options.configPath, {}, { label: 'Gigabrain config' });
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
    const rawConfig = loadJsonIfExists(standalonePath, {}, { label: 'standalone Gigabrain config' });
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
