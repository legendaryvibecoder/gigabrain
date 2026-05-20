import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { createStandaloneCodexConfig } from '../lib/core/codex-project.js';
import { SERVER_VERSION } from '../lib/core/codex-mcp.js';
import { bootstrapStandaloneStore } from '../lib/core/codex-service.js';
import { ensureProjectionStore } from '../lib/core/projection-store.js';
import { ensureWorldModelStore } from '../lib/core/world-model.js';
import packageJson from '../package.json' with { type: 'json' };

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const writeJsonPretty = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

const withTimeout = (promise, label, timeoutMs = 10_000) => {
  let timer = null;
  return Promise.race([
    promise.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(`${label} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    }),
  ]);
};

const assertToolResponse = (response, label) => {
  assert.notEqual(response.isError, true, `${label} should succeed`);
  assert.equal(Boolean(response.structuredContent), true, `${label} should include structuredContent`);
  const textBlock = response.content?.find((item) => item.type === 'text');
  assert.equal(Boolean(textBlock), true, `${label} should include serialized JSON text fallback`);
  assert.deepEqual(JSON.parse(textBlock.text), response.structuredContent, `${label} text fallback should match structuredContent`);
};

const assertToolAnnotations = (tool, expected) => {
  assert.equal(Boolean(tool), true, `${expected.name} should be listed`);
  assert.equal(tool.annotations?.readOnlyHint, expected.readOnlyHint, `${expected.name} readOnlyHint should match`);
  assert.equal(tool.annotations?.destructiveHint, false, `${expected.name} should be non-destructive`);
  assert.equal(tool.annotations?.openWorldHint, false, `${expected.name} should stay local/closed-world`);
};

const connectClient = async ({ configPath, stderrChunks, env = process.env }) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.join(repoRoot, 'scripts', 'gigabrain-mcp.js'),
      '--config',
      configPath,
    ],
    cwd: repoRoot,
    env,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk) => {
    stderrChunks.push(String(chunk));
  });

  const client = new Client({
    name: 'gigabrain-test',
    version: '1.0.0',
  }, {
    capabilities: {},
  });

  await withTimeout(client.connect(transport), 'client.connect');
  return { client, transport };
};

const seedWorldModelFixture = (dbPath) => {
  const db = new DatabaseSync(dbPath);
  try {
    ensureProjectionStore(db);
    ensureWorldModelStore(db);
    db.prepare(`
      INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash, source, source_layer, confidence, scope, status,
        value_score, value_label, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'capture', 'registry', ?, ?, 'active', ?, 'core', ?, ?)
    `).run(
      'wm-riley-vienna',
      'USER_FACT',
      'Riley lives in Vienna.',
      'riley lives in vienna',
      'wm-riley-vienna',
      0.78,
      'shared',
      0.72,
      '2026-01-01T09:00:00.000Z',
      '2026-01-01T09:00:00.000Z',
    );
    db.prepare(`
      INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash, source, source_layer, confidence, scope, status,
        value_score, value_label, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'capture', 'registry', ?, ?, 'active', ?, 'core', ?, ?)
    `).run(
      'wm-riley-berlin',
      'USER_FACT',
      'Riley lives in Berlin now.',
      'riley lives in berlin now',
      'wm-riley-berlin',
      0.93,
      'shared',
      0.81,
      '2026-02-01T09:00:00.000Z',
      '2026-02-01T09:00:00.000Z',
    );
    db.prepare(`
      INSERT INTO memory_current (
        memory_id, type, content, normalized, normalized_hash, source, source_layer, confidence, scope, status,
        value_score, value_label, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'capture', 'registry', ?, ?, 'active', ?, 'core', ?, ?)
    `).run(
      'wm-jordan-partner',
      'USER_FACT',
      'Jordan works closely with Riley.',
      'jordan works closely with riley',
      'wm-jordan-partner',
      0.87,
      'shared',
      0.79,
      '2026-02-05T09:00:00.000Z',
      '2026-02-05T09:00:00.000Z',
    );
    for (const entity of [
      ['person:riley', 'Riley'],
      ['person:jordan', 'Jordan'],
    ]) {
      db.prepare(`
        INSERT INTO memory_entities (
          entity_id, kind, display_name, normalized_name, status, confidence, aliases, created_at, updated_at, payload
        ) VALUES (?, 'person', ?, ?, 'active', 0.9, ?, ?, ?, '{}')
      `).run(
        entity[0],
        entity[1],
        entity[1].toLowerCase(),
        JSON.stringify([entity[1]]),
        '2026-02-10T09:00:00.000Z',
        '2026-02-10T09:00:00.000Z',
      );
    }
    db.prepare(`
      INSERT INTO memory_beliefs (
        belief_id, entity_id, type, content, status, confidence, valid_from, valid_to, supersedes_belief_id,
        source_memory_id, source_layer, source_path, source_line, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'registry', '', NULL, ?)
    `).run(
      'belief:riley-vienna',
      'person:riley',
      'USER_FACT',
      'Riley lives in Vienna.',
      'stale',
      0.78,
      '2026-01-01',
      null,
      null,
      'wm-riley-vienna',
      JSON.stringify({ claim_slot: 'location.current', claim_value: 'Vienna' }),
    );
    db.prepare(`
      INSERT INTO memory_beliefs (
        belief_id, entity_id, type, content, status, confidence, valid_from, valid_to, supersedes_belief_id,
        source_memory_id, source_layer, source_path, source_line, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'registry', '', NULL, ?)
    `).run(
      'belief:riley-berlin',
      'person:riley',
      'USER_FACT',
      'Riley lives in Berlin now.',
      'active',
      0.93,
      '2026-02-01',
      null,
      'belief:riley-vienna',
      'wm-riley-berlin',
      JSON.stringify({ claim_slot: 'location.current', claim_value: 'Berlin' }),
    );
    db.prepare(`
      INSERT INTO memory_open_loops (
        loop_id, kind, title, status, priority, related_entity_id, source_memory_ids, payload
      ) VALUES (?, 'contradiction_review', ?, 'open', 0.8, ?, ?, ?)
    `).run(
      'loop:riley-location',
      'Potential location conflict for Riley',
      'person:riley',
      JSON.stringify(['wm-riley-vienna', 'wm-riley-berlin']),
      JSON.stringify({ topic: 'fact', subtopic: 'location.current' }),
    );
    db.prepare(`
      INSERT INTO memory_entity_relationships (
        relationship_id, entity_id_a, entity_id_b, relationship_type,
        evidence_count, source_memory_ids, confidence, created_at, updated_at
      ) VALUES (?, ?, ?, 'co_occurrence', ?, ?, ?, ?, ?)
    `).run(
      'rel:jordan-riley',
      'person:jordan',
      'person:riley',
      2,
      JSON.stringify(['wm-jordan-partner', 'wm-riley-berlin']),
      0.77,
      '2026-02-11T09:00:00.000Z',
      '2026-02-11T09:00:00.000Z',
    );
    db.prepare(`
      INSERT INTO memory_syntheses (
        synthesis_id, kind, subject_type, subject_id, content, stale, confidence, generated_at, input_hash, payload
      ) VALUES (?, 'entity_brief', 'entity', ?, ?, 0, 0.88, ?, ?, '{}')
    `).run(
      'synth:riley-brief',
      'person:riley',
      'Riley currently lives in Berlin.',
      '2099-01-01T00:00:00.000Z',
      'fixture-riley-brief',
    );
  } finally {
    db.close();
  }
};

const run = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-codex-mcp-'));
  const projectRoot = path.join(root, 'project');
  const globalStorePath = path.join(root, 'home', '.codex', 'gigabrain');
  const configPath = path.join(globalStorePath, 'config.json');
  const userOverlayPath = path.join(root, 'user-profile');
  fs.mkdirSync(projectRoot, { recursive: true });

  const config = createStandaloneCodexConfig({
    projectRoot,
    projectStorePath: globalStorePath,
    userProfilePath: userOverlayPath,
  });
  writeJsonPretty(configPath, config);
  bootstrapStandaloneStore({ configPath });
  const projectScope = config.codex.projectScope;
  assert.equal(SERVER_VERSION, packageJson.version, 'MCP server version should match package.json');

  const stderrChunks = [];
  const { client } = await connectClient({ configPath, stderrChunks });

  try {
    const tools = await withTimeout(client.listTools(), 'client.listTools');
    const toolNames = tools.tools.map((tool) => tool.name);
    const toolByName = new Map(tools.tools.map((tool) => [tool.name, tool]));
    assert.equal(toolNames.includes('gigabrain_recall'), true, 'MCP should expose recall');
    assert.equal(toolNames.includes('gigabrain_remember'), true, 'MCP should expose remember');
    assert.equal(toolNames.includes('gigabrain_checkpoint'), true, 'MCP should expose checkpoint');
    assert.equal(toolNames.includes('gigabrain_provenance'), true, 'MCP should expose provenance');
    assert.equal(toolNames.includes('gigabrain_recent'), true, 'MCP should expose recent');
    assert.equal(toolNames.includes('gigabrain_sources'), true, 'MCP should expose memory sources');
    assert.equal(toolNames.includes('gigabrain_sync_status'), true, 'MCP should expose host sync status');
    assert.equal(toolNames.includes('gigabrain_export_brief'), true, 'MCP should expose memory brief export');
    assert.equal(toolNames.includes('gigabrain_doctor'), true, 'MCP should expose doctor');
    assert.equal(toolNames.includes('gigabrain_entity'), true, 'MCP should expose entity detail');
    assert.equal(toolNames.includes('gigabrain_contradictions'), true, 'MCP should expose contradictions');
    assert.equal(toolNames.includes('gigabrain_relationships'), true, 'MCP should expose relationships');
    assertToolAnnotations(toolByName.get('gigabrain_recall'), { name: 'gigabrain_recall', readOnlyHint: true });
    assertToolAnnotations(toolByName.get('gigabrain_provenance'), { name: 'gigabrain_provenance', readOnlyHint: true });
    assertToolAnnotations(toolByName.get('gigabrain_recent'), { name: 'gigabrain_recent', readOnlyHint: true });
    assertToolAnnotations(toolByName.get('gigabrain_sources'), { name: 'gigabrain_sources', readOnlyHint: true });
    assertToolAnnotations(toolByName.get('gigabrain_sync_status'), { name: 'gigabrain_sync_status', readOnlyHint: true });
    assertToolAnnotations(toolByName.get('gigabrain_export_brief'), { name: 'gigabrain_export_brief', readOnlyHint: true });
    assertToolAnnotations(toolByName.get('gigabrain_entity'), { name: 'gigabrain_entity', readOnlyHint: true });
    assertToolAnnotations(toolByName.get('gigabrain_contradictions'), { name: 'gigabrain_contradictions', readOnlyHint: true });
    assertToolAnnotations(toolByName.get('gigabrain_relationships'), { name: 'gigabrain_relationships', readOnlyHint: true });
    assertToolAnnotations(toolByName.get('gigabrain_doctor'), { name: 'gigabrain_doctor', readOnlyHint: true });
    assertToolAnnotations(toolByName.get('gigabrain_remember'), { name: 'gigabrain_remember', readOnlyHint: false });
    assertToolAnnotations(toolByName.get('gigabrain_checkpoint'), { name: 'gigabrain_checkpoint', readOnlyHint: false });

    const remember = await withTimeout(client.callTool({
      name: 'gigabrain_remember',
      arguments: {
        content: 'Codex can use Gigabrain through MCP.',
        type: 'DECISION',
        durability: 'durable',
        target: 'project',
        scope: projectScope,
      },
    }), 'gigabrain_remember');
    assert.notEqual(remember.isError, true, `MCP remember should succeed: ${stderrChunks.join('')}`);
    assertToolResponse(remember, 'gigabrain_remember');
    assert.equal(remember.structuredContent?.ok, true, 'MCP remember should return ok');
    assert.equal(Boolean(remember.structuredContent?.memory_id), true, 'MCP remember should return a memory id');

    const rememberUser = await withTimeout(client.callTool({
      name: 'gigabrain_remember',
      arguments: {
        content: 'The user prefers very clear setup docs.',
        type: 'PREFERENCE',
        durability: 'durable',
        target: 'user',
      },
    }), 'gigabrain_remember_user');
    assert.notEqual(rememberUser.isError, true, `MCP remember(user) should succeed: ${stderrChunks.join('')}`);
    assertToolResponse(rememberUser, 'gigabrain_remember_user');
    assert.equal(rememberUser.structuredContent?.ok, true, 'MCP remember(user) should return ok');
    assert.equal(rememberUser.structuredContent?.target, 'user', 'MCP remember(user) should write to the user store');

    const recall = await withTimeout(client.callTool({
      name: 'gigabrain_recall',
      arguments: {
        query: 'How can Codex use Gigabrain?',
        target: 'project',
        scope: projectScope,
        top_k: 4,
      },
    }), 'gigabrain_recall');
    assert.notEqual(recall.isError, true, `MCP recall should succeed: ${stderrChunks.join('')}`);
    assertToolResponse(recall, 'gigabrain_recall');
    assert.equal(
      recall.structuredContent?.results?.some((row) => String(row.content || '').includes('Codex can use Gigabrain through MCP')),
      true,
      'MCP recall should surface remembered content',
    );
    const recalledMemoryId = recall.structuredContent?.results?.[0]?.memory_id;
    assert.equal(Boolean(recalledMemoryId), true, 'MCP recall should return a memory id');

    const recallUser = await withTimeout(client.callTool({
      name: 'gigabrain_recall',
      arguments: {
        query: 'clear setup docs',
        target: 'user',
        top_k: 4,
      },
    }), 'gigabrain_recall_user');
    assert.notEqual(recallUser.isError, true, `MCP recall(user) should succeed: ${stderrChunks.join('')}`);
    assertToolResponse(recallUser, 'gigabrain_recall_user');
    assert.equal(
      recallUser.structuredContent?.results?.some((row) => String(row.content || '').includes('very clear setup docs')),
      true,
      'MCP recall(user) should surface user-store content',
    );

    const provenance = await withTimeout(client.callTool({
      name: 'gigabrain_provenance',
      arguments: {
        memory_id: recalledMemoryId,
        target: 'project',
        scope: projectScope,
      },
    }), 'gigabrain_provenance');
    assert.notEqual(provenance.isError, true, `MCP provenance should succeed: ${stderrChunks.join('')}`);
    assertToolResponse(provenance, 'gigabrain_provenance');
    assert.equal(Boolean(provenance.structuredContent?.results?.[0]?.source_path), true, 'MCP provenance should include source paths');

    const checkpoint = await withTimeout(client.callTool({
      name: 'gigabrain_checkpoint',
      arguments: {
        summary: 'Implemented Codex App checkpoint support for Gigabrain.',
        session_label: 'checkpoint rollout',
        scope: projectScope,
        decisions: ['Use task-end checkpoints in Codex App.'],
        open_loops: ['Document the checkpoint capture workflow.'],
        touched_files: ['lib/core/codex-mcp.js'],
        durable_candidates: ['The repo codename is Atlas Beacon.'],
      },
    }), 'gigabrain_checkpoint');
    assert.notEqual(checkpoint.isError, true, `MCP checkpoint should succeed: ${stderrChunks.join('')}`);
    assertToolResponse(checkpoint, 'gigabrain_checkpoint');
    assert.equal(checkpoint.structuredContent?.ok, true, 'MCP checkpoint should return ok');
    assert.equal(checkpoint.structuredContent?.written_native, true, 'MCP checkpoint should write native session logs');

    const checkpointRecall = await withTimeout(client.callTool({
      name: 'gigabrain_recall',
      arguments: {
        query: 'task-end checkpoints in Codex App',
        target: 'project',
        scope: projectScope,
        top_k: 4,
      },
    }), 'gigabrain_recall_after_checkpoint');
    assert.notEqual(checkpointRecall.isError, true, `MCP recall after checkpoint should succeed: ${stderrChunks.join('')}`);
    assertToolResponse(checkpointRecall, 'gigabrain_recall_after_checkpoint');
    assert.equal(
      checkpointRecall.structuredContent?.results?.some((row) => String(row.content || '').includes('task-end checkpoints in Codex App')),
      true,
      'MCP recall should surface checkpoint-driven native session content',
    );

    const recentUser = await withTimeout(client.callTool({
      name: 'gigabrain_recent',
      arguments: {
        target: 'user',
        limit: 5,
      },
    }), 'gigabrain_recent_user');
    assert.notEqual(recentUser.isError, true, `MCP recent(user) should succeed: ${stderrChunks.join('')}`);
    assertToolResponse(recentUser, 'gigabrain_recent_user');
    assert.equal(
      recentUser.structuredContent?.results?.some((row) => row.origin === 'user'),
      true,
      'MCP recent(user) should list user memories',
    );

    const sources = await withTimeout(client.callTool({
      name: 'gigabrain_sources',
      arguments: {
        target: 'project',
        include_discovery: true,
      },
    }), 'gigabrain_sources');
    assert.notEqual(sources.isError, true, `MCP sources should succeed: ${stderrChunks.join('')}`);
    assertToolResponse(sources, 'gigabrain_sources');
    assert.equal(sources.structuredContent?.ok, true, 'MCP sources should return ok');
    assert.equal(Array.isArray(sources.structuredContent?.stores), true, 'MCP sources should include stores');

    const syncStatus = await withTimeout(client.callTool({
      name: 'gigabrain_sync_status',
      arguments: {
        target: 'project',
      },
    }), 'gigabrain_sync_status');
    assert.notEqual(syncStatus.isError, true, `MCP sync status should succeed: ${stderrChunks.join('')}`);
    assertToolResponse(syncStatus, 'gigabrain_sync_status');
    assert.equal(syncStatus.structuredContent?.ok, true, 'MCP sync status should return ok');
    assert.equal(
      syncStatus.structuredContent?.stores?.[0]?.hosts?.some((row) => row.source_host === 'codex'),
      true,
      'MCP sync status should list known host adapters',
    );

    const exportBrief = await withTimeout(client.callTool({
      name: 'gigabrain_export_brief',
      arguments: {
        target: 'project',
        target_host: 'agents',
        scope: projectScope,
        limit: 10,
      },
    }), 'gigabrain_export_brief');
    assert.notEqual(exportBrief.isError, true, `MCP export brief should succeed: ${stderrChunks.join('')}`);
    assertToolResponse(exportBrief, 'gigabrain_export_brief');
    assert.equal(exportBrief.structuredContent?.ok, true, 'MCP export brief should return ok');
    assert.equal(Number.isFinite(exportBrief.structuredContent?.omitted_secret_risks), true, 'MCP export brief schema should expose omitted secret risk count');
    assert.equal(exportBrief.structuredContent?.brief.includes('does not scrape'), true, 'MCP export brief should explain the closed-cloud boundary');

    const doctor = await withTimeout(client.callTool({
      name: 'gigabrain_doctor',
      arguments: {
        target: 'both',
      },
    }), 'gigabrain_doctor');
    assert.notEqual(doctor.isError, true, `MCP doctor should succeed: ${stderrChunks.join('')}`);
    assertToolResponse(doctor, 'gigabrain_doctor');
    assert.equal(doctor.structuredContent?.ok, true, 'MCP doctor should report a healthy setup');
    assert.equal(Array.isArray(doctor.structuredContent?.stores), true, 'MCP doctor should include store health');
    assert.equal(
      doctor.structuredContent?.stores?.some((row) => row.target === 'user' && row.ok === true),
      true,
      'MCP doctor should report the configured user store as healthy',
    );

    seedWorldModelFixture(path.join(globalStorePath, 'memory', 'registry.sqlite'));

    const entityTool = await withTimeout(client.callTool({
      name: 'gigabrain_entity',
      arguments: {
        entity_id: 'person:riley',
        include_evolution: true,
      },
    }), 'gigabrain_entity');
    assert.notEqual(entityTool.isError, true, `MCP entity should succeed: ${stderrChunks.join('')}`);
    assertToolResponse(entityTool, 'gigabrain_entity');
    assert.equal(entityTool.structuredContent?.entity?.display_name, 'Riley', 'MCP entity should return the requested entity');
    assert.equal(Array.isArray(entityTool.structuredContent?.beliefs), true, 'MCP entity should include beliefs');
    assert.equal(
      entityTool.structuredContent?.evolution?.some((slot) => slot.current?.claim_value === 'Berlin'),
      true,
      'MCP entity should expose normalized evolution history',
    );

    const contradictionsTool = await withTimeout(client.callTool({
      name: 'gigabrain_contradictions',
      arguments: {
        entity_id: 'person:riley',
        include_suggestions: true,
      },
    }), 'gigabrain_contradictions');
    assert.notEqual(contradictionsTool.isError, true, `MCP contradictions should succeed: ${stderrChunks.join('')}`);
    assertToolResponse(contradictionsTool, 'gigabrain_contradictions');
    assert.equal(contradictionsTool.structuredContent?.total >= 1, true, 'MCP contradictions should return the seeded contradiction');
    assert.equal(
      Boolean(contradictionsTool.structuredContent?.contradictions?.[0]?.suggestion?.suggested_resolution),
      true,
      'MCP contradictions should attach suggestions by loop_id',
    );

    const relationshipsTool = await withTimeout(client.callTool({
      name: 'gigabrain_relationships',
      arguments: {
        entity_id: 'person:riley',
      },
    }), 'gigabrain_relationships');
    assert.notEqual(relationshipsTool.isError, true, `MCP relationships should succeed: ${stderrChunks.join('')}`);
    assertToolResponse(relationshipsTool, 'gigabrain_relationships');
    assert.equal(relationshipsTool.structuredContent?.total >= 1, true, 'MCP relationships should return the stored relationship rows');
    assert.equal(
      relationshipsTool.structuredContent?.relationships?.some((row) => row.counterpart_entity?.display_name === 'Jordan'),
      true,
      'MCP relationships should use canonical relationship rows with counterpart metadata',
    );
  } finally {
    await client.close().catch(() => {});
  }

  const portableHomeRoot = path.join(root, 'portable-home');
  const portableStoreRoot = path.join(portableHomeRoot, '.gigabrain');
  const portableConfigPath = path.join(portableStoreRoot, 'config.json');
  fs.mkdirSync(portableHomeRoot, { recursive: true });
  writeJsonPretty(portableConfigPath, createStandaloneCodexConfig({
    projectRoot,
    projectStorePath: portableStoreRoot,
    userProfilePath: path.join(portableStoreRoot, 'profile'),
  }));
  bootstrapStandaloneStore({ configPath: portableConfigPath });
  const portableStderrChunks = [];
  const { client: portableClient } = await connectClient({
    configPath: '~/.gigabrain/config.json',
    stderrChunks: portableStderrChunks,
    env: {
      ...process.env,
      HOME: portableHomeRoot,
    },
  });
  try {
    const portableDoctor = await withTimeout(portableClient.callTool({
      name: 'gigabrain_doctor',
      arguments: {
        target: 'both',
      },
    }), 'gigabrain_doctor_portable_path');
    assert.notEqual(portableDoctor.isError, true, `MCP doctor with portable config path should succeed: ${portableStderrChunks.join('')}`);
    assertToolResponse(portableDoctor, 'gigabrain_doctor_portable_path');
    assert.equal(portableDoctor.structuredContent?.ok, true, 'MCP doctor should work with a home-relative standalone config path');
    assert.equal(portableDoctor.structuredContent?.config_path, portableConfigPath, 'MCP doctor should resolve the portable config path to the actual standalone config');
  } finally {
    await portableClient.close().catch(() => {});
  }

  const brokenConfigPath = path.join(root, 'broken-config.json');
  const brokenConfig = createStandaloneCodexConfig({
    projectRoot,
    projectStorePath: globalStorePath,
    userProfilePath: '',
  });
  brokenConfig.codex.userProfilePath = '';
  brokenConfig.codex.recallOrder = ['project', 'remote'];
  writeJsonPretty(brokenConfigPath, brokenConfig);
  bootstrapStandaloneStore({ configPath: brokenConfigPath });

  const brokenStderrChunks = [];
  const { client: brokenClient } = await connectClient({
    configPath: brokenConfigPath,
    stderrChunks: brokenStderrChunks,
  });
  try {
    const doctorUser = await withTimeout(brokenClient.callTool({
      name: 'gigabrain_doctor',
      arguments: {
        target: 'user',
      },
    }), 'gigabrain_doctor_user_missing');
    assert.notEqual(doctorUser.isError, true, `MCP doctor(user) should return structured failure: ${brokenStderrChunks.join('')}`);
    assertToolResponse(doctorUser, 'gigabrain_doctor_user_missing');
    assert.equal(doctorUser.structuredContent?.ok, false, 'MCP doctor(user) should fail when the user store is not configured');
    assert.equal(
      doctorUser.structuredContent?.stores?.some((row) => row.target === 'user' && String(row.error || '').includes("target store 'user' is not configured")),
      true,
      'MCP doctor(user) should explain when the personal store is missing',
    );
  } finally {
    await brokenClient.close().catch(() => {});
  }
};

export { run };
