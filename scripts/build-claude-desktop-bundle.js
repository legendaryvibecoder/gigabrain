#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_GLOBAL_STANDALONE_STORE,
  PORTABLE_STANDALONE_CONFIG_PATH,
  defaultStandaloneConfigPathForStore,
  resolveAbsolutePath,
} from '../lib/core/standalone-client.js';

const THIS_FILE = fileURLToPath(import.meta.url);
const PACKAGE_ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
const packageRequire = createRequire(path.join(PACKAGE_ROOT, 'package.json'));
const args = process.argv.slice(2);

const HELP = `Build Claude Desktop extension bundle

Usage:
  node scripts/build-claude-desktop-bundle.js
  node scripts/build-claude-desktop-bundle.js --out-dir /path/to/dist

Flags:
  --out-dir <path>        Output directory for the built .dxt bundle
  --config-default <path> Default standalone config path exposed in the extension manifest
  --portable              Build a portable release bundle with a home-relative config default
  --bundle-mode <mode>    local (default) or portable
  --help                  Print this help
`;

const readFlag = (name, fallback = '') => {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1] && !String(args[idx + 1]).startsWith('--')) return String(args[idx + 1]);
  const withEq = args.find((item) => String(item || '').startsWith(`${name}=`));
  if (withEq) return String(withEq.split('=').slice(1).join('='));
  return fallback;
};

const HOME_DIR = os.homedir() || process.env.HOME || '';

const expandHome = (value = '') => {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  if (raw === '~') return HOME_DIR || raw;
  if (raw.startsWith('~/')) return HOME_DIR ? path.join(HOME_DIR, raw.slice(2)) : raw;
  return raw;
};

const readBundleMode = () => {
  if (args.includes('--portable')) return 'portable';
  const raw = String(readFlag('--bundle-mode', 'local') || '').trim().toLowerCase();
  return raw === 'portable' || raw === 'release' ? 'portable' : 'local';
};

const copyTree = (source, target) => {
  fs.cpSync(source, target, {
    recursive: true,
    force: true,
  });
};

