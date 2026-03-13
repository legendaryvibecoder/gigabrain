import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { makeConfigObject, makeTempWorkspace, openDb, seedMemoryCurrent, writeConfigFile } from './helpers.js';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const scriptPath = path.join(repoRoot, 'scripts', 'gigabrainctl.js');

const runNightlyCli = (configPath) => spawnSync(process.execPath, [scriptPath, 'nightly', '--config', configPath], {
  cwd: repoRoot,
  encoding: 'utf8',
});

const parseCliJson = (result, label) => {
  assert.equal(result.status, 0, `${label} should exit cleanly: ${result.stderr || '(no stderr)'}`);
  assert.equal(Boolean(String(result.stdout || '').trim()), true, `${label} should emit JSON stdout`);
  try {
    return JSON.parse(String(result.stdout || ''));
  } catch (err) {
    throw new Error(`${label} emitted invalid JSON: ${String(result.stdout || '').trim()} :: ${err instanceof Error ? err.message : String(err)}`);
  }
};

const seedWorkspace = (ws) => {
  const openclaw = makeConfigObject(ws.workspace);
  writeConfigFile(ws.configPath, openclaw);
  const db = openDb(ws.dbPath);
  try {
    seedMemoryCurrent(db, [
      { type: 'PREFERENCE', content: 'User prefers direct release notes with clear dates.', scope: 'shared', confidence: 0.84 },
      { type: 'DECISION', content: 'Nightly should publish the generated execution artifact after maintenance.', scope: 'shared', confidence: 0.81 },
    ]);
  } finally {
    db.close();
  }
};

const writeLock = (lockDir, payload) => {
  fs.mkdirSync(lockDir, { recursive: true });
  fs.writeFileSync(path.join(lockDir, 'lock.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

const run = async () => {
  const successWs = makeTempWorkspace('gb-v3-nightly-cli-success-');
  seedWorkspace(successWs);
  const successResult = runNightlyCli(successWs.configPath);
  const successPayload = parseCliJson(successResult, 'nightly success');
  assert.equal(successPayload.ok, true, 'nightly success should report ok');
  assert.equal(successPayload.command, 'nightly');
  assert.equal(successPayload.lock?.acquired, true, 'nightly should acquire the built-in lock');
  assert.equal(successPayload.lock?.clearedStale, false, 'fresh nightly run should not need stale cleanup');
  assert.equal(successPayload.verification?.ok, true, 'nightly should verify its own artifacts');
  assert.equal(fs.existsSync(successPayload.lock?.lockDir || ''), false, 'nightly lock should be released after completion');
  const artifact = JSON.parse(fs.readFileSync(successPayload.verification.artifactPath, 'utf8'));
  assert.equal(String(artifact.run_id || ''), String(successPayload.runId || ''), 'verified artifact should belong to the current run');
  const usageLog = fs.readFileSync(successPayload.verification.usageLogPath, 'utf8');
  assert.equal(usageLog.includes(`- run_id: \`${String(successPayload.runId || '')}\``), true, 'usage log should contain the verified run id');

  const skipWs = makeTempWorkspace('gb-v3-nightly-cli-skip-');
  const skipOpenclaw = makeConfigObject(skipWs.workspace);
  writeConfigFile(skipWs.configPath, skipOpenclaw);
  const skipLockDir = path.join(skipWs.outputRoot, 'gigabrain-nightly.lock.d');
  writeLock(skipLockDir, {
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    runId: 'active-lock-owner',
  });
  const skipResult = runNightlyCli(skipWs.configPath);
  const skipPayload = parseCliJson(skipResult, 'nightly active-lock skip');
  assert.equal(skipPayload.ok, true, 'active lock path should return a clean skip');
  assert.equal(skipPayload.skipped, true, 'active lock should skip a second nightly run');
  assert.equal(skipPayload.reason, 'nightly_already_running');
  assert.equal(skipPayload.lock?.acquired, false, 'skip path must not claim a new lock');
  assert.equal(fs.existsSync(path.join(skipWs.outputRoot, `nightly-execution-${new Date().toISOString().slice(0, 10)}.json`)), false, 'skip path must not emit a nightly artifact');

  const staleWs = makeTempWorkspace('gb-v3-nightly-cli-stale-');
  seedWorkspace(staleWs);
  const staleLockDir = path.join(staleWs.outputRoot, 'gigabrain-nightly.lock.d');
  writeLock(staleLockDir, {
    pid: 999999,
    hostname: os.hostname(),
    startedAt: '2026-01-01T00:00:00.000Z',
    runId: 'stale-lock-owner',
  });
  const staleResult = runNightlyCli(staleWs.configPath);
  const stalePayload = parseCliJson(staleResult, 'nightly stale-lock recovery');
  assert.equal(stalePayload.ok, true, 'stale lock path should still complete');
  assert.equal(stalePayload.lock?.acquired, true, 'stale lock path should reacquire the lock');
  assert.equal(stalePayload.lock?.clearedStale, true, 'stale lock should be cleaned automatically');
  assert.equal(stalePayload.lock?.staleReason, 'pid_missing', 'dead lock owner should be classified as pid_missing');
  assert.equal(stalePayload.verification?.ok, true, 'stale lock recovery should still verify outputs');
  assert.equal(fs.existsSync(stalePayload.lock?.lockDir || ''), false, 'stale lock should also be released after completion');
};

export { run };
