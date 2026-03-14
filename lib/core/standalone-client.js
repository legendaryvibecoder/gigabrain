import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_GLOBAL_STANDALONE_STORE = path.join(os.homedir(), '.gigabrain');
const DEFAULT_LEGACY_CODEX_STORE = path.join(os.homedir(), '.codex', 'gigabrain');

const shellEscape = (value = '') => `'${String(value || '').replace(/'/g, `'\\''`)}'`;

const expandHome = (value = '') => {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  const envExpanded = raw
    .replace(/\$\{HOME\}/g, os.homedir())
    .replace(/\$HOME\b/g, os.homedir());
  if (envExpanded === '~') return os.homedir();
  if (envExpanded.startsWith('~/')) return path.join(os.homedir(), envExpanded.slice(2));
  return envExpanded;
};

const resolveAbsolutePath = (value = '') => path.resolve(expandHome(value || ''));
const PORTABLE_STANDALONE_CONFIG_PATH = '~/.gigabrain/config.json';

const defaultStandaloneConfigPathForStore = (storeRoot = '') => path.join(
  resolveAbsolutePath(storeRoot || DEFAULT_GLOBAL_STANDALONE_STORE),
  'config.json',
);

const defaultUserOverlayPathForStore = (storeRoot = '') => path.join(
  resolveAbsolutePath(storeRoot || DEFAULT_GLOBAL_STANDALONE_STORE),
  'profile',
);

const normalizeStandaloneStoreMode = (value = '') => {
  const key = String(value || '').trim().toLowerCase();
  if (['project-local', 'project_local', 'local', 'repo', 'repo-local'].includes(key)) return 'project_local';
  return 'global';
};

const describeStandaloneConfigPath = ({
  configPath = '',
  projectRoot = '',
  storeMode = 'global',
} = {}) => {
  const normalizedStoreMode = normalizeStandaloneStoreMode(storeMode);
  const resolvedConfigPath = resolveAbsolutePath(configPath || defaultStandaloneConfigPathForStore(DEFAULT_GLOBAL_STANDALONE_STORE));
  const resolvedProjectRoot = projectRoot ? resolveAbsolutePath(projectRoot) : '';
  const projectLocalConfigPath = resolvedProjectRoot
    ? path.join(resolvedProjectRoot, '.gigabrain', 'config.json')
    : '';
  const canonicalConfigPath = defaultStandaloneConfigPathForStore(DEFAULT_GLOBAL_STANDALONE_STORE);
  const legacyConfigPath = defaultStandaloneConfigPathForStore(DEFAULT_LEGACY_CODEX_STORE);
  let pathKind = 'custom';
  if (normalizedStoreMode === 'project_local' && projectLocalConfigPath && resolvedConfigPath === projectLocalConfigPath) {
    pathKind = 'project_local';
  } else if (resolvedConfigPath === canonicalConfigPath) {
    pathKind = 'canonical';
  } else if (resolvedConfigPath === legacyConfigPath) {
    pathKind = 'legacy_supported';
  }
  return {
    configPath: resolvedConfigPath,
    storeRoot: path.dirname(resolvedConfigPath),
    pathKind,
    sharingMode: normalizedStoreMode === 'project_local' ? 'project-local' : 'shared-standalone',
    canonicalConfigPath,
    legacyConfigPath,
    projectLocalConfigPath,
    isLegacyPath: pathKind === 'legacy_supported',
    isCanonicalPath: pathKind === 'canonical',
  };
};

const resolveStandaloneConfigPath = ({
  explicitConfigPath = '',
  projectRoot = '',
  storeMode = 'global',
} = {}) => {
  const normalizedStoreMode = normalizeStandaloneStoreMode(storeMode);
  if (explicitConfigPath) {
    return describeStandaloneConfigPath({
      configPath: explicitConfigPath,
      projectRoot,
      storeMode: normalizedStoreMode,
    });
  }
  const resolvedProjectRoot = projectRoot ? resolveAbsolutePath(projectRoot) : process.cwd();
  if (normalizedStoreMode === 'project_local') {
    return describeStandaloneConfigPath({
      configPath: path.join(resolvedProjectRoot, '.gigabrain', 'config.json'),
      projectRoot: resolvedProjectRoot,
      storeMode: normalizedStoreMode,
    });
  }
  const canonicalConfigPath = defaultStandaloneConfigPathForStore(DEFAULT_GLOBAL_STANDALONE_STORE);
  if (fs.existsSync(canonicalConfigPath)) {
    return describeStandaloneConfigPath({
      configPath: canonicalConfigPath,
      projectRoot: resolvedProjectRoot,
      storeMode: normalizedStoreMode,
    });
  }
  const legacyConfigPath = defaultStandaloneConfigPathForStore(DEFAULT_LEGACY_CODEX_STORE);
  if (fs.existsSync(legacyConfigPath)) {
    return describeStandaloneConfigPath({
      configPath: legacyConfigPath,
      projectRoot: resolvedProjectRoot,
      storeMode: normalizedStoreMode,
    });
  }
  return describeStandaloneConfigPath({
    configPath: canonicalConfigPath,
    projectRoot: resolvedProjectRoot,
    storeMode: normalizedStoreMode,
  });
};

const resolveRuntimeStandaloneConfigPath = (configPath = '') => {
  const raw = String(configPath || '').trim();
  const attemptedPath = raw ? resolveAbsolutePath(raw) : '';
  const canonicalConfigPath = defaultStandaloneConfigPathForStore(DEFAULT_GLOBAL_STANDALONE_STORE);
  const legacyConfigPath = defaultStandaloneConfigPathForStore(DEFAULT_LEGACY_CODEX_STORE);
  if (attemptedPath && fs.existsSync(attemptedPath)) {
    return {
      inputPath: raw,
      attemptedPath,
      resolvedPath: attemptedPath,
      fallbackUsed: false,
      fallbackKind: 'explicit',
    };
  }
  if (fs.existsSync(canonicalConfigPath)) {
    return {
      inputPath: raw,
      attemptedPath,
      resolvedPath: canonicalConfigPath,
      fallbackUsed: attemptedPath !== canonicalConfigPath,
      fallbackKind: attemptedPath === canonicalConfigPath ? 'explicit' : 'canonical',
    };
  }
  if (fs.existsSync(legacyConfigPath)) {
    return {
      inputPath: raw,
      attemptedPath,
      resolvedPath: legacyConfigPath,
      fallbackUsed: attemptedPath !== legacyConfigPath,
      fallbackKind: attemptedPath === legacyConfigPath ? 'explicit' : 'legacy_supported',
    };
  }
  return {
    inputPath: raw,
    attemptedPath,
    resolvedPath: attemptedPath || canonicalConfigPath,
    fallbackUsed: false,
    fallbackKind: attemptedPath ? 'missing' : 'canonical_missing',
  };
};

const readJson = (filePath, fallback = {}) => {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
};

const writeJsonPretty = (filePath, payload) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
};

const upsertMarkedBlock = ({ existing = '', startMarker, endMarker, block }) => {
  const start = existing.indexOf(startMarker);
  const end = existing.indexOf(endMarker);
  if (start !== -1 && end !== -1 && end >= start) {
    const before = existing.slice(0, start).trimEnd();
    const after = existing.slice(end + endMarker.length).trimStart();
    return [before, block.trim(), after].filter(Boolean).join('\n\n').concat('\n');
  }
  if (!String(existing || '').trim()) return `${block.trim()}\n`;
  return `${String(existing).trimEnd()}\n\n${block.trim()}\n`;
};

const ensureGitIgnoreEntry = (projectRoot, entry = '.gigabrain/') => {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
  const lines = existing.replace(/\r/g, '').split('\n').filter(Boolean);
  if (lines.includes(entry)) return { changed: false, path: gitignorePath };
  const next = existing.trim().length > 0
    ? `${existing.trimEnd()}\n${entry}\n`
    : `${entry}\n`;
  fs.writeFileSync(gitignorePath, next, 'utf8');
  return { changed: true, path: gitignorePath };
};

const writeExecutableFile = (filePath, content) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
  fs.chmodSync(filePath, 0o755);
};

const buildMcpLaunchArgs = ({ packageRoot, configPath }) => [
  process.execPath,
  path.join(packageRoot, 'scripts', 'gigabrain-mcp.js'),
  '--config',
  configPath,
];

const upsertMcpServerEntry = ({
  mcpPath,
  serverName = 'gigabrain',
  serverConfig = {},
} = {}) => {
  const existing = fs.existsSync(mcpPath) ? fs.readFileSync(mcpPath, 'utf8') : '';
  const parsed = existing.trim() ? JSON.parse(existing) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${mcpPath} must contain a JSON object`);
  }
  const next = {
    ...parsed,
    mcpServers: {
      ...((parsed.mcpServers && typeof parsed.mcpServers === 'object' && !Array.isArray(parsed.mcpServers)) ? parsed.mcpServers : {}),
      [serverName]: serverConfig,
    },
  };
  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  fs.mkdirSync(path.dirname(mcpPath), { recursive: true });
  if (nextText !== existing) fs.writeFileSync(mcpPath, nextText, 'utf8');
  return {
    changed: nextText !== existing,
    path: mcpPath,
    serverName,
  };
};

export {
  DEFAULT_GLOBAL_STANDALONE_STORE,
  DEFAULT_LEGACY_CODEX_STORE,
  PORTABLE_STANDALONE_CONFIG_PATH,
  shellEscape,
  expandHome,
  resolveAbsolutePath,
  defaultStandaloneConfigPathForStore,
  defaultUserOverlayPathForStore,
  normalizeStandaloneStoreMode,
  describeStandaloneConfigPath,
  resolveStandaloneConfigPath,
  resolveRuntimeStandaloneConfigPath,
  readJson,
  writeJsonPretty,
  upsertMarkedBlock,
  ensureGitIgnoreEntry,
  writeExecutableFile,
  buildMcpLaunchArgs,
  upsertMcpServerEntry,
};
