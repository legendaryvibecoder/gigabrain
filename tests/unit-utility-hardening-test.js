import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

import { normalizeConfig } from '../lib/core/config.js';
import { createAgentMemoryPolicyBody } from '../lib/core/agent-memory-policy.js';
import { createStandaloneCodexConfig } from '../lib/core/codex-project.js';
import {
  bootstrapStandaloneStore,
  runCheckpoint,
  runRecall,
  runRemember,
} from '../lib/core/codex-service.js';

const writeJson = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

const contents = (result) => (result.results || []).map((row) => String(row.content || '')).join('\n');

const mutationCounts = (dbPath) => {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const count = (table) => {
      try {
        return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()?.c || 0);
      } catch {
        return 0;
      }
    };
    return {
      current: count('memory_current'),
      events: count('memory_events'),
      native: count('memory_native_sync_state'),
      entities: count('memory_entities'),
    };
  } finally {
    db.close();
  }
};

const waitForExit = (child, timeoutMs = 5000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    child.kill('SIGKILL');
    reject(new Error('MCP server did not exit after stdin closed'));
  }, timeoutMs);
  child.once('exit', (code, signal) => {
    clearTimeout(timer);
    resolve({ code, signal });
  });
});

const run = async () => {
  const defaults = normalizeConfig({});
  assert.equal(defaults.synthesis.briefing.includeSessionPrelude, false);
  assert.equal(defaults.recall.autoInjectEnabled, false);
  assert.equal(defaults.recall.relevanceFloor.minMatchedTokens, 2);
  assert.equal(defaults.recall.relevanceFloor.denseCosine, 0.65);
  const agentPolicy = createAgentMemoryPolicyBody({ projectScope: 'project:alpha' });
  assert.match(agentPolicy, /Do not grep Gigabrain store files directly/);
  assert.match(agentPolicy, /Prefer Gigabrain MCP tools over direct CLI writes whenever the MCP server is available\./);
  assert.match(agentPolicy, /node ~\/\.npm\/_npx\/\.\.\.\/scripts\/gigabrainctl\.js/);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-utility-hardening-'));
  try {
    const projectRoot = path.join(root, 'project');
    const projectStorePath = path.join(root, 'store');
    const userProfilePath = path.join(root, 'profile');
    const configPath = path.join(projectStorePath, 'config.json');
    fs.mkdirSync(projectRoot, { recursive: true });
    const config = createStandaloneCodexConfig({ projectRoot, projectStorePath, userProfilePath });
    writeJson(configPath, config);
    bootstrapStandaloneStore({ configPath });

    const alphaScope = 'project:alpha';
    const defaultScope = config.codex.defaultProjectScope;
    runRemember({ configPath, target: 'project', scope: defaultScope, type: 'DECISION', content: 'The target merge fix remains in the live worktree and is not in the release.' });
    runRemember({ configPath, target: 'user', scope: 'profile:user', type: 'USER_FACT', content: 'Private profile note mentions release but does not describe software.' });
    runRemember({ configPath, target: 'project', scope: alphaScope, type: 'DECISION', content: 'Alpha uses the copper lighthouse release policy.' });
    runRemember({ configPath, target: 'project', scope: 'project:beta', type: 'DECISION', content: 'Beta uses the violet submarine release policy.' });
    runRemember({ configPath, target: 'project', scope: 'profile:user', type: 'USER_FACT', content: 'Legacy profile row uses the amber kestrel phrase.' });
    runRemember({ configPath, target: 'user', scope: 'profile:user', type: 'USER_FACT', content: 'Personal profile row uses the topaz snow leopard phrase.' });

    const dbPath = path.resolve(config.runtime.paths.workspaceRoot, config.runtime.paths.registryPath);
    const beforeRecall = mutationCounts(dbPath);
    const scoped = await runRecall({
      configPath,
      target: 'both',
      scope: alphaScope,
      query: 'copper lighthouse release policy',
      topK: 8,
    });
    const afterRecall = mutationCounts(dbPath);
    assert.deepEqual(afterRecall, beforeRecall, 'recall must not mutate sync, event, entity, or projection tables');
    assert.match(contents(scoped), /copper lighthouse/);
    assert.doesNotMatch(contents(scoped), /violet submarine|amber kestrel|topaz snow leopard/);
    const maintenanceProbeDb = new DatabaseSync(dbPath);
    try {
      maintenanceProbeDb.exec('PRAGMA foreign_keys = OFF; DELETE FROM memory_entities;');
    } finally {
      maintenanceProbeDb.close();
    }
    const beforeReceiptedRecall = mutationCounts(dbPath);
    const receiptedRecall = await runRecall({
      configPath,
      target: 'project',
      query: 'target merge fix live worktree release',
      topK: 8,
      recordReceipt: true,
    });
    const afterReceiptedRecall = mutationCounts(dbPath);
    assert.ok(receiptedRecall.receipt_id, 'explicit receipt recording should return a receipt id');
    assert.deepEqual(
      afterReceiptedRecall,
      beforeReceiptedRecall,
      'receipt recording must not trigger sync, event, entity, or projection maintenance',
    );
    const shortQuery = await runRecall({
      configPath,
      target: 'project',
      scope: alphaScope,
      query: 'copper glacier',
      topK: 8,
    });
    assert.match(contents(shortQuery), /copper lighthouse/, 'short queries should accept one informative token match');
    const longSingleOverlap = await runRecall({
      configPath,
      target: 'project',
      scope: alphaScope,
      query: 'copper glacier nebula orchard',
      topK: 8,
    });
    assert.equal(longSingleOverlap.match_status, 'no_match', 'four-token queries should reject a single lexical overlap');
    assert.equal(longSingleOverlap.results.length, 0);
    const broad = await runRecall({
      configPath,
      target: 'both',
      query: 'target merge fix live worktree release',
      topK: 8,
    });
    assert.match(contents(broad), /target merge fix/);
    assert.doesNotMatch(contents(broad), /Private profile note/);
    await assert.rejects(
      () => runRecall({ configPath, target: 'user', scope: alphaScope, query: 'release policy' }),
      /scope does not match the requested target/,
    );

    const first = runCheckpoint({
      configPath,
      scope: alphaScope,
      sessionId: 'session-alpha',
      sessionLabel: 'alpha',
      summary: 'Completed the alpha release check.',
      decisions: ['Ship only after verification.'],
      openLoops: ['Confirm the release artifact.'],
    });
    const noteAfterFirst = fs.readFileSync(first.source_path, 'utf8');
    const second = runCheckpoint({
      configPath,
      scope: alphaScope,
      sessionId: 'session-alpha',
      sessionLabel: 'alpha',
      summary: 'A duplicate teardown checkpoint must not append again.',
    });
    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true);
    assert.equal(second.checkpoint_id, first.checkpoint_id);
    assert.equal(second.written_native, false);

    const note = fs.readFileSync(first.source_path, 'utf8');
    assert.equal(note, noteAfterFirst, 'duplicate checkpoint must not rewrite the native note');
    assert.equal((note.match(/^## Codex App Sessions$/gm) || []).length, 1);
    assert.doesNotMatch(note, /duplicate teardown checkpoint/);

    const child = spawn(process.execPath, [
      path.resolve('scripts/gigabrain-mcp.js'),
      '--config',
      configPath,
    ], {
      cwd: path.resolve('.'),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let childStderr = '';
    child.stderr.on('data', (chunk) => {
      childStderr += String(chunk || '');
    });
    child.stdin.end();
    const exit = await waitForExit(child);
    assert.equal(exit.code, 0, `MCP process should exit cleanly on stdin EOF (signal=${exit.signal || 'none'}): ${childStderr}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

export { run };
