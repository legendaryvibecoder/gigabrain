import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { acquireQueueLock, appendQueueRow, applyQueueRetention } from '../lib/core/review-queue.js';

const waitFor = (predicate, { timeoutMs = 3000, intervalMs = 25 } = {}) => new Promise((resolve, reject) => {
  const started = Date.now();
  const tick = () => {
    if (predicate()) {
      resolve();
      return;
    }
    if (Date.now() - started > timeoutMs) {
      reject(new Error('timed out waiting for review-queue worker'));
      return;
    }
    setTimeout(tick, intervalMs);
  };
  tick();
});

const run = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-review-queue-'));
  const queuePath = path.join(root, 'queue.jsonl');

  const staleLockPath = `${queuePath}.lock`;
  fs.mkdirSync(path.dirname(staleLockPath), { recursive: true });
  fs.writeFileSync(staleLockPath, `${JSON.stringify({ pid: 999999, acquired_at: '2000-01-01T00:00:00.000Z' })}\n`, 'utf8');
  const staleAt = new Date(Date.now() - 60_000);
  fs.utimesSync(staleLockPath, staleAt, staleAt);

  const staleAppend = appendQueueRow(queuePath, {
    status: 'pending',
    reason: 'capture_review_required',
    payload: { excerpt: 'stale lock cleanup works' },
  }, {
    applyRetention: false,
  });
  assert.equal(staleAppend.appended, true, 'append should succeed after stale lock cleanup');
  assert.equal(fs.existsSync(staleLockPath), false, 'stale lock should be removed after a successful append');

  const heldLock = acquireQueueLock(queuePath, {
    timeoutMs: 1000,
    retryMs: 10,
    staleMs: 60_000,
  });
  const workerScript = [
    "const { appendQueueRow } = await import(process.argv[1]);",
    'const queuePath = process.argv[2];',
    'const id = process.argv[3];',
    "appendQueueRow(queuePath, { status: 'pending', reason: 'capture_review_required', payload: { excerpt: id } }, { applyRetention: false });",
    'console.log(id);',
  ].join('\n');
  const workerArgv = [
    '--input-type=module',
    '-e',
    workerScript,
    new URL('../lib/core/review-queue.js', import.meta.url).href,
    queuePath,
  ];

  const childA = spawn('node', [...workerArgv, 'worker-a'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const childB = spawn('node', [...workerArgv, 'worker-b'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let childOutput = '';
  childA.stdout.on('data', (chunk) => { childOutput += String(chunk); });
  childB.stdout.on('data', (chunk) => { childOutput += String(chunk); });

  try {
    await waitFor(() => childA.exitCode === null && childB.exitCode === null, { timeoutMs: 500 });
  } catch {
    // Ignore: the workers may already be waiting or may finish quickly once the lock is released.
  }
  heldLock.release();

  const exitCodeA = await new Promise((resolve, reject) => {
    childA.on('error', reject);
    childA.on('exit', resolve);
  });
  const exitCodeB = await new Promise((resolve, reject) => {
    childB.on('error', reject);
    childB.on('exit', resolve);
  });
  assert.equal(exitCodeA, 0, 'first concurrent writer should exit cleanly');
  assert.equal(exitCodeB, 0, 'second concurrent writer should exit cleanly');
  assert.equal(childOutput.includes('worker-a'), true, 'first worker should complete');
  assert.equal(childOutput.includes('worker-b'), true, 'second worker should complete');

  const lines = fs.readFileSync(queuePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(lines.length, 3, 'concurrent writers should not lose rows');
  assert.equal(lines.every((row) => Boolean(String(row.queued_at || '').trim())), true, 'appended rows should always stamp queued_at for retention ordering');

  fs.appendFileSync(queuePath, `${JSON.stringify({
    status: 'pending',
    reason: 'capture_review_required',
    payload: { excerpt: 'legacy-without-timestamp' },
  })}\n`, 'utf8');

  const retained = applyQueueRetention(queuePath, {
    keepPendingOnly: false,
    maxRows: 2,
    maxPendingRows: 2,
    maxNonPendingRows: 2,
    maxPendingAgeDays: 365,
  });
  assert.equal(retained.applied, true, 'retention should still run after concurrent appends');
  const retainedRows = fs.readFileSync(queuePath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(retainedRows.length, 2, 'retention should preserve the capped merged set after concurrent appends');
  assert.equal(
    retainedRows.some((row) => String(row?.payload?.excerpt || '') === 'legacy-without-timestamp'),
    false,
    'timestamp-less legacy rows should be treated as the oldest rows during retention',
  );
};

export { run };
