import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  MIN_NODE_MAJOR,
  ensureSupportedNodeRuntime,
  parseNodeVersion,
} from '../lib/core/runtime-guard.js';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

const run = async () => {
  const parsed = parseNodeVersion('v22.3.4');
  assert.equal(parsed.major, 22, 'parser should extract the major version');
  assert.equal(parsed.ok, true, 'parser should accept supported versions');
  assert.equal(parseNodeVersion('v21.9.0').ok, false, 'parser should reject unsupported versions');

  assert.doesNotThrow(() => {
    ensureSupportedNodeRuntime({
      component: 'Gigabrain test',
      version: `v${MIN_NODE_MAJOR}.0.0`,
    });
  }, 'supported versions should pass the runtime guard');

  assert.throws(() => {
    ensureSupportedNodeRuntime({
      component: 'Gigabrain test',
      binary: '/tmp/node21',
      version: 'v21.9.0',
    });
  }, /requires Node\.js >= 22/i, 'unsupported versions should produce a friendly runtime error');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-runtime-guard-'));
  const dbPath = path.join(root, 'registry.sqlite');
  const guardedCli = spawnSync('node', [
    path.join('scripts', 'gigabrainctl.js'),
    'inventory',
    '--db',
    dbPath,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      GB_NODE_VERSION_OVERRIDE: 'v21.8.0',
    },
  });
  assert.notEqual(guardedCli.status, 0, 'CLI should fail under a mocked unsupported Node version');
  assert.match(
    `${guardedCli.stderr || ''}${guardedCli.stdout || ''}`,
    /requires Node\.js >= 22/i,
    'CLI should surface the friendly runtime guard message instead of a raw node:sqlite import failure',
  );
};

export { run };
