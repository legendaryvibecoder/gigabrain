#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

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
  --help                  Print this help
`;

const readFlag = (name, fallback = '') => {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1] && !String(args[idx + 1]).startsWith('--')) return String(args[idx + 1]);
  const withEq = args.find((item) => String(item || '').startsWith(`${name}=`));
  if (withEq) return String(withEq.split('=').slice(1).join('='));
  return fallback;
};

const expandHome = (value = '') => {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  if (raw === '~') return process.env.HOME || raw;
  if (raw.startsWith('~/')) return path.join(process.env.HOME || '', raw.slice(2));
  return raw;
};

const copyTree = (source, target) => {
  fs.cpSync(source, target, {
    recursive: true,
    force: true,
  });
};

const resolveDependencyPackageRoot = (dependencyName) => {
  const candidates = [
    `${dependencyName}/package.json`,
    dependencyName,
  ];
  for (const candidate of candidates) {
    try {
      const resolved = packageRequire.resolve(candidate);
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

const collectRuntimeDependencyNames = () => {
  const result = spawnSync('npm', ['ls', '--omit=dev', '--all', '--json'], {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
  });
  ensureSuccess(result, 'npm ls runtime dependencies');
  const payload = JSON.parse(String(result.stdout || '{}'));
  const names = new Set();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    const deps = node.dependencies && typeof node.dependencies === 'object' ? node.dependencies : {};
    for (const [name, child] of Object.entries(deps)) {
      names.add(name);
      walk(child);
    }
  };
  walk(payload);
  return [...names];
};

const copyRuntimeDependencies = (stagingRoot) => {
  const targetNodeModules = path.join(stagingRoot, 'node_modules');
  fs.mkdirSync(targetNodeModules, { recursive: true });
  const queue = collectRuntimeDependencyNames();
  const seen = new Set();
  while (queue.length > 0) {
    const dependencyName = queue.shift();
    if (!dependencyName || seen.has(dependencyName)) continue;
    const resolvedDependency = resolveDependencyPackageRoot(dependencyName);
    if (!resolvedDependency) continue;
    const {
      packageRoot,
      packageJson: dependencyPackage,
    } = resolvedDependency;
    const targetRoot = path.join(targetNodeModules, dependencyName);
    fs.mkdirSync(path.dirname(targetRoot), { recursive: true });
    copyTree(packageRoot, targetRoot);
    seen.add(dependencyName);
    for (const childName of Object.keys(dependencyPackage.dependencies || {})) {
      if (!seen.has(childName)) queue.push(childName);
    }
  }
};

const writeJsonPretty = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

const ensureSuccess = (result, label) => {
  if (result.status === 0) return;
  throw new Error(`${label} failed:\n${String(result.stderr || result.stdout || '').trim()}`);
};

const main = () => {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP.trim());
    return;
  }

  const outDir = path.resolve(expandHome(readFlag('--out-dir', path.join(PACKAGE_ROOT, 'dist', 'claude-desktop'))));
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
        command: 'node',
        args: [
          '${__dirname}/scripts/gigabrain-mcp.js',
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
        default: '${HOME}/.codex/gigabrain/config.json',
        required: true,
      },
    },
  });

  fs.mkdirSync(outDir, { recursive: true });
  if (fs.existsSync(bundlePath)) fs.rmSync(bundlePath, { force: true });
  const archiveResult = spawnSync('python3', [
    '-m',
    'zipfile',
    '-c',
    bundlePath,
    'manifest.json',
    'package.json',
    'README.md',
    'LICENSE',
    'scripts',
    'lib',
    'node_modules',
  ], {
    cwd: stagingRoot,
    encoding: 'utf8',
  });
  ensureSuccess(archiveResult, 'Claude Desktop bundle archive');

  console.log(JSON.stringify({
    ok: true,
    outDir,
    bundlePath,
    manifestPath: path.join(stagingRoot, 'manifest.json'),
  }, null, 2));
};

main();
