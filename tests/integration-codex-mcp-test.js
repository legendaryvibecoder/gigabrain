import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { createStandaloneCodexConfig } from '../lib/core/codex-project.js';
import { bootstrapStandaloneStore } from '../lib/core/codex-service.js';

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

const connectClient = async ({ configPath, stderrChunks }) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      path.join(repoRoot, 'scripts', 'gigabrain-mcp.js'),
      '--config',
      configPath,
    ],
    cwd: repoRoot,
    env: process.env,
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

  const stderrChunks = [];
  const { client } = await connectClient({ configPath, stderrChunks });

  try {
    const tools = await withTimeout(client.listTools(), 'client.listTools');
    const toolNames = tools.tools.map((tool) => tool.name);
    assert.equal(toolNames.includes('gigabrain_recall'), true, 'MCP should expose recall');
    assert.equal(toolNames.includes('gigabrain_remember'), true, 'MCP should expose remember');
    assert.equal(toolNames.includes('gigabrain_checkpoint'), true, 'MCP should expose checkpoint');
    assert.equal(toolNames.includes('gigabrain_provenance'), true, 'MCP should expose provenance');
    assert.equal(toolNames.includes('gigabrain_recent'), true, 'MCP should expose recent');
    assert.equal(toolNames.includes('gigabrain_doctor'), true, 'MCP should expose doctor');

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
    assert.equal(
      recentUser.structuredContent?.results?.some((row) => row.origin === 'user'),
      true,
      'MCP recent(user) should list user memories',
    );

    const doctor = await withTimeout(client.callTool({
      name: 'gigabrain_doctor',
      arguments: {
        target: 'both',
      },
    }), 'gigabrain_doctor');
    assert.notEqual(doctor.isError, true, `MCP doctor should succeed: ${stderrChunks.join('')}`);
    assert.equal(doctor.structuredContent?.ok, true, 'MCP doctor should report a healthy setup');
    assert.equal(Array.isArray(doctor.structuredContent?.stores), true, 'MCP doctor should include store health');
    assert.equal(
      doctor.structuredContent?.stores?.some((row) => row.target === 'user' && row.ok === true),
      true,
      'MCP doctor should report the configured user store as healthy',
    );
  } finally {
    await client.close().catch(() => {});
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
