import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_GLOBAL_CODEX_STORE = path.join(os.homedir(), '.codex', 'gigabrain');

const shellEscape = (value = '') => `'${String(value || '').replace(/'/g, `'\\''`)}'`;

const expandHome = (value = '') => {
  const raw = String(value || '').trim();
  if (!raw) return raw;
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return raw;
};

const defaultUserOverlayPathForStore = (storeRoot = '') => path.join(path.resolve(expandHome(storeRoot || DEFAULT_GLOBAL_CODEX_STORE)), 'profile');

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
  DEFAULT_GLOBAL_CODEX_STORE,
  shellEscape,
  expandHome,
  defaultUserOverlayPathForStore,
  readJson,
  writeJsonPretty,
  upsertMarkedBlock,
  ensureGitIgnoreEntry,
  writeExecutableFile,
  buildMcpLaunchArgs,
  upsertMcpServerEntry,
};
