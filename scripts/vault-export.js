#!/usr/bin/env node

import { loadResolvedConfig } from '../lib/core/config.js';
import { renderVaultMirrorMarkdown, syncVaultMirror } from '../lib/core/vault-mirror.js';

const args = process.argv.slice(2);

const readFlag = (name, fallback = '') => {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1] && !String(args[idx + 1]).startsWith('--')) return args[idx + 1];
  const withEq = args.find((item) => String(item || '').startsWith(`${name}=`));
  if (withEq) return withEq.split('=').slice(1).join('=');
  return fallback;
};

const readBool = (name, fallback = false) => {
  if (args.includes(name)) return true;
  const withEq = args.find((item) => String(item || '').startsWith(`${name}=`));
  if (!withEq) return fallback;
  const raw = String(withEq.split('=').slice(1).join('=')).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
};

const main = () => {
  const configPath = readFlag('--config', '');
  const workspaceOverride = readFlag('--workspace', '');
  const loaded = loadResolvedConfig({
    configPath,
    workspaceRoot: workspaceOverride || undefined,
  });

  const config = {
    ...loaded.config,
    vault: {
      ...loaded.config.vault,
      enabled: readBool('--enabled', loaded.config?.vault?.enabled === true),
      path: String(readFlag('--vault', loaded.config?.vault?.path || '') || loaded.config?.vault?.path || ''),
      subdir: String(readFlag('--subdir', loaded.config?.vault?.subdir || 'Gigabrain') || loaded.config?.vault?.subdir || 'Gigabrain'),
      clean: readBool('--clean', loaded.config?.vault?.clean !== false),
    },
  };
  const dryRun = readBool('--dry-run', false);
  const runId = String(readFlag('--run-id', `vault-export-${new Date().toISOString().replace(/[:.]/g, '-')}`));
  const summary = syncVaultMirror({
    config,
    dryRun,
  });

  console.log(renderVaultMirrorMarkdown({
    timestamp: new Date().toISOString(),
    runId,
    summary,
  }).trim());
  console.log(JSON.stringify({
    ok: true,
    dryRun,
    configPath: loaded.configPath,
    workspaceRoot: config.runtime.paths.workspaceRoot,
    vaultRoot: config.vault.path,
    subdir: config.vault.subdir,
    summary,
  }, null, 2));
};

main();
