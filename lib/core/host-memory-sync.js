import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { hashNormalized, normalizeContent } from './policy.js';
import { ensureProjectionStore, getCurrentMemory, hasTable, listCurrentMemories, upsertCurrentMemory } from './projection-store.js';

const HOST_ALIASES = new Map([
  ['claude', 'claude_code'],
  ['claude-code', 'claude_code'],
  ['chatgpt', 'chatgpt_manual'],
  ['gemini', 'gemini_manual'],
  ['copilot', 'copilot_manual'],
]);

const ALLOWED_SOURCE_HOSTS = new Set([
  'codex',
  'claude_code',
  'openclaw',
  'hermes',
  'chatgpt_manual',
  'gemini_manual',
  'copilot_manual',
  'claude_manual',
  'windsurf',
  'cursor',
]);

const ALLOWED_SOURCE_KINDS = new Set([
  'native_memory',
  'instruction',
  'checkpoint',
  'manual_import',
  'rule',
  'chat_history_hint',
]);

const ALLOWED_SYNC_POLICIES = new Set([
  'read_only',
  'manual_export',
  'bidirectional_disallowed',
]);

const TEXT_EXTENSIONS = new Set(['.md', '.mdx', '.txt', '.json', '.jsonl', '.yaml', '.yml']);
const CLOUD_MANUAL_HOSTS = new Set(['chatgpt_manual', 'gemini_manual', 'copilot_manual', 'claude_manual']);
const BRIDGE_HOSTS = new Set(['hermes']);
const SECRET_RISK_PATTERNS = [
  /\b(?:Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi,
  /\b(?:sk|rk|pk|sess|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9._-]{8,}/g,
  /\b([A-Za-z0-9_.-]*(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret|password|passwd|pwd|client[_ -]?secret)[A-Za-z0-9_.-]*)\b\s*[:=]\s*["']?[^"'\s,;]+["']?/gi,
];

const normalizeHost = (value = '') => {
  const key = String(value || '').trim().toLowerCase().replace(/\s+/g, '_');
  const aliased = HOST_ALIASES.get(key) || key;
  if (!ALLOWED_SOURCE_HOSTS.has(aliased)) {
    throw new Error(`unsupported memory source host: ${value || '(empty)'}`);
  }
  return aliased;
};

const normalizeKind = (value = 'native_memory') => {
  const key = String(value || '').trim().toLowerCase();
  return ALLOWED_SOURCE_KINDS.has(key) ? key : 'native_memory';
};

const normalizePolicy = (value = 'read_only') => {
  const key = String(value || '').trim().toLowerCase();
  return ALLOWED_SYNC_POLICIES.has(key) ? key : 'read_only';
};

const sha256 = (value = '') => crypto.createHash('sha256').update(String(value)).digest('hex');

const hasSecretRisk = (value = '') => SECRET_RISK_PATTERNS.some((pattern) => {
  pattern.lastIndex = 0;
  return pattern.test(String(value || ''));
});

const pathExists = (filePath = '') => {
  try {
    return Boolean(filePath && fs.existsSync(filePath));
  } catch {
    return false;
  }
};

const isDirectory = (filePath = '') => {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
};

const ensureHostMemoryStore = (db) => {
  ensureProjectionStore(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_source_links (
      memory_id TEXT NOT NULL,
      source_host TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_path TEXT NOT NULL,
      source_line INTEGER,
      sync_policy TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      PRIMARY KEY(memory_id, source_host, source_path, source_line)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_source_links_host_status
      ON memory_source_links(source_host, status);
    CREATE INDEX IF NOT EXISTS idx_memory_source_links_memory
      ON memory_source_links(memory_id);

    CREATE TABLE IF NOT EXISTS memory_host_sync_runs (
      run_id TEXT PRIMARY KEY,
      source_host TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      sync_policy TEXT NOT NULL,
      source_path TEXT NOT NULL,
      status TEXT NOT NULL,
      indexed_count INTEGER NOT NULL DEFAULT 0,
      linked_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      synced_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_host_sync_runs_host_time
      ON memory_host_sync_runs(source_host, synced_at DESC);
  `);
};

const redactMemoryText = (value = '') => {
  let text = String(value || '');
  text = text.replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, 'Bearer [REDACTED_SECRET]');
  text = text.replace(/\b(?:sk|rk|pk|sess|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9._-]{8,}/g, '[REDACTED_SECRET]');
  text = text.replace(
    /\b([A-Za-z0-9_.-]*(?:api[_ -]?key|access[_ -]?token|auth[_ -]?token|secret|password|passwd|pwd|client[_ -]?secret)[A-Za-z0-9_.-]*)\b\s*[:=]\s*["']?[^"'\s,;]+["']?/gi,
    '$1=[REDACTED_SECRET]',
  );
  return text.trim();
};

const cleanMarkdownLine = (line = '') => String(line || '')
  .replace(/^\s{0,3}#{1,6}\s+/, '')
  .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
  .replace(/\s+/g, ' ')
  .trim();

const collectJsonStrings = (value, out = [], line = 1) => {
  if (typeof value === 'string') {
    const cleaned = value.replace(/\s+/g, ' ').trim();
    if (cleaned) out.push({ content: cleaned, source_line: out.length + 1 });
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectJsonStrings(item, out, line);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectJsonStrings(item, out, line);
  }
  return out;
};

const parseMemoryFile = (filePath, source = {}) => {
  const ext = path.extname(filePath).toLowerCase();
  const raw = fs.readFileSync(filePath, 'utf8');
  if (ext === '.json') {
    try {
      return collectJsonStrings(JSON.parse(raw)).map((item) => ({
        ...source,
        ...item,
        content: redactMemoryText(item.content),
      })).filter((item) => item.content);
    } catch {
      // Fall through to line parsing for non-standard JSON fragments.
    }
  }
  const rows = [];
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const cleaned = cleanMarkdownLine(lines[index]);
    if (!cleaned || cleaned.length < 4) continue;
    if (/^```/.test(cleaned)) continue;
    rows.push({
      ...source,
      source_line: index + 1,
      content: redactMemoryText(cleaned),
    });
  }
  return rows.filter((item) => item.content);
};

const walkTextFiles = (root, options = {}) => {
  if (!pathExists(root)) return [];
  const maxFiles = Math.max(1, Math.min(5000, Number(options.maxFiles || 750) || 750));
  const out = [];
  const visit = (current) => {
    if (out.length >= maxFiles) return;
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) break;
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        out.push(fullPath);
      }
    }
  };
  if (isDirectory(root)) visit(root);
  else if (TEXT_EXTENSIONS.has(path.extname(root).toLowerCase())) out.push(root);
  return out;
};

