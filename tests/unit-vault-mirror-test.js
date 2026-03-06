import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { normalizeConfig } from '../lib/core/config.js';
import { syncVaultMirror } from '../lib/core/vault-mirror.js';
import { makeConfigObject, makeTempWorkspace } from './helpers.js';

const run = async () => {
  const ws = makeTempWorkspace('gb-v3-vault-mirror-');
  fs.writeFileSync(path.join(ws.workspace, 'MEMORY.md'), '# MEMORY\n\n- durable fact\n', 'utf8');
  fs.writeFileSync(path.join(ws.memoryRoot, '2026-03-06.md'), '# Daily\n\n- daily note\n', 'utf8');
  fs.writeFileSync(path.join(ws.memoryRoot, 'latest.md'), '# Latest\n\n- latest note\n', 'utf8');
  fs.mkdirSync(path.join(ws.memoryRoot, 'private'), { recursive: true });
  fs.writeFileSync(path.join(ws.memoryRoot, 'private', 'secret.md'), '# Secret\n', 'utf8');

  const openclaw = makeConfigObject(ws.workspace);
  openclaw.plugins.entries.gigabrain.config.vault = {
    enabled: true,
    path: 'obsidian-vault',
    subdir: 'Gigabrain',
    clean: true,
  };
  const config = normalizeConfig(openclaw.plugins.entries.gigabrain.config);

  const stalePath = path.join(config.vault.path, config.vault.subdir, 'memory', 'stale.md');
  fs.mkdirSync(path.dirname(stalePath), { recursive: true });
  fs.writeFileSync(stalePath, '# stale\n', 'utf8');

  const summary = syncVaultMirror({ config, dryRun: false });
  assert.equal(summary.enabled, true);
  assert.equal(summary.source_files >= 3, true, 'expected at least MEMORY.md + daily + curated file');
  assert.equal(fs.existsSync(path.join(config.vault.path, 'Gigabrain', 'MEMORY.md')), true, 'MEMORY.md should be mirrored');
  assert.equal(fs.existsSync(path.join(config.vault.path, 'Gigabrain', 'memory', '2026-03-06.md')), true, 'daily note should be mirrored');
  assert.equal(fs.existsSync(path.join(config.vault.path, 'Gigabrain', 'memory', 'latest.md')), true, 'curated file should be mirrored');
  assert.equal(fs.existsSync(path.join(config.vault.path, 'Gigabrain', 'memory', 'private', 'secret.md')), false, 'excluded files must stay out of vault');
  assert.equal(fs.existsSync(path.join(config.vault.path, 'Gigabrain', 'vault-index.md')), true, 'vault index should be generated');
  assert.equal(fs.existsSync(stalePath), false, 'stale managed files should be cleaned');
};

export { run };
