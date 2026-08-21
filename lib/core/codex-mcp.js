import { createRequire } from 'node:module';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');

const SERVER_NAME = 'gigabrain';
const SERVER_VERSION = String(packageJson.version || '0.0.0');

const readOnlyAnnotations = (title) => ({
  title,
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const additiveWriteAnnotations = (title) => ({
  title,
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
});

const recallResultSchema = z.object({
  origin: z.string(),
  memory_id: z.string(),
  type: z.string(),
  content: z.string(),
  scope: z.string(),
  source_layer: z.string(),
  source_host: z.string(),
  source_kind: z.string(),
  sync_policy: z.string(),
  source_path: z.string(),
  source_line: z.number().int().nullable(),
  source_links: z.array(z.any()).optional(),
  score: z.number(),
  confidence: z.number(),
  updated_at: z.string(),
  created_at: z.string(),
  memory_tier: z.string(),
  // U15 arbitrated provenance (MCP parity with the injection surface):
  // hybrid_strength = leg-normalized fusion percentile when hybrid recall ran
  // (review F5); verdict_ref = arbitration-ledger event id when the row is a
  // recorded verdict winner (drill down via gigabrain_arbitrate);
  // unresolved_conflict = the row belongs to a review-queued/uncertain
  // conflict and must not be treated as the silently-picked truth.
  relevance: z.object({
    dense_cosine: z.number().nullable(),
    entity_match: z.boolean(),
    matched_tokens: z.number().optional(),
    lexical_coverage: z.number().optional(),
    accepted: z.boolean().optional(),
  }).optional(),
  hybrid_strength: z.number().nullable(),
  source_agent: z.string().nullable(),
  trust_tier: z.string(),
  trust_score: z.number(),
  verdict_ref: z.string().nullable(),
  valid_window: z.object({
    from: z.string().nullable(),
    until: z.string().nullable(),
  }),
  unresolved_conflict: z.boolean(),
});

const recallOutputSchema = {
  ok: z.boolean(),
  query: z.string(),
  target: z.enum(['project', 'user', 'both']),
  strategy: z.string(),
  ranking_mode: z.string(),
  used_world_model: z.boolean(),
  confidence: z.number(),
  // Honest retrieval: no_match means the floor rejected everything — do not
  // assume prior context. relevance_floor carries the decision diagnostics.
  match_status: z.enum(['ok', 'no_match']),
  relevance_floor: z.object({
    applied: z.boolean(),
    min_matched_tokens: z.number().optional(),
    dense_cosine_threshold: z.number().optional(),
    query_tokens: z.number().optional(),
    candidates_considered: z.number().optional(),
    top_dense_cosine: z.number().nullable().optional(),
    top_lexical_coverage: z.number().optional(),
    dense_available: z.boolean().optional(),
  }),
  guidance: z.string(),
  results: z.array(recallResultSchema),
  receipt_id: z.string().optional(),
  policy_version: z.string().optional(),
  ledger_snapshot: z.string().optional(),
};

const rememberOutputSchema = {
  ok: z.boolean(),
  // Honest write acknowledgement: committed | deduplicated | pending_review |
  // not_stored. ok:true alone never proves the memory became recallable.
  status: z.enum(['committed', 'deduplicated', 'pending_review', 'not_stored']),
  recallable: z.boolean(),
  target: z.enum(['project', 'user']),
  type: z.string(),
  durability: z.enum(['durable', 'ephemeral']),
  scope: z.string(),
  memory_id: z.string(),
  written_native: z.boolean(),
  written_registry: z.boolean(),
  source_path: z.string(),
  source_line: z.number().int().nullable(),
  source_kind: z.string(),
  duplicate: z.string(),
  queued_review: z.number(),
  native_sync: z.object({
    changed_files: z.number(),
    inserted_chunks: z.number(),
  }).passthrough(),
};

const checkpointOutputSchema = {
  ok: z.boolean(),
  target: z.literal('project'),
  schema_version: z.literal('checkpoint.1'),
  checkpoint_id: z.string(),
  session_id: z.string(),
  receipt_id: z.string(),
  proposal_ids: z.array(z.string()),
  scope: z.string(),
  session_label: z.string(),
  deduplicated: z.boolean(),
  written_native: z.boolean(),
  source_path: z.string(),
  source_line: z.number().int().nullable(),
  source_kind: z.string(),
  written_sections: z.array(z.string()),
  item_count: z.number(),
  native_sync: z.object({
    changed_files: z.number(),
    inserted_chunks: z.number(),
  }).passthrough(),
};

const checkpointItemSchema = z.object({
  item_id: z.string(),
  checkpoint_id: z.string(),
  kind: z.enum(['decision', 'open_loop', 'touched_file', 'durable_candidate', 'evidence']),
  position: z.number().int().min(0),
  content: z.string(),
  evidence_refs: z.array(z.string()),
  payload: z.record(z.string(), z.any()),
  record_hash: z.string(),
});

const checkpointSchema = z.object({
  schema_version: z.literal('checkpoint.1'),
  checkpoint_id: z.string(),
  session_id: z.string(),
  parent_checkpoint_id: z.string().nullable(),
  created_at: z.string(),
  scope: z.string(),
  source: z.object({
    agent: z.string(),
    client: z.string(),
    host: z.string(),
  }),
  repo: z.object({
    root: z.string(),
    branch: z.string(),
    commit: z.string(),
    dirty: z.boolean(),
  }),
  summary: z.string(),
  outcome_status: z.string(),
  source_ref: z.object({
    path: z.string(),
    line: z.number().int().nullable(),
    kind: z.string(),
  }),
  legacy_untyped: z.boolean(),
  decisions: z.array(z.union([checkpointItemSchema, z.string()])),
  open_loops: z.array(z.union([checkpointItemSchema, z.string()])),
  touched_files: z.array(z.union([checkpointItemSchema, z.string()])),
  durable_candidates: z.array(z.union([checkpointItemSchema, z.string()])),
  evidence: z.array(z.union([checkpointItemSchema, z.string()])),
  proposal_ids: z.array(z.string()),
  payload: z.record(z.string(), z.any()),
  record_hash: z.string(),
});

const claimEventSchema = z.object({
  event_id: z.string(),
  created_at: z.string(),
  action: z.enum(['proposed', 'accepted', 'rejected', 'superseded']),
  actor: z.object({ id: z.string(), host: z.string() }),
  reason: z.string(),
  memory_id: z.string().nullable(),
  receipt_id: z.string().nullable(),
  payload: z.record(z.string(), z.any()),
  record_hash: z.string(),
});

const claimProposalSchema = z.object({
  schema_version: z.literal('claim.1'),
  proposal_id: z.string(),
  created_at: z.string(),
  checkpoint_id: z.string().nullable(),
  checkpoint_item_id: z.string().nullable(),
  scope: z.string(),
  claim_type: z.string(),
  content: z.string(),
  evidence_class: z.enum([
    'owner_assertion',
    'project_decision',
    'operational_observation',
    'evaluation_result',
    'agent_inference',
    'external_reference',
  ]),
  evidence_refs: z.array(z.string()),
  source: z.object({ agent: z.string(), host: z.string() }),
  ancestry_cluster: z.string(),
  confidence: z.number().nullable(),
  valid_window: z.object({ from: z.string().nullable(), until: z.string().nullable() }),
  status: z.enum(['proposed', 'accepted', 'rejected', 'superseded']),
  memory_id: z.string().nullable(),
  events: z.array(claimEventSchema),
  payload: z.record(z.string(), z.any()),
  record_hash: z.string(),
});

const receiptSchema = z.object({
  schema_version: z.literal('receipt.1'),
  receipt_id: z.string(),
  created_at: z.string(),
  receipt_type: z.string(),
  status: z.string(),
  scope: z.string(),
  actor: z.object({ id: z.string(), host: z.string() }),
  session_id: z.string().nullable(),
  policy_version: z.string(),
  ledger_snapshot: z.string(),
  input_refs: z.array(z.string()),
  output_refs: z.array(z.string()),
  evidence_refs: z.array(z.string()),
  summary: z.string(),
  payload: z.record(z.string(), z.any()),
  receipt_hash: z.string(),
});

const recentOutputSchema = {
  ok: z.boolean(),
  target: z.enum(['project', 'user', 'both']),
  results: z.array(recallResultSchema),
};

const sourceRowSchema = z.object({
  source_host: z.string(),
  source_kind: z.string(),
  sync_policy: z.string(),
  source_path: z.string(),
}).passthrough();

const syncHostRowSchema = z.object({
  source_host: z.string(),
  local_sources_detected: z.number(),
  last_sync_at: z.string(),
  status: z.string(),
  indexed_count: z.number(),
  linked_count: z.number(),
  skipped_count: z.number(),
  sync_policy: z.string(),
  error: z.string(),
}).passthrough();

const sourcesStoreSchema = z.object({
  target: z.string(),
  ok: z.boolean(),
  sources: z.array(sourceRowSchema),
  discovered: z.array(sourceRowSchema).optional(),
  warnings: z.array(z.any()).optional(),
  error: z.string().optional(),
}).passthrough();

const syncStatusStoreSchema = z.object({
  target: z.string(),
  ok: z.boolean(),
  hosts: z.array(syncHostRowSchema),
  groups: z.object({
    ready: z.array(syncHostRowSchema),
    never_synced: z.array(syncHostRowSchema),
    manual_only: z.array(syncHostRowSchema),
    bridge: z.array(syncHostRowSchema),
  }).optional(),
  warnings: z.array(z.any()).optional(),
  hermes_bridge: z.object({
    mode: z.string(),
    configured: z.boolean(),
    base_url: z.string(),
  }).passthrough().optional(),
  error: z.string().optional(),
}).passthrough();

const sourcesOutputSchema = {
  ok: z.boolean(),
  target: z.enum(['project', 'user', 'both']),
  stores: z.array(sourcesStoreSchema),
};

const syncStatusOutputSchema = {
  ok: z.boolean(),
  target: z.enum(['project', 'user', 'both']),
  stores: z.array(syncStatusStoreSchema),
};

const exportBriefOutputSchema = {
  ok: z.boolean(),
  target: z.enum(['project', 'user']),
  target_host: z.string(),
  format: z.string(),
  scope: z.string(),
  item_count: z.number(),
  omitted_secret_risks: z.number(),
  brief: z.string(),
  config_project_root: z.string(),
};

const doctorStoreSchema = z.object({
  target: z.string(),
  ok: z.boolean(),
  workspace_root: z.string(),
  db_path: z.string(),
  db_exists: z.boolean(),
  memory_md_path: z.string(),
  memory_md_exists: z.boolean(),
  error: z.string().optional(),
  stats: z.object({
    total: z.number(),
    status: z.record(z.string(), z.number()),
  }),
});

const doctorOutputSchema = {
  ok: z.boolean(),
  build: z.object({
    module_path: z.string(),
    commit: z.string(),
  }).optional(),
  source: z.string(),
  config_path: z.string(),
  sharing_mode: z.string().optional(),
  standalone_path_kind: z.string().optional(),
  canonical_config_path: z.string().optional(),
  legacy_config_path: z.string().optional(),
  project_root: z.string(),
  store_mode: z.string(),
  project_scope: z.string(),
  primary_store_path: z.string(),
  project_store_path: z.string(),
  user_profile_path: z.string(),
  stores: z.array(doctorStoreSchema),
  remote_bridge: z.object({
    enabled: z.boolean(),
    ok: z.boolean(),
    base_url: z.string(),
    error: z.string().optional(),
  }),
};

const normalizeArgs = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

let cachedServicesPromise = null;
const loadServices = async () => {
  if (!cachedServicesPromise) {
    cachedServicesPromise = import('./codex-service.js');
  }
  return cachedServicesPromise;
};

const buildToolResponse = (payload) => ({
  content: [
    {
      type: 'text',
      text: JSON.stringify(payload, null, 2),
    },
  ],
  structuredContent: payload,
});

const REMOTE_TOOL_OAUTH_SCOPES = Object.freeze({
  gigabrain_checkpoint: 'gigabrain:checkpoint',
  gigabrain_claim_propose: 'gigabrain:propose',
  gigabrain_claim_decide: 'gigabrain:commit',
  gigabrain_receipt_write: 'gigabrain:receipt',
});

const createMcpServer = (defaults = {}) => {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });
  const enabledTools = Array.isArray(defaults.enabledTools)
    ? new Set(defaults.enabledTools.map((item) => String(item || '').trim()).filter(Boolean))
    : null;
  const remoteProfile = String(defaults.transportProfile || '').trim().toLowerCase() === 'remote';
  const remoteDefaultTarget = remoteProfile
    && Array.isArray(defaults.allowedScopes)
    && defaults.allowedScopes.length === 1
    && String(defaults.allowedScopes[0] || '').startsWith('profile:')
    ? 'user'
    : 'project';
  const registerTool = server.registerTool.bind(server);
  server.registerTool = (name, definition, handler) => {
    if (enabledTools && !enabledTools.has(String(name))) return undefined;
    const oauthScope = REMOTE_TOOL_OAUTH_SCOPES[name] || 'gigabrain:read';
    const securedDefinition = remoteProfile
      ? {
        ...definition,
        _meta: {
          ...(definition._meta || {}),
          securitySchemes: [{ type: 'oauth2', scopes: [oauthScope] }],
        },
      }
      : definition;
    return registerTool(name, securedDefinition, handler);
  };

  server.registerTool('gigabrain_recall', {
    description: 'Recall Gigabrain memories for the current standalone workspace. Use target=user for stable personal memory and target=project for repo-specific continuity.',
    annotations: readOnlyAnnotations('Recall memories'),
    inputSchema: {
      query: z.string().min(1),
      target: z.enum(['project', 'user', 'both']).optional(),
      scope: z.string().optional(),
      top_k: z.number().int().min(1).max(25).optional(),
      include_provenance: z.boolean().optional(),
      record_receipt: z.boolean().optional(),
    },
    outputSchema: recallOutputSchema,
  }, async (args) => {
    const { runRecall } = await loadServices();
    return buildToolResponse(await runRecall({
      ...defaults,
      query: args.query,
      target: args.target || (remoteProfile ? remoteDefaultTarget : undefined),
      scope: args.scope,
      topK: args.top_k,
      includeProvenance: args.include_provenance === true,
      includeLocalPaths: defaults.includeLocalPaths !== false,
      recordReceipt: defaults.recordReceipts === true || args.record_receipt === true,
    }));
  });

  server.registerTool('gigabrain_remember', {
    description: 'Persist an explicit memory into the repo store or the personal user store. Use target=user for stable personal preferences/facts and target=project for repo decisions/context.',
    annotations: additiveWriteAnnotations('Remember memory'),
    inputSchema: {
      content: z.string().min(1),
      type: z.string().optional(),
      durability: z.enum(['durable', 'ephemeral']).optional(),
      target: z.enum(['project', 'user']).optional(),
      scope: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
    },
    outputSchema: rememberOutputSchema,
  }, async (args) => {
    const { runRemember } = await loadServices();
    return buildToolResponse(runRemember({
      ...defaults,
      content: args.content,
      type: args.type,
      durability: args.durability,
      target: args.target,
      scope: args.scope,
      confidence: args.confidence,
    }));
  });

  server.registerTool('gigabrain_checkpoint', {
    description: "Write at most one structured checkpoint per session into today's local Gigabrain log.",
    annotations: additiveWriteAnnotations('Write checkpoint'),
    inputSchema: {
      summary: z.string().optional(),
      session_label: z.string().optional(),
      session_id: z.string().optional(),
      parent_checkpoint_id: z.string().optional(),
      scope: z.string().optional(),
      decisions: z.array(z.string()).optional(),
      open_loops: z.array(z.string()).optional(),
      touched_files: z.array(z.string()).optional(),
      durable_candidates: z.array(z.string()).optional(),
      evidence_refs: z.array(z.string()).optional(),
      outcome_status: z.string().optional(),
    },
    outputSchema: checkpointOutputSchema,
  }, async (args) => {
    const { runCheckpoint } = await loadServices();
    return buildToolResponse(runCheckpoint({
      ...defaults,
      summary: args.summary,
      sessionLabel: args.session_label,
      sessionId: args.session_id,
      parentCheckpointId: args.parent_checkpoint_id,
      scope: args.scope,
      decisions: args.decisions,
      openLoops: args.open_loops,
      touchedFiles: args.touched_files,
      durableCandidates: args.durable_candidates,
      evidenceRefs: args.evidence_refs,
      outcomeStatus: args.outcome_status,
    }));
  });

  server.registerTool('gigabrain_checkpoint_list', {
    description: 'List first-class Gigabrain checkpoint episodes exactly, with source/session/repository filters and opaque pagination.',
    annotations: readOnlyAnnotations('List checkpoints'),
    inputSchema: {
      scope: z.string().optional(),
      source_agent: z.string().optional(),
      session_id: z.string().optional(),
      repo_commit: z.string().optional(),
      since: z.string().optional(),
      until: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      cursor: z.string().optional(),
      all_scopes: z.boolean().optional(),
      include_local_paths: z.boolean().optional(),
    },
    outputSchema: {
      ok: z.boolean(),
      target: z.literal('project'),
      scope: z.string().nullable(),
      schema_version: z.literal('checkpoint.1'),
      checkpoints: z.array(checkpointSchema),
      next_cursor: z.string().nullable(),
    },
  }, async (args) => {
    const { runCheckpointList } = await loadServices();
    return buildToolResponse(runCheckpointList({
      ...defaults,
      ...args,
      includeLocalPaths: defaults.includeLocalPaths === false ? false : args.include_local_paths,
    }));
  });

  server.registerTool('gigabrain_checkpoint_get', {
    description: 'Get one exact checkpoint episode by id. The same project-scope policy used by list/search is enforced before the object is returned.',
    annotations: readOnlyAnnotations('Get checkpoint'),
    inputSchema: {
      checkpoint_id: z.string().min(1),
      scope: z.string().optional(),
      include_local_paths: z.boolean().optional(),
    },
    outputSchema: {
      ok: z.boolean(),
      target: z.literal('project'),
      checkpoint: checkpointSchema,
    },
  }, async (args) => {
    const { runCheckpointGet } = await loadServices();
    return buildToolResponse(runCheckpointGet({
      ...defaults,
      ...args,
      includeLocalPaths: defaults.includeLocalPaths === false ? false : args.include_local_paths,
    }));
  });

  server.registerTool('gigabrain_claim_propose', {
    description: 'Record a typed claim proposal with evidence lineage. Proposals are not recallable memories and require a separate review decision.',
    annotations: additiveWriteAnnotations('Propose claim'),
    inputSchema: {
      content: z.string().min(1),
      claim_type: z.string().optional(),
      evidence_class: z.enum([
        'owner_assertion',
        'project_decision',
        'operational_observation',
        'evaluation_result',
        'agent_inference',
        'external_reference',
      ]),
      evidence_refs: z.array(z.string()).optional(),
      checkpoint_id: z.string().optional(),
      checkpoint_item_id: z.string().optional(),
      scope: z.string().optional(),
      confidence: z.number().min(0).max(1).optional(),
      valid_from: z.string().optional(),
      valid_until: z.string().optional(),
    },
    outputSchema: {
      ok: z.boolean(),
      status: z.literal('proposed'),
      recallable: z.literal(false),
      proposal: claimProposalSchema.extend({ receipt_id: z.string() }),
      receipt_id: z.string(),
    },
  }, async (args) => {
    const { runClaimPropose } = await loadServices();
    return buildToolResponse(runClaimPropose({ ...defaults, ...args }));
  });

  server.registerTool('gigabrain_claim_review', {
    description: 'List typed claim proposals and their append-only decision history. This tool does not promote or reject anything.',
    annotations: readOnlyAnnotations('Review claim proposals'),
    inputSchema: {
      scope: z.string().optional(),
      statuses: z.array(z.enum(['proposed', 'accepted', 'rejected', 'superseded'])).optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    outputSchema: {
      ok: z.boolean(),
      read_only: z.literal(true),
      proposals: z.array(claimProposalSchema),
      total: z.number().int(),
    },
  }, async (args) => {
    const { runClaimReview } = await loadServices();
    return buildToolResponse(runClaimReview({ ...defaults, ...args }));
  });

  server.registerTool('gigabrain_claim_decide', {
    description: 'Manually accept, reject, or supersede one claim proposal. Accepted proposals pass evidence-class preconditions before entering the existing explicit memory write path.',
    annotations: additiveWriteAnnotations('Decide claim proposal'),
    inputSchema: {
      proposal_id: z.string().min(1),
      action: z.enum(['accepted', 'rejected', 'superseded']),
      reason: z.string().min(1),
      scope: z.string().optional(),
      authority: z.enum(['owner', 'delegated_owner', 'reviewer']).optional(),
      confidence: z.number().min(0).max(1).optional(),
    },
    outputSchema: {
      ok: z.boolean(),
      action: z.enum(['accepted', 'rejected', 'superseded']),
      proposal_id: z.string(),
      memory: z.any().nullable(),
      memory_id: z.string().nullable(),
      receipt_id: z.string(),
      event_id: z.string(),
    },
  }, async (args) => {
    const { runClaimDecide } = await loadServices();
    return buildToolResponse(runClaimDecide({ ...defaults, ...args }));
  });

  server.registerTool('gigabrain_receipt_write', {
    description: 'Write an append-only answer or decision receipt tied to a policy version, ledger snapshot, and evidence identifiers.',
    annotations: additiveWriteAnnotations('Write receipt'),
    inputSchema: {
      receipt_type: z.enum(['answer', 'decision', 'action']).optional(),
      status: z.enum(['supported', 'ambiguous', 'stale', 'no_match', 'denied', 'insufficient_evidence', 'recorded']),
      scope: z.string().optional(),
      session_id: z.string().optional(),
      input_refs: z.array(z.string()).optional(),
      output_refs: z.array(z.string()).optional(),
      evidence_refs: z.array(z.string()).optional(),
      summary: z.string().optional(),
    },
    outputSchema: {
      ok: z.boolean(),
      receipt: receiptSchema,
    },
  }, async (args) => {
    const { runReceiptWrite } = await loadServices();
    return buildToolResponse(runReceiptWrite({ ...defaults, ...args }));
  });

  server.registerTool('gigabrain_receipt_get', {
    description: 'Get an exact append-only receipt by id under the same project-scope authorization boundary as recall and checkpoint access.',
    annotations: readOnlyAnnotations('Get receipt'),
    inputSchema: {
      receipt_id: z.string().min(1),
      scope: z.string().optional(),
    },
    outputSchema: {
      ok: z.boolean(),
      receipt: receiptSchema,
    },
  }, async (args) => {
    const { runReceiptGet } = await loadServices();
    return buildToolResponse(runReceiptGet({ ...defaults, ...args }));
  });

  server.registerTool('gigabrain_provenance', {
    description: 'Explain where a Gigabrain memory answer came from, including source paths when available.',
    annotations: readOnlyAnnotations('Explain provenance'),
    inputSchema: {
      query: z.string().optional(),
      memory_id: z.string().optional(),
      target: z.enum(['project', 'user', 'both']).optional(),
      scope: z.string().optional(),
    },
    outputSchema: {
      ok: z.boolean(),
      memory_id: z.string().optional(),
      query: z.string().optional(),
      target: z.enum(['project', 'user', 'both']),
      strategy: z.string(),
      ranking_mode: z.string(),
      used_world_model: z.boolean().optional(),
      confidence: z.number().optional(),
      results: z.array(recallResultSchema),
    },
  }, async (args) => {
    if (!String(args.query || '').trim() && !String(args.memory_id || '').trim()) {
      throw new Error('query or memory_id is required');
    }
    const { runProvenance } = await loadServices();
    return buildToolResponse(await runProvenance({
      ...defaults,
      query: args.query,
      memoryId: args.memory_id,
      target: args.target || (remoteProfile ? remoteDefaultTarget : undefined),
      scope: args.scope,
    }));
  });

  server.registerTool('gigabrain_recent', {
    description: 'List the most recent memories from the selected Gigabrain stores.',
    annotations: readOnlyAnnotations('Recent memories'),
    inputSchema: {
      target: z.enum(['project', 'user', 'both']).optional(),
      scope: z.string().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    outputSchema: recentOutputSchema,
  }, async (args) => {
    const { runRecent } = await loadServices();
    return buildToolResponse(runRecent({
      ...defaults,
      target: args.target || (remoteProfile ? remoteDefaultTarget : undefined),
      scope: args.scope,
      limit: args.limit,
    }));
  });

  server.registerTool('gigabrain_sources', {
    description: 'Show Gigabrain memory sources by host, freshness, counts, and optional local discovery.',
    annotations: readOnlyAnnotations('Memory sources'),
    inputSchema: {
      target: z.enum(['project', 'user', 'both']).optional(),
      include_discovery: z.boolean().optional(),
    },
    outputSchema: sourcesOutputSchema,
  }, async (args) => {
    const { runSources } = await loadServices();
    return buildToolResponse(runSources({
      ...defaults,
      target: args.target,
      includeDiscovery: args.include_discovery === true,
    }));
  });

  server.registerTool('gigabrain_sync_status', {
    description: 'Diagnose host-memory sync availability and last sync state for local agent memory sources.',
    annotations: readOnlyAnnotations('Sync status'),
    inputSchema: {
      target: z.enum(['project', 'user', 'both']).optional(),
    },
    outputSchema: syncStatusOutputSchema,
  }, async (args) => {
    const { runSyncStatus } = await loadServices();
    return buildToolResponse(runSyncStatus({
      ...defaults,
      target: args.target,
    }));
  });

  server.registerTool('gigabrain_export_brief', {
    description: 'Generate a safe host-specific Memory Brief for AGENTS.md, CLAUDE.md, or manual cloud-product import.',
    annotations: readOnlyAnnotations('Export memory brief'),
    inputSchema: {
      target: z.enum(['project', 'user']).optional(),
      target_host: z.string().optional(),
      scope: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      all_scopes: z.boolean().optional(),
    },
    outputSchema: exportBriefOutputSchema,
  }, async (args) => {
    const { runExportBrief } = await loadServices();
    return buildToolResponse(runExportBrief({
      ...defaults,
      target: args.target,
      targetHost: args.target_host,
      scope: args.scope,
      limit: args.limit,
      allowAllScopes: args.all_scopes === true,
    }));
  });

  server.registerTool('gigabrain_entity', {
    description: 'Retrieve detailed entity information including beliefs, episodes, and evolution timeline from the Gigabrain world model.',
    annotations: readOnlyAnnotations('Entity details'),
    inputSchema: {
      entity_id: z.string().min(1),
      include_evolution: z.boolean().optional(),
      include_beliefs: z.boolean().optional(),
    },
    outputSchema: {
      ok: z.boolean(),
      entity_id: z.string(),
      entity: z.any().optional(),
      beliefs: z.array(z.any()).optional(),
      episodes: z.array(z.any()).optional(),
      open_loops: z.array(z.any()).optional(),
      syntheses: z.array(z.any()).optional(),
      evolution: z.array(z.any()).optional(),
    },
  }, async (args) => {
    const { runEntity } = await loadServices();
    return buildToolResponse(runEntity({
      ...defaults,
      entity_id: args.entity_id,
      include_evolution: args.include_evolution,
      include_beliefs: args.include_beliefs,
    }));
  });

  server.registerTool('gigabrain_contradictions', {
    description: 'List open contradictions in the Gigabrain world model with optional resolution suggestions.',
    annotations: readOnlyAnnotations('Contradiction review'),
    inputSchema: {
      include_suggestions: z.boolean().optional(),
      entity_id: z.string().optional(),
    },
    outputSchema: {
      ok: z.boolean(),
      contradictions: z.array(z.any()),
      total: z.number(),
    },
  }, async (args) => {
    const { runContradictions } = await loadServices();
    return buildToolResponse(runContradictions({
      ...defaults,
      include_suggestions: args.include_suggestions,
      entity_id: args.entity_id,
    }));
  });

  server.registerTool('gigabrain_arbitrate', {
    description: [
      'Resolve a cross-store memory conflict and return the de-conflicted winning belief, the losers it superseded, why it won, and provenance.',
      'Given a subject/entity (or a claim slot), this runs Gigabrain\'s existing belief resolution (the trust > corroboration > recency arbiter) over the cross-store arbitration ledger and reports the recorded verdicts: the winning belief, each loser it superseded, the signals it won on (trust tier, corroboration/support, recency), and the source_agent provenance for every row.',
      'Agent-native parity: this returns the same de-conflicted view a user sees in the Memory Audit.',
      'NOTE: this tool reports verdicts only — it does NOT assert any unverified comparative benchmark claim.',
    ].join(' '),
    annotations: readOnlyAnnotations('Arbitrate conflict'),
    inputSchema: {
      subject: z.string().optional(),
      entity_id: z.string().optional(),
      slot: z.string().optional(),
      limit: z.number().int().min(1).max(200).optional(),
    },
    outputSchema: {
      ok: z.boolean(),
      subject: z.string().nullable().optional(),
      entity_id: z.string().nullable().optional(),
      entity_display_name: z.string().nullable().optional(),
      slot: z.string().nullable().optional(),
      world_model_enabled: z.boolean().optional(),
      verdicts: z.array(z.object({
        // U15: the ledger event id; recall rows carry the same value as
        // verdict_ref, so this tool explains exactly the verdict a recalled
        // winner row references.
        verdict_ref: z.string(),
        winner: z.any().nullable(),
        losers: z.array(z.any()),
        why: z.any(),
        provenance: z.any(),
        recorded_at: z.string().nullable().optional(),
      })),
      total: z.number(),
      note: z.string().optional(),
    },
  }, async (args) => {
    const { runArbitrate } = await loadServices();
    return buildToolResponse(runArbitrate({
      ...defaults,
      subject: args.subject,
      entity_id: args.entity_id,
      slot: args.slot,
      limit: args.limit,
    }));
  });

  server.registerTool('gigabrain_adjudications', {
    description: [
      'List write-time state adjudication verdicts (KEEP/STALE/REPLACE/UNKNOWN) recorded on the Gigabrain ledger.',
      'Each capture decision pass adjudicates the candidate fact against its stored neighbors and appends one verdict per neighbor; this tool reads those ledger events back, optionally filtered to one memory_id and/or a set of states.',
      'Use it to answer "when did Gigabrain learn this fact was stale?" — it is a drill-down over the same ledger that recall provenance and gigabrain_arbitrate reference. It reports recorded events only; it does not re-run any adjudication.',
    ].join(' '),
    annotations: readOnlyAnnotations('Adjudication ledger'),
    inputSchema: {
      memory_id: z.string().optional(),
      states: z.array(z.enum(['KEEP', 'STALE', 'REPLACE', 'UNKNOWN'])).optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    outputSchema: {
      ok: z.boolean(),
      memory_id: z.string().nullable(),
      states: z.array(z.string()).nullable(),
      adjudications: z.array(z.object({
        event_id: z.string(),
        timestamp: z.string().nullable(),
        memory_id: z.string(),
        agent_id: z.string().nullable(),
        state: z.string(),
        decision_op: z.string(),
        candidate_content: z.string(),
        confidence: z.number().nullable(),
        reason: z.string(),
        scope: z.string(),
      })),
      total: z.number(),
    },
  }, async (args) => {
    const { runListAdjudications } = await loadServices();
    return buildToolResponse(runListAdjudications({
      ...defaults,
      memory_id: args.memory_id,
      states: args.states,
      limit: args.limit,
    }));
  });

  server.registerTool('gigabrain_beliefs_as_of', {
    description: [
      'Answer "what was believed true at time T" from Gigabrain\'s bi-temporal ledger.',
      'Returns the beliefs whose event-time validity window (valid_from/valid_until) contained the given ISO timestamp, including rows that were later superseded — they WERE believed true inside their window.',
      'This is an event-time snapshot, not a search: it reports stored validity intervals only and does not rank, infer, or backfill anything.',
    ].join(' '),
    annotations: readOnlyAnnotations('Beliefs as of'),
    inputSchema: {
      at: z.string().min(1).describe('ISO timestamp, e.g. 2026-03-01T00:00:00Z'),
      scope: z.string().optional(),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    outputSchema: {
      ok: z.boolean(),
      at: z.string(),
      scope: z.string().nullable(),
      beliefs: z.array(z.object({
        memory_id: z.string(),
        type: z.string(),
        content: z.string(),
        scope: z.string(),
        status: z.string(),
        confidence: z.number().nullable(),
        valid_from: z.string().nullable(),
        valid_until: z.string().nullable(),
        superseded_by: z.string().nullable(),
        content_time: z.string().nullable(),
      })),
      total: z.number(),
    },
  }, async (args) => {
    const { runBeliefsAsOf } = await loadServices();
    return buildToolResponse(runBeliefsAsOf({
      ...defaults,
      at: args.at,
      scope: args.scope,
      limit: args.limit,
    }));
  });

  server.registerTool('gigabrain_review_queue', {
    description: [
      'List entries in the Gigabrain review queue — the conflicts and capture decisions Gigabrain deliberately did NOT auto-resolve.',
      'Includes the write-time escalations: capture_adjudication_unknown (state verdict UNKNOWN), capture_contradiction_target_stronger (the standing target outranked the candidate), capture_contradiction_adjudication_tie and capture_contradiction_durable_tie (equal-tier ties not allowed to auto-supersede on their channel/tier), plus dedupe/capture review rows.',
      'Filters by status (default pending; pass "all" for every status) and reason_code.',
      'READ-ONLY this unit: it lists queue entries only — resolving or acting on an entry is future scope and is not exposed by this tool.',
    ].join(' '),
    annotations: readOnlyAnnotations('Review queue'),
    inputSchema: {
      status: z.string().optional().describe('Entry status filter (default "pending"; "all" disables the filter)'),
      reason_code: z.string().optional().describe('Reason-code filter, e.g. capture_contradiction_durable_tie'),
      limit: z.number().int().min(1).max(1000).optional(),
    },
    outputSchema: {
      ok: z.boolean(),
      read_only: z.boolean(),
      status: z.string().nullable(),
      reason_code: z.string().nullable(),
      entries: z.array(z.object({
        status: z.string(),
        reason: z.string(),
        reason_code: z.string(),
        action: z.string(),
        queued_at: z.string().nullable(),
        matched_memory_id: z.string().nullable(),
        scope: z.string(),
        excerpt: z.string(),
        decision_op: z.string(),
        target_id: z.string().nullable(),
        decision_confidence: z.number().nullable(),
        arbiter: z.any().nullable(),
      })),
      total: z.number(),
      malformed_rows: z.number(),
    },
  }, async (args) => {
    const { runReviewQueue } = await loadServices();
    return buildToolResponse(runReviewQueue({
      ...defaults,
      status: args.status,
      reason_code: args.reason_code,
      limit: args.limit,
    }));
  });

  server.registerTool('gigabrain_relationships', {
    description: 'Query entity relationships and co-occurrence data from the Gigabrain world model.',
    annotations: readOnlyAnnotations('Entity relationships'),
    inputSchema: {
      entity_id: z.string().optional(),
      min_evidence: z.number().int().min(1).optional(),
    },
    outputSchema: {
      ok: z.boolean(),
      relationships: z.array(z.any()),
      total: z.number(),
    },
  }, async (args) => {
    const { runRelationships } = await loadServices();
    return buildToolResponse(runRelationships({
      ...defaults,
      entity_id: args.entity_id,
      min_evidence: args.min_evidence,
    }));
  });

  server.registerTool('gigabrain_doctor', {
    description: 'Inspect Gigabrain project-store and user-store health, config, and optional remote bridge status. Explicit user checks fail when the personal store is not configured.',
    annotations: readOnlyAnnotations('Doctor'),
    inputSchema: {
      target: z.enum(['project', 'user', 'both']).optional(),
    },
    outputSchema: doctorOutputSchema,
  }, async (args) => {
    const { runDoctor } = await loadServices();
    return buildToolResponse(await runDoctor({
      ...defaults,
      target: args.target,
    }));
  });

  return server;
};

const startMcpServer = async (defaults = {}, options = {}) => {
  const server = createMcpServer(defaults);
  const transport = options.transport || new StdioServerTransport();
  await server.connect(transport);
  return {
    server,
    transport,
  };
};

export {
  SERVER_NAME,
  SERVER_VERSION,
  createMcpServer,
  startMcpServer,
  normalizeArgs,
};
