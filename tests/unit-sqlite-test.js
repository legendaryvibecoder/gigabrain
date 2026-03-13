import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

import { makeTempWorkspace } from './helpers.js';
import { openDatabase } from '../lib/core/sqlite.js';

const waitFor = (predicate, { timeoutMs = 3000, intervalMs = 25 } = {}) => new Promise((resolve, reject) => {
  const started = Date.now();
  const tick = () => {
    if (predicate()) {
      resolve();
      return;
    }
    if (Date.now() - started > timeoutMs) {
      reject(new Error('timed out waiting for sqlite lock helper'));
      return;
    }
    setTimeout(tick, intervalMs);
  };
  tick();
});

const run = async () => {
  const ws = makeTempWorkspace('gb-v3-unit-sqlite-');
  const setupDb = openDatabase(ws.dbPath);
  setupDb.exec('CREATE TABLE IF NOT EXISTS lock_probe(id INTEGER PRIMARY KEY, value TEXT)');
  setupDb.close();

  const helperScript = [
    'import sqlite3, sys, time',
    'path = sys.argv[1]',
    'con = sqlite3.connect(path, timeout=0)',
    'con.execute("PRAGMA journal_mode=WAL")',
    'con.execute("BEGIN EXCLUSIVE")',
    'print("locked", flush=True)',
    'time.sleep(1.2)',
    'con.commit()',
    'con.close()',
  ].join('\n');

  const helper = spawn('python3', ['-c', helperScript, ws.dbPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  helper.stdout.on('data', (chunk) => { stdout += String(chunk); });
  helper.stderr.on('data', (chunk) => { stderr += String(chunk); });

  try {
    await waitFor(() => stdout.includes('locked'));

    const started = Date.now();
    const db = openDatabase(ws.dbPath);
    try {
      db.prepare('INSERT INTO lock_probe(value) VALUES (?)').run('after-wait');
    } finally {
      db.close();
    }
    const elapsedMs = Date.now() - started;

    const exitCode = await new Promise((resolve, reject) => {
      helper.on('error', reject);
      helper.on('exit', resolve);
    });
    assert.equal(exitCode, 0, 'lock helper must exit cleanly: ' + stderr);
    assert.equal(elapsedMs >= 900, true, 'busy_timeout path should wait for transient lock (elapsed=' + elapsedMs + 'ms)');

    const verifyDb = openDatabase(ws.dbPath, { readOnly: true });
    try {
      const count = Number(verifyDb.prepare('SELECT COUNT(*) AS c FROM lock_probe').get()?.c || 0);
      assert.equal(count, 1, 'the waited insert should commit after the lock is released');
    } finally {
      verifyDb.close();
    }
  } finally {
    if (helper.exitCode === null) {
      helper.kill('SIGTERM');
    }
  }
};

export { run };