const resolveDependencyPackageRoot = (dependencyName, resolver = packageRequire) => {
  const candidates = [
    `${dependencyName}/package.json`,
    dependencyName,
  ];
  for (const candidate of candidates) {
    try {
      const resolved = resolver.resolve(candidate);
      let cursor = path.dirname(resolved);
      while (cursor && cursor !== path.dirname(cursor)) {
        const packageJsonPath = path.join(cursor, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
          const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
          if (pkg?.name === dependencyName) {
            return {
              packageRoot: cursor,
              packageJsonPath,
              packageJson: pkg,
            };
          }
        }
        cursor = path.dirname(cursor);
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
};

const copyRuntimeDependencies = (stagingRoot) => {
  const targetNodeModules = path.join(stagingRoot, 'node_modules');
  fs.mkdirSync(targetNodeModules, { recursive: true });
  const queue = Object.keys(PACKAGE_JSON.dependencies || {}).map((dependencyName) => ({
    dependencyName,
    resolver: packageRequire,
  }));
  const seen = new Set();
  while (queue.length > 0) {
    const { dependencyName, resolver } = queue.shift();
    if (!dependencyName || seen.has(dependencyName)) continue;
    const resolvedDependency = resolveDependencyPackageRoot(dependencyName, resolver);
    if (!resolvedDependency) {
      throw new Error(`Unable to resolve runtime dependency: ${dependencyName}`);
    }
    const {
      packageRoot,
      packageJsonPath,
      packageJson: dependencyPackage,
    } = resolvedDependency;
    const targetRoot = path.join(targetNodeModules, dependencyName);
    fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
    copyTree(packageRoot, targetRoot);
    seen.add(dependencyName);
    const dependencyRequire = createRequire(packageJsonPath);
    for (const childName of Object.keys(dependencyPackage.dependencies || {})) {
      if (!seen.has(childName)) {
        queue.push({
          dependencyName: childName,
          resolver: dependencyRequire,
        });
      }
    }
  }
};

const writeJsonPretty = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

const ensureSuccess = (result, label) => {
  if (result.error?.code === 'ENOENT') {
    throw new Error(`${label} failed: required tool '${result.spawnargs?.[0] || 'unknown'}' was not found in PATH`);
  }
  if (result.status === 0) return;
  throw new Error(`${label} failed:\n${String(result.stderr || result.stdout || '').trim()}`);
};

const resolveArchiveCommand = (bundlePath) => {
  const entries = [
    'manifest.json',
    'package.json',
    'README.md',
    'LICENSE',
    'scripts',
    'lib',
    'node_modules',
  ];
  const pythonPreflight = spawnSync('python3', ['--version'], {
    encoding: 'utf8',
  });
  if (!pythonPreflight.error && pythonPreflight.status === 0) {
    return {
      label: 'Claude Desktop bundle archive (python3 -m zipfile)',
      command: 'python3',
      args: ['-m', 'zipfile', '-c', bundlePath, ...entries],
    };
  }

  const zipPreflight = spawnSync('zip', ['-v'], {
    encoding: 'utf8',
  });
  if (!zipPreflight.error && zipPreflight.status === 0) {
    return {
      label: 'Claude Desktop bundle archive (zip -qr)',
      command: 'zip',
      args: ['-qr', bundlePath, ...entries],
    };
  }

  throw new Error(
    'Claude Desktop bundle build requires python3 or zip in PATH. Install python3 (recommended) or ensure zip is available before building the .dxt bundle.',
  );
};

const main = () => {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP.trim());
    return;
  }

  const outDir = path.resolve(expandHome(readFlag('--out-dir', path.join(PACKAGE_ROOT, 'dist', 'claude-desktop'))));
  const bundleMode = readBundleMode();
  const defaultConfigPath = (() => {
    const explicit = readFlag('--config-default', '');
    if (explicit) return explicit;
    if (bundleMode === 'portable') return PORTABLE_STANDALONE_CONFIG_PATH;
    return resolveAbsolutePath(defaultStandaloneConfigPathForStore(DEFAULT_GLOBAL_STANDALONE_STORE));
  })();
  const bundleName = `gigabrain-claude-desktop-${PACKAGE_JSON.version}.dxt`;
  const bundlePath = path.join(outDir, bundleName);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gigabrain-claude-desktop-'));
  const stagingRoot = path.join(tempRoot, 'bundle');
  fs.mkdirSync(stagingRoot, { recursive: true });

  copyTree(path.join(PACKAGE_ROOT, 'lib'), path.join(stagingRoot, 'lib'));
  copyTree(path.join(PACKAGE_ROOT, 'scripts'), path.join(stagingRoot, 'scripts'));
  copyRuntimeDependencies(stagingRoot);
  fs.copyFileSync(path.join(PACKAGE_ROOT, 'README.md'), path.join(stagingRoot, 'README.md'));
  fs.copyFileSync(path.join(PACKAGE_ROOT, 'LICENSE'), path.join(stagingRoot, 'LICENSE'));

  writeJsonPretty(path.join(stagingRoot, 'package.json'), {
    name: '@legendaryvibecoder/gigabrain-claude-desktop',
    version: PACKAGE_JSON.version,
    type: 'module',
    private: true,
  });

  writeJsonPretty(path.join(stagingRoot, 'manifest.json'), {
    manifest_version: '0.3',
    name: 'gigabrain',
    display_name: 'Gigabrain',
    version: PACKAGE_JSON.version,
    description: 'Local-first memory layer for Claude Desktop powered by the Gigabrain MCP server.',
    long_description: 'Gigabrain gives Claude Desktop the same local-first memory stack used by Codex and OpenClaw, including recall, remember, provenance, doctor, and checkpoint workflows through a bundled stdio MCP server.',
    author: {
      name: 'Legendary Vibecoder',
      url: 'https://github.com/legendaryvibecoder/gigabrain',
    },
    repository: {
      type: 'git',
      url: 'https://github.com/legendaryvibecoder/gigabrain.git',
    },
    homepage: 'https://github.com/legendaryvibecoder/gigabrain',
    documentation: 'https://github.com/legendaryvibecoder/gigabrain#readme',
    support: 'https://github.com/legendaryvibecoder/gigabrain/issues',
    license: 'MIT',
    keywords: ['memory', 'mcp', 'claude', 'local-first', 'gigabrain'],
    compatibility: {
      platforms: ['darwin'],
      runtimes: {
        node: '>=22.0.0',
      },
    },
    server: {
      type: 'node',
      entry_point: 'scripts/gigabrain-mcp.js',
      mcp_config: {
        command: '/bin/sh',
        args: [
          '${__dirname}/scripts/claude-desktop-launcher.sh',
          '--config',
          '${user_config.config_path}',
        ],
      },
    },
    user_config: {
      config_path: {
        type: 'string',
        title: 'Gigabrain config path',
        description: 'Path to the shared standalone Gigabrain config created by gigabrain-claude-setup or gigabrain-codex-setup.',
        default: defaultConfigPath,
        required: true,
      },
    },
  });

  fs.mkdirSync(outDir, { recursive: true });
  if (fs.existsSync(bundlePath)) fs.rmSync(bundlePath, { force: true });
  const archiver = resolveArchiveCommand(bundlePath);
  const archiveResult = spawnSync(archiver.command, archiver.args, {
    cwd: stagingRoot,
    encoding: 'utf8',
  });
  ensureSuccess(archiveResult, archiver.label);

  console.log(JSON.stringify({
    ok: true,
    bundleMode,
    outDir,
    bundlePath,
    defaultConfigPath,
    manifestPath: path.join(stagingRoot, 'manifest.json'),
    archiver: archiver.command,
  }, null, 2));
};

main();