const requestedHosts = (hosts = []) => (Array.isArray(hosts) && hosts.length > 0
  ? new Set(hosts.map((host) => normalizeHost(host)))
  : null);

const resolveHostRoots = (options = {}) => {
  const config = options.config || {};
  const codexHome = path.resolve(String(options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex')));
  const claudeHome = path.resolve(String(options.claudeHome || path.join(os.homedir(), '.claude')));
  const hermesHome = path.resolve(String(options.hermesHome || process.env.HERMES_HOME || path.join(os.homedir(), '.hermes')));
  const workspaceRoot = path.resolve(String(options.workspaceRoot || config?.codex?.projectRoot || config?.runtime?.paths?.workspaceRoot || process.cwd()));
  const memoryMdPath = String(config?.native?.memoryMdPath || '').trim();
  const rows = [
    {
      source_host: 'codex',
      source_kind: 'native_memory',
      sync_policy: 'read_only',
      path: path.join(codexHome, 'memories'),
      required_for_sync: true,
    },
    {
      source_host: 'claude_code',
      source_kind: 'native_memory',
      sync_policy: 'read_only',
      path: path.join(claudeHome, 'projects'),
      required_for_sync: true,
    },
    {
      source_host: 'openclaw',
      source_kind: 'checkpoint',
      sync_policy: 'read_only',
      path: memoryMdPath ? path.resolve(memoryMdPath) : '',
      required_for_sync: Boolean(memoryMdPath),
    },
    {
      source_host: 'hermes',
      source_kind: 'native_memory',
      sync_policy: 'read_only',
      path: path.join(hermesHome, 'memories'),
      required_for_sync: true,
    },
    ...['cursor', 'windsurf'].flatMap((host) => {
      const folder = host === 'cursor' ? '.cursor' : '.windsurf';
      return ['rules', 'memories'].map((subdir) => ({
        source_host: host,
        source_kind: subdir === 'rules' ? 'rule' : 'native_memory',
        sync_policy: 'read_only',
        path: path.join(workspaceRoot, folder, subdir),
        required_for_sync: true,
      }));
    }),
  ];
  const manualImportPath = String(options.manualImportPath || '').trim();
  if (manualImportPath) {
    const host = normalizeHost(options.manualSourceHost || 'chatgpt_manual');
    rows.push({
      source_host: host,
      source_kind: 'manual_import',
      sync_policy: 'bidirectional_disallowed',
      path: path.resolve(manualImportPath),
      required_for_sync: true,
    });
  }
  return rows.map((row) => ({
    ...row,
    available: Boolean(row.path && pathExists(row.path)),
  }));
};

const missingHostWarnings = (options = {}) => {
  const requested = requestedHosts(options.hosts);
  const includeDefaultWarnings = requested && requested.size > 0;
  return resolveHostRoots(options)
    .filter((row) => row.required_for_sync && !row.available)
    .filter((row) => includeDefaultWarnings ? requested.has(row.source_host) : row.source_kind === 'manual_import')
    .map((row) => ({
      code: 'host_source_missing',
      source_host: row.source_host,
      source_kind: row.source_kind,
      path: row.path,
      message: `No readable ${row.source_host} ${row.source_kind} source found at ${row.path || '(empty path)'}`,
    }));
};

const sourceDescriptor = ({
  host,
  kind,
  syncPolicy,
  rootPath,
  filePath,
  available = true,
} = {}) => ({
  source_host: normalizeHost(host),
  source_kind: normalizeKind(kind),
  sync_policy: normalizePolicy(syncPolicy),
  root_path: String(rootPath || filePath || ''),
  source_path: String(filePath || rootPath || ''),
  available: available === true,
});

const discoverHostSources = (options = {}) => {
  const config = options.config || {};
  const hosts = requestedHosts(options.hosts);
  const wants = (host) => !hosts || hosts.has(host);
  const sources = [];
  const codexHome = path.resolve(String(options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex')));
  const claudeHome = path.resolve(String(options.claudeHome || path.join(os.homedir(), '.claude')));
  const hermesHome = path.resolve(String(options.hermesHome || process.env.HERMES_HOME || path.join(os.homedir(), '.hermes')));
  const workspaceRoot = path.resolve(String(options.workspaceRoot || config?.codex?.projectRoot || config?.runtime?.paths?.workspaceRoot || process.cwd()));

  if (wants('codex')) {
    const root = path.join(codexHome, 'memories');
    for (const filePath of walkTextFiles(root)) {
      sources.push(sourceDescriptor({ host: 'codex', kind: 'native_memory', syncPolicy: 'read_only', rootPath: root, filePath }));
    }
  }

  if (wants('claude_code')) {
    const projectsRoot = path.join(claudeHome, 'projects');
    for (const filePath of walkTextFiles(projectsRoot)) {
      if (filePath.split(path.sep).includes('memory')) {
        sources.push(sourceDescriptor({ host: 'claude_code', kind: 'native_memory', syncPolicy: 'read_only', rootPath: projectsRoot, filePath }));
      }
    }
  }

  if (wants('openclaw')) {
    const memoryMdPath = String(config?.native?.memoryMdPath || '').trim();
    const root = memoryMdPath ? path.resolve(memoryMdPath) : '';
    if (root && pathExists(root)) {
      sources.push(sourceDescriptor({ host: 'openclaw', kind: 'checkpoint', syncPolicy: 'read_only', rootPath: path.dirname(root), filePath: root }));
    }
  }

  if (wants('hermes')) {
    const root = path.join(hermesHome, 'memories');
    for (const filePath of walkTextFiles(root)) {
      sources.push(sourceDescriptor({ host: 'hermes', kind: 'native_memory', syncPolicy: 'read_only', rootPath: root, filePath }));
    }
  }

  for (const host of ['cursor', 'windsurf']) {
    if (!wants(host)) continue;
    const folder = host === 'cursor' ? '.cursor' : '.windsurf';
    for (const subdir of ['rules', 'memories']) {
      const root = path.join(workspaceRoot, folder, subdir);
      for (const filePath of walkTextFiles(root)) {
        sources.push(sourceDescriptor({ host, kind: subdir === 'rules' ? 'rule' : 'native_memory', syncPolicy: 'read_only', rootPath: root, filePath }));
      }
    }
  }

  const manualImportPath = String(options.manualImportPath || '').trim();
  if (manualImportPath) {
    const host = normalizeHost(options.manualSourceHost || 'chatgpt_manual');
    if (!CLOUD_MANUAL_HOSTS.has(host)) {
      throw new Error('--manual-source-host must be a manual cloud host');
    }
    if (wants(host)) {
      for (const filePath of walkTextFiles(path.resolve(manualImportPath), { maxFiles: 100 })) {
        sources.push(sourceDescriptor({ host, kind: 'manual_import', syncPolicy: 'bidirectional_disallowed', rootPath: manualImportPath, filePath }));
      }
    }
  }

  return sources;
};

const findCanonicalMemory = (db, { normalizedHash, scope } = {}) => {
  return db.prepare(`
    SELECT memory_id
    FROM memory_current
    WHERE normalized_hash = ? AND scope = ? AND status = 'active'
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(String(normalizedHash || ''), String(scope || 'shared')) || null;
};

const linkMemorySource = (db, link = {}) => {
  const nowIso = new Date().toISOString();
  db.prepare(`
    INSERT INTO memory_source_links (
      memory_id, source_host, source_kind, source_path, source_line, sync_policy,
      content_hash, first_seen_at, last_seen_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    ON CONFLICT(memory_id, source_host, source_path, source_line) DO UPDATE SET
      source_kind = excluded.source_kind,
      sync_policy = excluded.sync_policy,
      content_hash = excluded.content_hash,
      last_seen_at = excluded.last_seen_at,
      status = 'active'
  `).run(
    String(link.memory_id || ''),
    normalizeHost(link.source_host),
    normalizeKind(link.source_kind),
    String(link.source_path || ''),
    Number.isFinite(Number(link.source_line)) ? Number(link.source_line) : null,
    normalizePolicy(link.sync_policy),
    String(link.content_hash || ''),
    nowIso,
    nowIso,
  );
};

const recordSyncRun = (db, run = {}) => {
  db.prepare(`
    INSERT INTO memory_host_sync_runs (
      run_id, source_host, source_kind, sync_policy, source_path, status,
      indexed_count, linked_count, skipped_count, error, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(run.run_id || `host-sync:${sha256(JSON.stringify(run)).slice(0, 24)}`),
    normalizeHost(run.source_host),
    normalizeKind(run.source_kind),
    normalizePolicy(run.sync_policy),
    String(run.source_path || ''),
    String(run.status || 'ok'),
    Number(run.indexed_count || 0),
    Number(run.linked_count || 0),
    Number(run.skipped_count || 0),
    run.error ? String(run.error) : null,
    String(run.synced_at || new Date().toISOString()),
  );
};

const resolveHostScope = (config = {}, explicitScope = '') => {
  const scope = String(explicitScope || '').trim();
  if (scope) return scope;
  return String(config?.codex?.defaultUserScope || 'profile:user').trim() || 'profile:user';
};

const memoryIdForImport = ({ sourceHost, sourcePath, sourceLine, normalizedHash, scope } = {}) => {
  return `host:${sourceHost}:${sha256([scope, sourceHost, sourcePath, sourceLine || '', normalizedHash].join('\n')).slice(0, 32)}`;
};

const syncHostMemories = (options = {}) => {
  const db = options.db;
  if (!db) throw new Error('syncHostMemories requires db');
  const config = options.config || {};
  const scope = resolveHostScope(config, options.scope);
  ensureHostMemoryStore(db);
  const sources = discoverHostSources(options);
  const summary = {
    ok: true,
    command: 'sync-hosts',
    dry_run: options.dryRun === true,
    scope,
    summary: {
      source_count: sources.length,
      indexed_count: 0,
      inserted_count: 0,
      linked_count: 0,
      skipped_count: 0,
    },
    source_count: sources.length,
    indexed_count: 0,
    inserted_count: 0,
    linked_count: 0,
    skipped_count: 0,
    warnings: missingHostWarnings(options),
    message: sources.length === 0
      ? 'No local host memory sources were found. Use --host to target known local hosts or --manual-import for explicit cloud exports.'
      : '',
    sources: [],
    runs: [],
  };

  for (const source of sources) {
    const run = {
      run_id: `host-sync:${source.source_host}:${sha256(`${source.source_path}:${Date.now()}:${Math.random()}`).slice(0, 16)}`,
      source_host: source.source_host,
      source_kind: source.source_kind,
      sync_policy: source.sync_policy,
      source_path: source.source_path,
      status: 'ok',
      indexed_count: 0,
      linked_count: 0,
      skipped_count: 0,
      synced_at: new Date().toISOString(),
    };
    try {
      const items = parseMemoryFile(source.source_path, source);
      for (const item of items) {
        const normalized = normalizeContent(item.content);
        if (!normalized || normalized.length < 4) {
          run.skipped_count += 1;
          continue;
        }
        const normalizedHash = hashNormalized(normalized);
        const existing = findCanonicalMemory(db, { normalizedHash, scope });
        const memoryId = existing?.memory_id || memoryIdForImport({
          sourceHost: item.source_host,
          sourcePath: item.source_path,
          sourceLine: item.source_line,
          normalizedHash,
          scope,
        });
        if (options.dryRun !== true && !existing) {
          upsertCurrentMemory(db, {
            memory_id: memoryId,
            type: item.source_kind === 'rule' || item.source_kind === 'instruction' ? 'DECISION' : 'USER_FACT',
            content: item.content,
            normalized,
            source: 'host_sync',
            source_agent: item.source_host,
            source_layer: 'host_memory',
            source_path: item.source_path,
            source_line: item.source_line,
            source_host: item.source_host,
            source_kind: item.source_kind,
            sync_policy: item.sync_policy,
            confidence: item.source_kind === 'manual_import' ? 0.68 : 0.74,
            scope,
            status: 'active',
            tags: ['host_sync', `source_host:${item.source_host}`, `source_kind:${item.source_kind}`],
          });
          summary.inserted_count += 1;
        }
        if (options.dryRun !== true) {
          linkMemorySource(db, {
            memory_id: memoryId,
            source_host: item.source_host,
            source_kind: item.source_kind,
            source_path: item.source_path,
            source_line: item.source_line,
            sync_policy: item.sync_policy,
            content_hash: normalizedHash,
          });
        }
        run.indexed_count += 1;
        run.linked_count += 1;
      }
    } catch (err) {
      run.status = 'error';
      run.error = err instanceof Error ? err.message : String(err);
      summary.ok = false;
    }
    summary.indexed_count += run.indexed_count;
    summary.linked_count += run.linked_count;
    summary.skipped_count += run.skipped_count;
    summary.summary.indexed_count = summary.indexed_count;
    summary.summary.inserted_count = summary.inserted_count;
    summary.summary.linked_count = summary.linked_count;
    summary.summary.skipped_count = summary.skipped_count;
    summary.sources.push({
      source_host: source.source_host,
      source_kind: source.source_kind,
      sync_policy: source.sync_policy,
      source_path: source.source_path,
      indexed_count: run.indexed_count,
      linked_count: run.linked_count,
      skipped_count: run.skipped_count,
      status: run.status,
      error: run.error || '',
    });
    summary.runs.push(run);
    if (options.dryRun !== true) recordSyncRun(db, run);
  }
  return summary;
};

const listMemorySources = ({ db, config = {}, includeDiscovery = false, ...options } = {}) => {
  if (!db) throw new Error('listMemorySources requires db');
  ensureHostMemoryStore(db);
  const rows = db.prepare(`
    SELECT
      source_host,
      source_kind,
      sync_policy,
      source_path,
      COUNT(*) AS memory_count,
      MAX(last_seen_at) AS last_seen_at,
      status
    FROM memory_source_links
    GROUP BY source_host, source_kind, sync_policy, source_path, status
    ORDER BY source_host ASC, last_seen_at DESC
  `).all();
  const sourceRows = rows.map((row) => ({
    ...row,
    memory_count: Number(row.memory_count || 0),
  }));
  const syncedPaths = new Set(sourceRows.map((row) => String(row.source_path || '')));
  const discovered = includeDiscovery
    ? discoverHostSources({ config, ...options }).map((source) => ({
      source_host: source.source_host,
      source_kind: source.source_kind,
      sync_policy: source.sync_policy,
      source_path: source.source_path,
      available: pathExists(source.source_path),
      synced: syncedPaths.has(String(source.source_path || '')),
    }))
    : [];
  return {
    ok: true,
    sources: sourceRows,
    discovered,
    warnings: missingHostWarnings({ config, ...options }),
  };
};

const groupHostStatus = (hosts = []) => {
  const groups = {
    ready: [],
    never_synced: [],
    manual_only: [],
    bridge: [],
  };
  for (const row of hosts) {
    const host = String(row.source_host || '');
    if (BRIDGE_HOSTS.has(host)) {
      groups.bridge.push(row);
    } else if (CLOUD_MANUAL_HOSTS.has(host)) {
      groups.manual_only.push(row);
    } else if (row.status === 'ok' || Number(row.local_sources_detected || 0) > 0) {
      groups.ready.push(row);
    } else {
      groups.never_synced.push(row);
    }
  }
  return groups;
};

const getSyncStatus = ({ db, config = {}, ...options } = {}) => {
  if (!db) throw new Error('getSyncStatus requires db');
  ensureHostMemoryStore(db);
  const runRows = db.prepare(`
    SELECT r.*
    FROM memory_host_sync_runs r
    INNER JOIN (
      SELECT source_host, MAX(synced_at) AS synced_at
      FROM memory_host_sync_runs
      GROUP BY source_host
    ) latest ON latest.source_host = r.source_host AND latest.synced_at = r.synced_at
    ORDER BY r.source_host ASC
  `).all();
  const discovered = discoverHostSources({ config, ...options });
  const discoveredCounts = new Map();
  for (const source of discovered) {
    discoveredCounts.set(source.source_host, (discoveredCounts.get(source.source_host) || 0) + 1);
  }
  const hosts = Array.from(new Set([
    ...Array.from(ALLOWED_SOURCE_HOSTS),
    ...runRows.map((row) => String(row.source_host || '')),
  ])).filter(Boolean).sort();
  const hostRows = hosts.map((host) => {
    const run = runRows.find((row) => row.source_host === host) || null;
    return {
      source_host: host,
      local_sources_detected: Number(discoveredCounts.get(host) || 0),
      last_sync_at: String(run?.synced_at || ''),
      status: run ? String(run.status || 'unknown') : 'never_synced',
      indexed_count: Number(run?.indexed_count || 0),
      linked_count: Number(run?.linked_count || 0),
      skipped_count: Number(run?.skipped_count || 0),
      sync_policy: String(run?.sync_policy || (CLOUD_MANUAL_HOSTS.has(host) ? 'bidirectional_disallowed' : 'read_only')),
      error: String(run?.error || ''),
    };
  });
  return {
    ok: true,
    hosts: hostRows,
    groups: groupHostStatus(hostRows),
    warnings: missingHostWarnings({ config, ...options }),
    hermes_bridge: {
      mode: 'mcp_or_http_bridge',
      configured: config?.remoteBridge?.enabled === true,
      base_url: String(config?.remoteBridge?.baseUrl || ''),
    },
  };
};

const exportMemoryBrief = ({ db, config = {}, targetHost = 'agents', scope = '', limit = 25 } = {}) => {
  if (!db) throw new Error('exportMemoryBrief requires db');
  ensureHostMemoryStore(db);
  const resolvedScope = String(scope || '').trim();
  const rowLimit = Math.max(1, Math.min(100, Number(limit || 25) || 25));
  const rows = listCurrentMemories(db, {
    statuses: ['active'],
    scope: resolvedScope,
    limit: 10000,
  });
  const selected = [];
  let omittedSecretRisks = 0;
  for (const row of rows) {
    if (hasSecretRisk(row.content)) {
      omittedSecretRisks += 1;
      continue;
    }
    if (selected.length < rowLimit) selected.push(row);
  }
  const target = String(targetHost || 'agents').trim().toLowerCase();
  const header = target === 'claude_code' || target === 'claude'
    ? '# CLAUDE.md Memory Brief'
    : target === 'codex' || target === 'agents'
      ? '# AGENTS.md Memory Brief'
      : '# Gigabrain Memory Brief';
  const lines = [
    header,
    '',
    'Generated by Gigabrain for explicit manual export. Closed cloud memory systems require user-controlled paste/import; Gigabrain does not scrape them.',
    '',
  ];
  if (omittedSecretRisks > 0) {
    lines.push(`Safety: omitted ${omittedSecretRisks} secret-risk memory row${omittedSecretRisks === 1 ? '' : 's'} from this brief. Review the Passport Secret Risk Audit instead of pasting redacted secrets into another host.`);
    lines.push('');
  }
  for (const row of selected) {
    const host = String(row.source_host || 'gigabrain');
    const kind = String(row.source_kind || 'registry');
    lines.push(`- [${host}/${kind}] ${redactMemoryText(row.content)}`);
  }
  const brief = `${lines.join('\n').trim()}\n`;
  return {
    ok: true,
    target_host: target,
    format: 'markdown',
    scope: resolvedScope,
    item_count: selected.length,
    omitted_secret_risks: omittedSecretRisks,
    brief,
    config_project_root: String(config?.codex?.projectRoot || ''),
  };
};

const sourceLinksForMemory = (db, memoryId = '') => {
  if (!hasTable(db, 'memory_source_links')) return [];
  return db.prepare(`
    SELECT source_host, source_kind, sync_policy, source_path, source_line, last_seen_at, status
    FROM memory_source_links
    WHERE memory_id = ? AND status = 'active'
    ORDER BY source_host ASC, source_path ASC, source_line ASC
  `).all(String(memoryId || ''));
};

const expandMemorySourceLinks = (db, memoryId = '') => {
  const row = getCurrentMemory(db, memoryId);
  if (!row) return [];
  return sourceLinksForMemory(db, memoryId);
};

export {
  ALLOWED_SOURCE_HOSTS,
  ALLOWED_SOURCE_KINDS,
  ALLOWED_SYNC_POLICIES,
  CLOUD_MANUAL_HOSTS,
  discoverHostSources,
  ensureHostMemoryStore,
  expandMemorySourceLinks,
  exportMemoryBrief,
  groupHostStatus,
  getSyncStatus,
  hasSecretRisk,
  linkMemorySource,
  listMemorySources,
  normalizeHost,
  normalizeKind,
  normalizePolicy,
  parseMemoryFile,
  recordSyncRun,
  redactMemoryText,
  syncHostMemories,
};
