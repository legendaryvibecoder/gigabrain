import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';

const SERVER_NAME = 'gigabrain';
const SERVER_VERSION = '0.5.3-standalone';

const recallResultSchema = z.object({
  origin: z.string(),
  memory_id: z.string(),
  type: z.string(),
  content: z.string(),
  scope: z.string(),
  source_layer: z.string(),
  source_path: z.string(),
  source_line: z.number().int().nullable(),
  score: z.number(),
  confidence: z.number(),
  updated_at: z.string(),
  created_at: z.string(),
  memory_tier: z.string(),
});

const recallOutputSchema = {
  ok: z.boolean(),
  query: z.string(),
  target: z.enum(['project', 'user', 'both']),
  strategy: z.string(),
  ranking_mode: z.string(),
  used_world_model: z.boolean(),
  confidence: z.number(),
  results: z.array(recallResultSchema),
};

const rememberOutputSchema = {
  ok: z.boolean(),
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
  scope: z.string(),
  session_label: z.string(),
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

const recentOutputSchema = {
  ok: z.boolean(),
  target: z.enum(['project', 'user', 'both']),
  results: z.array(recallResultSchema),
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

const createMcpServer = (defaults = {}) => {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION,
  });

  server.registerTool('gigabrain_recall', {
    description: 'Recall Gigabrain memories for the current standalone workspace. Use target=user for stable personal memory and target=project for repo-specific continuity.',
    inputSchema: {
      query: z.string().min(1),
      target: z.enum(['project', 'user', 'both']).optional(),
      scope: z.string().optional(),
      top_k: z.number().int().min(1).max(25).optional(),
      include_provenance: z.boolean().optional(),
    },
    outputSchema: recallOutputSchema,
  }, async (args) => {
    const { runRecall } = await loadServices();
    return buildToolResponse(await runRecall({
      ...defaults,
      query: args.query,
      target: args.target,
      scope: args.scope,
      topK: args.top_k,
      includeProvenance: args.include_provenance === true,
    }));
  });

  server.registerTool('gigabrain_remember', {
    description: 'Persist an explicit memory into the repo store or the personal user store. Use target=user for stable personal preferences/facts and target=project for repo decisions/context.',
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
    description: 'Write a native-only standalone session checkpoint into today\'s Gigabrain daily log.',
    inputSchema: {
      summary: z.string().optional(),
      session_label: z.string().optional(),
      scope: z.string().optional(),
      decisions: z.array(z.string()).optional(),
      open_loops: z.array(z.string()).optional(),
      touched_files: z.array(z.string()).optional(),
      durable_candidates: z.array(z.string()).optional(),
    },
    outputSchema: checkpointOutputSchema,
  }, async (args) => {
    const { runCheckpoint } = await loadServices();
    return buildToolResponse(runCheckpoint({
      ...defaults,
      summary: args.summary,
      sessionLabel: args.session_label,
      scope: args.scope,
      decisions: args.decisions,
      openLoops: args.open_loops,
      touchedFiles: args.touched_files,
      durableCandidates: args.durable_candidates,
    }));
  });

  server.registerTool('gigabrain_provenance', {
    description: 'Explain where a Gigabrain memory answer came from, including source paths when available.',
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
      target: args.target,
      scope: args.scope,
    }));
  });

  server.registerTool('gigabrain_recent', {
    description: 'List the most recent memories from the selected Gigabrain stores.',
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
      target: args.target,
      scope: args.scope,
      limit: args.limit,
    }));
  });

  server.registerTool('gigabrain_doctor', {
    description: 'Inspect Gigabrain project-store and user-store health, config, and optional remote bridge status. Explicit user checks fail when the personal store is not configured.',
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
