import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { ensurePersonStore } from './person-service.js';
import { ensureProjectionStore, listCurrentMemories, tableStats } from './projection-store.js';
import { ensureNativeStore, resolveNativeSourcePaths } from './native-sync.js';
import { openDatabase } from './sqlite.js';
import {
  ensureWorldModelReady,
  ensureWorldModelStore,
  isDurableMemoryTier,
  listBeliefs,
  listContradictions,
  listEntities,
  listEpisodes,
  listOpenLoops,
  listRelationships,
  listSyntheses,
  isDisplaySurfaceEpisode,
  pickSurfaceSummaryBelief,
  resolveMemoryTier,
  selectSurfaceBeliefsForEntity,
  suggestContradictionResolution,
  getEntityEvolution,
} from './world-model.js';

const GENERATED_DIRS = Object.freeze([
  '00 Home',
  '10 Native',
  '20 Entities',
  '20 Nodes',
  '30 Timelines',
  '30 Views',
  '40 Reviews',
  '50 Briefings',
  '40 Reports',
  '60 Reports',
]);

const STALE_WINDOWS_DAYS = Object.freeze({
  native: 7,
  daily: 7,
  vault: 2,
});

const ensureDir = (dirPath) => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const ensureFileDir = (filePath) => {
  ensureDir(path.dirname(filePath));
};

const toPosix = (value) => String(value || '').replace(/\\/g, '/');

const readUtf8IfExists = (filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf8');
};

const readJsonIfExists = (filePath, fallback = null) => {
  if (!filePath || !fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
};

const listFilesRecursively = (rootDir) => {
  if (!rootDir || !fs.existsSync(rootDir)) return [];
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(filePath);
        continue;
      }
      out.push(filePath);
    }
  };
  walk(rootDir);
  return out;
};

const listDirsDeepestFirst = (rootDir) => {
  if (!rootDir || !fs.existsSync(rootDir)) return [];
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const dirPath = path.join(current, entry.name);
      if (!entry.isDirectory()) continue;
      walk(dirPath);
      out.push(dirPath);
    }
  };
  walk(rootDir);
  return out.sort((a, b) => b.length - a.length);
};

const sameFileContent = (aPath, bPath) => {
  if (!fs.existsSync(aPath) || !fs.existsSync(bPath)) return false;
  const a = fs.readFileSync(aPath);
  const b = fs.readFileSync(bPath);
  return Buffer.compare(a, b) === 0;
};

const safeFileName = (value, fallback = 'note') => {
  const text = String(value || '').trim();
  const cleaned = text.replace(/[^A-Za-z0-9._-]/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || fallback;
};

const wikiLink = (relPath, label = '') => {
  const notePath = toPosix(relPath).replace(/\.md$/i, '');
  if (!label) return `[[${notePath}]]`;
  return `[[${notePath}|${label}]]`;
};

const yamlScalar = (value) => {
  if (value === null || value === undefined || value === '') return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const text = String(value);
  if (/^[A-Za-z0-9_.:-]+$/.test(text)) return text;
  return JSON.stringify(text);
};

const renderFrontmatter = (payload = {}) => {
  const lines = ['---'];
  for (const [key, raw] of Object.entries(payload)) {
    if (Array.isArray(raw)) {
      if (raw.length === 0) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
      for (const item of raw) {
        lines.push(`  - ${yamlScalar(item)}`);
      }
      continue;
    }
    lines.push(`${key}: ${yamlScalar(raw)}`);
  }
  lines.push('---', '');
  return `${lines.join('\n')}\n`;
};

const parseJsonArray = (value) => {
  if (Array.isArray(value)) return value;
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const formatMaybeNumber = (value, digits = 2) => (
  Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : 'n/a'
);

const latestEntry = (items = [], selector = (item) => item) => {
  let best = null;
  let bestScore = -Infinity;
  for (const item of items) {
    const score = Number(selector(item));
    if (!Number.isFinite(score)) continue;
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
};

const daysToMs = (days) => Math.max(1, Number(days || 0)) * 24 * 60 * 60 * 1000;

const isVaultProtectedPath = (relPath) => {
  const normalized = toPosix(relPath);
  return normalized.startsWith('.obsidian/')
    || normalized === '.obsidian'
    || normalized.startsWith('.git/')
    || normalized === '.git'
    || normalized.startsWith('.stfolder/')
    || normalized === '.stfolder';
};

const firstSegment = (relPath) => {
  const normalized = toPosix(relPath).replace(/^\/+/, '');
  return normalized.split('/')[0] || '';
};

const isManualPath = (relPath, manualFolders = []) => manualFolders.includes(firstSegment(relPath));

const isManagedGeneratedPath = (relPath) => {
  const normalized = toPosix(relPath);
  if (normalized === 'vault-index.md') return true;
  if (normalized === 'MEMORY.md') return true;
  if (normalized.startsWith('memory/')) return true;
  if (normalized === 'memory') return true;
  return GENERATED_DIRS.includes(firstSegment(normalized));
};

const findLatestFileMatching = (dirPath, matcher) => {
  if (!dirPath || !fs.existsSync(dirPath)) return '';
  const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dirPath, entry.name))
    .filter((filePath) => matcher(path.basename(filePath)));
  const sorted = entries.sort((a, b) => {
    const aMs = fs.statSync(a).mtimeMs;
    const bMs = fs.statSync(b).mtimeMs;
    return bMs - aMs || path.basename(b).localeCompare(path.basename(a));
  });
  return sorted[0] || '';
};

const listFilesMatchingSorted = (dirPath, matcher) => {
  if (!dirPath || !fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(dirPath, entry.name))
    .filter((filePath) => matcher(path.basename(filePath)))
    .sort((a, b) => {
      const aMs = fs.statSync(a).mtimeMs;
      const bMs = fs.statSync(b).mtimeMs;
      return bMs - aMs || path.basename(b).localeCompare(path.basename(a));
    });
};

const resolveLatestNonDryRunExecutionArtifact = (outputDir, preferredPath = '') => {
  const preferred = String(preferredPath || '').trim();
  const candidates = [];
  if (preferred && fs.existsSync(preferred)) candidates.push(preferred);
  for (const filePath of listFilesMatchingSorted(outputDir, (name) => /^nightly-execution-.*\.json$/i.test(name))) {
    if (!candidates.includes(filePath)) candidates.push(filePath);
  }
  for (const filePath of candidates) {
    const data = readJsonIfExists(filePath, null);
    if (!data || typeof data !== 'object') continue;
    if (data.dry_run === true) continue;
    return {
      source_path: filePath,
      data,
    };
  }
  return {
    source_path: '',
    data: {},
  };
};

const readJsonlRows = (filePath, limit = 200) => {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const rows = [];
  for (const line of fs.readFileSync(filePath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row && typeof row === 'object') rows.push(row);
    } catch {
      // ignore malformed rows in human-facing views
    }
  }
  return rows.slice(0, Math.max(0, Number(limit || 0) || 0));
};

const openContextDb = ({ db, dbPath, config } = {}) => {
  if (db) {
    ensureProjectionStore(db);
    ensureNativeStore(db);
    ensurePersonStore(db);
    ensureWorldModelStore(db);
    ensureWorldModelReady({ db, config, rebuildIfEmpty: true });
    return { db, close: false };
  }
  const resolvedPath = String(dbPath || config?.runtime?.paths?.registryPath || '').trim();
  const opened = openDatabase(resolvedPath);
  ensureProjectionStore(opened);
  ensureNativeStore(opened);
  ensurePersonStore(opened);
  ensureWorldModelStore(opened);
  ensureWorldModelReady({ db: opened, config, rebuildIfEmpty: true });
  return { db: opened, close: true };
};

const resolveMirrorRoot = (config = {}) => {
  const vaultRoot = String(config?.vault?.path || '').trim();
  const subdir = String(config?.vault?.subdir || 'Gigabrain').trim() || 'Gigabrain';
  return {
    vaultRoot,
    subdir,
    mirrorRoot: path.join(vaultRoot, subdir),
  };
};

const nativeNotePath = (workspaceRelPath) => toPosix(path.join('10 Native', workspaceRelPath));
const homeNotePath = (homeNoteName = 'Home') => toPosix(path.join('00 Home', `${homeNoteName}.md`));
const entityDirName = (kind = '') => {
  const key = String(kind || '').trim().toLowerCase();
  if (key === 'person') return 'people';
  if (key === 'organization') return 'organizations';
  if (key === 'place') return 'places';
  return `${key || 'topic'}s`;
};
const entityNotePath = (entity = {}) => toPosix(path.join('20 Entities', entityDirName(entity.kind), `${safeFileName(entity.entity_id || entity.display_name || 'entity')}.md`));

const renderNodeNote = (node) => {
  const frontmatter = renderFrontmatter({
    id: node.id,
    type: node.type,
    scope: node.scope,
    status: node.status,
    confidence: Number.isFinite(Number(node.confidence)) ? Number(node.confidence) : 0,
    quality_score: Number.isFinite(Number(node.quality_score)) ? Number(node.quality_score) : null,
    created_at: node.created_at || null,
    updated_at: node.updated_at || null,
    reason_codes: Array.isArray(node.reason_codes) ? node.reason_codes : [],
    source_layer: node.source_layer || null,
    source_kind: node.source_kind || null,
    source_path: node.source_path || null,
    source_line: Number.isFinite(Number(node.source_line)) ? Number(node.source_line) : null,
    matched_memory_id: node.matched_memory_id || null,
    linked_entities: Array.isArray(node.linked_entities) ? node.linked_entities : [],
    linked_nodes: Array.isArray(node.linked_nodes) ? node.linked_nodes : [],
  });

  const lines = [];
  lines.push(`# ${node.type} · ${node.id}`);
  lines.push('');
  lines.push(node.content || '');
  lines.push('');
  lines.push('## Status');
  lines.push('');
  lines.push(`- active_status: ${node.status}`);
  lines.push(`- confidence: ${formatMaybeNumber(node.confidence)}`);
  lines.push(`- quality_score: ${formatMaybeNumber(node.quality_score)}`);
  lines.push(`- explanation: ${node.status === 'active' ? 'This node is part of the live registry and exported into the Obsidian surface.' : 'This node is not currently active.'}`);
  if (node.reason_codes?.length) lines.push(`- reason_codes: ${node.reason_codes.join(', ')}`);
  lines.push('');

  if (node.source_links?.length || node.source_path) {
    lines.push('## Provenance');
    lines.push('');
    lines.push(`- source_layer: ${node.source_layer || 'registry'}`);
    if (node.source_links?.length) {
      for (const source of node.source_links) {
        const lineSuffix = Number.isFinite(Number(source.source_line)) ? ` (line ${Number(source.source_line)})` : '';
        lines.push(`- ${wikiLink(source.note_path, source.label || source.source_path)}${lineSuffix}`);
      }
    } else if (node.source_path) {
      const lineSuffix = Number.isFinite(Number(node.source_line)) ? ` (line ${Number(node.source_line)})` : '';
      const fallbackLink = node.source_note_path
        ? wikiLink(node.source_note_path, node.source_path)
        : node.source_path;
      lines.push(`- ${fallbackLink}${lineSuffix}`);
    }
    lines.push('');
  }

  if (node.linked_entities?.length) {
    lines.push('## Linked Entities');
    lines.push('');
    for (const entity of node.linked_entities) {
      lines.push(`- ${entity}`);
    }
    lines.push('');
  }

  if (node.related_links?.length) {
    lines.push('## Related Memories');
    lines.push('');
    for (const relation of node.related_links) {
      lines.push(`- ${wikiLink(relation.note_path, relation.label)}`);
    }
    lines.push('');
  }

  return `${frontmatter}${lines.join('\n')}\n`;
};

const renderHomeNote = (summary) => {
  const obsidianMode = String(summary?.surface?.obsidian_mode || 'curated').trim().toLowerCase();
  const exportDiagnostics = summary?.surface?.export_diagnostics === true || obsidianMode === 'diagnostic';
  const lines = [];
  lines.push('# Gigabrain Memory Surface');
  lines.push('');
  lines.push(`- generated_at: ${summary.generated_at}`);
  lines.push(`- vault_root: ${summary.vault_root}`);
  lines.push(`- subdir: ${summary.subdir}`);
  lines.push(`- active_nodes: ${summary.active_nodes}`);
  lines.push(`- entities: ${summary.entities || 0}`);
  lines.push(`- native_sources: ${summary.native_sources.total}`);
  lines.push(`- recent_archives: ${summary.recent_archives.count}`);
  lines.push('');
  lines.push('## Model');
  lines.push('');
  lines.push('- Native markdown is the human-readable memory layer.');
  lines.push('- Registry nodes are the structured Gigabrain layer used for recall, dedupe, and hygiene.');
  lines.push('- The default Obsidian surface is curated: only stable people, projects, and high-confidence briefings are shown by default.');
  lines.push('- `source_layer=native` means a registry node has a first-class native source; `promoted_native` means it was promoted from native memory later.');
  lines.push('');
  lines.push('## Health');
  lines.push('');
  lines.push(`- native_source_last_seen: ${summary.freshness.native.last_source_at || 'none'}`);
  lines.push(`- daily_note_last_seen: ${summary.freshness.native.last_daily_note_at || 'none'}`);
  lines.push(`- vault_build_last_seen: ${summary.freshness.vault.last_built_at || summary.generated_at}`);
  lines.push(`- native_stale: ${summary.freshness.native.stale}`);
  lines.push(`- daily_note_stale: ${summary.freshness.native.daily_note_stale}`);
  lines.push(`- vault_stale: ${summary.freshness.vault.stale}`);
  lines.push(`- manual_folder_protection_ok: ${summary.freshness.manual_protection.ok}`);
  lines.push('');
  lines.push('## Views');
  lines.push('');
  lines.push(`- ${wikiLink('30 Views/Current State.md')}`);
  lines.push(`- ${wikiLink('30 Views/What Changed.md')}`);
  lines.push(`- ${wikiLink('30 Views/Important People.md')}`);
  lines.push(`- ${wikiLink('30 Views/Important Projects.md')}`);
  lines.push(`- ${wikiLink('30 Views/Native Notes.md')}`);
  lines.push(`- ${wikiLink('50 Briefings/Session Brief.md')}`);
  if (exportDiagnostics) {
    lines.push(`- ${wikiLink('30 Views/Active Memories.md')}`);
    lines.push(`- ${wikiLink('30 Views/Current Beliefs.md')}`);
    lines.push(`- ${wikiLink('30 Views/Recent Archives.md')}`);
    lines.push(`- ${wikiLink('30 Views/Relationships.md')}`);
    lines.push(`- ${wikiLink('40 Reviews/Internal Diagnostics.md')}`);
  }
  lines.push('');
  lines.push('## Reports');
  lines.push('');
  lines.push(`- ${wikiLink('40 Reports/vault-build-summary.md')}`);
  lines.push(`- ${wikiLink('40 Reports/vault-freshness.json', 'vault-freshness')}`);
  lines.push(`- ${wikiLink('40 Reports/vault-manifest.json', 'vault-manifest')}`);
  if (summary.reports.latest_nightly.note_path) {
    lines.push(`- ${wikiLink(summary.reports.latest_nightly.note_path, 'latest nightly execution')}`);
  }
  if (summary.reports.latest_native_sync.note_path) {
    lines.push(`- ${wikiLink(summary.reports.latest_native_sync.note_path, 'latest native sync')}`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
};

const renderVaultIndex = (summary) => {
  const lines = [];
  lines.push('# Gigabrain Vault Index');
  lines.push('');
  lines.push(`- updated_at: ${summary.generated_at}`);
  lines.push(`- landing_note: ${wikiLink(summary.paths.home_note)}`);
  lines.push(`- active_nodes: ${summary.active_nodes}`);
  lines.push(`- generated_files: ${summary.manifest.generated_files.length}`);
  lines.push('');
  lines.push(`Open ${wikiLink(summary.paths.home_note)} to start.`);
  lines.push('');
  return `${lines.join('\n')}\n`;
};

const renderListView = ({ title, intro = [], sections = [] }) => {
  const lines = [`# ${title}`, ''];
  for (const line of intro) lines.push(line);
  if (intro.length > 0) lines.push('');
  for (const section of sections) {
    lines.push(`## ${section.heading}`);
    lines.push('');
    if (section.lines.length === 0) {
      lines.push('- none');
    } else {
      lines.push(...section.lines);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
};

const renderVaultBuildMarkdown = ({ timestamp, runId, summary }) => {
  const lines = [];
  lines.push('# Vault Build Report');
  lines.push('');
  lines.push(`- timestamp: ${timestamp}`);
  lines.push(`- run_id: \`${runId}\``);
  lines.push(`- enabled: ${summary?.enabled === true}`);
  lines.push(`- vault_root: ${summary?.vault_root || ''}`);
  lines.push(`- subdir: ${summary?.subdir || ''}`);
  lines.push(`- source_files: ${Number(summary?.source_files || 0)}`);
  lines.push(`- active_nodes: ${Number(summary?.active_nodes || 0)}`);
  lines.push(`- copied_files: ${Number(summary?.copied_files || 0)}`);
  lines.push(`- skipped_unchanged: ${Number(summary?.skipped_unchanged || 0)}`);
  lines.push(`- removed_files: ${Number(summary?.removed_files || 0)}`);
  lines.push(`- review_queue: ${Number(summary?.review_queue?.total || 0)}`);
  lines.push(`- recent_archives: ${Number(summary?.recent_archives?.count || 0)}`);
  lines.push('');
  lines.push('## Freshness');
  lines.push('');
  lines.push(`- native_last_seen: ${summary?.freshness?.native?.last_source_at || 'none'}`);
  lines.push(`- daily_note_last_seen: ${summary?.freshness?.native?.last_daily_note_at || 'none'}`);
  lines.push(`- vault_last_built_at: ${summary?.freshness?.vault?.last_built_at || timestamp}`);
  lines.push(`- native_stale: ${summary?.freshness?.native?.stale === true}`);
  lines.push(`- daily_note_stale: ${summary?.freshness?.native?.daily_note_stale === true}`);
  lines.push(`- vault_stale: ${summary?.freshness?.vault?.stale === true}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
};

const renderVaultDoctorMarkdown = ({ health }) => {
  const lines = [];
  lines.push('# Vault Doctor');
  lines.push('');
  lines.push(`- enabled: ${health.enabled}`);
  lines.push(`- vault_root: ${health.vault_root || ''}`);
  lines.push(`- mirror_root: ${health.mirror_root || ''}`);
  lines.push(`- last_native_source_at: ${health.native.last_source_at || 'none'}`);
  lines.push(`- last_daily_note_at: ${health.native.last_daily_note_at || 'none'}`);
  lines.push(`- last_vault_build_at: ${health.vault.last_built_at || 'none'}`);
  lines.push(`- native_stale: ${health.native.stale}`);
  lines.push(`- daily_note_stale: ${health.native.daily_note_stale}`);
  lines.push(`- vault_stale: ${health.vault.stale}`);
  lines.push(`- manual_folder_protection_ok: ${health.manual_protection.ok}`);
  lines.push('');
  if (health.manual_protection.issues.length > 0) {
    lines.push('## Manual Folder Issues');
    lines.push('');
    for (const issue of health.manual_protection.issues) lines.push(`- ${issue}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
};

const createWriterState = ({ mirrorRoot, dryRun }) => ({
  mirrorRoot,
  dryRun,
  copied: 0,
  skipped: 0,
  removed: 0,
  generatedFiles: new Set(),
});

const registerGenerated = (state, relPath) => {
  state.generatedFiles.add(toPosix(relPath));
};

const writeManagedText = (state, relPath, content) => {
  const normalized = toPosix(relPath);
  registerGenerated(state, normalized);
  if (state.dryRun) {
    state.copied += 1;
    return;
  }
  const targetPath = path.join(state.mirrorRoot, normalized);
  ensureFileDir(targetPath);
  const previous = readUtf8IfExists(targetPath);
  if (previous === content) {
    state.skipped += 1;
    return;
  }
  fs.writeFileSync(targetPath, content, 'utf8');
  state.copied += 1;
};

const copyManagedFile = (state, relPath, sourcePath) => {
  const normalized = toPosix(relPath);
  registerGenerated(state, normalized);
  if (state.dryRun) {
    state.copied += 1;
    return;
  }
  const targetPath = path.join(state.mirrorRoot, normalized);
  ensureFileDir(targetPath);
  if (sameFileContent(sourcePath, targetPath)) {
    state.skipped += 1;
    return;
  }
  fs.copyFileSync(sourcePath, targetPath);
  state.copied += 1;
};

const removeStaleManagedFiles = ({ state, manualFolders }) => {
  if (state.dryRun || !fs.existsSync(state.mirrorRoot)) return;
  const keep = new Set(state.generatedFiles);
  for (const filePath of listFilesRecursively(state.mirrorRoot)) {
    const relPath = toPosix(path.relative(state.mirrorRoot, filePath));
    if (!relPath || relPath.startsWith('../')) continue;
    if (isVaultProtectedPath(relPath)) continue;
    if (isManualPath(relPath, manualFolders)) continue;
    if (!isManagedGeneratedPath(relPath)) continue;
    if (keep.has(relPath)) continue;
    fs.unlinkSync(filePath);
    state.removed += 1;
  }
  for (const dirPath of listDirsDeepestFirst(state.mirrorRoot)) {
    const relPath = toPosix(path.relative(state.mirrorRoot, dirPath));
    if (!relPath || relPath.startsWith('../')) continue;
    if (isVaultProtectedPath(relPath)) continue;
    if (isManualPath(relPath, manualFolders)) continue;
    if (!isManagedGeneratedPath(relPath)) continue;
    if (fs.readdirSync(dirPath).length === 0) fs.rmdirSync(dirPath);
  }
};

const queryStatusCounts = (db) => tableStats(db).status || {};

const queryBreakdown = (db, column) => {
  const rows = db.prepare(`
    SELECT ${column} AS value, COUNT(*) AS c
    FROM memory_current
    WHERE status = 'active'
    GROUP BY ${column}
    ORDER BY c DESC, value ASC
  `).all();
  const out = [];
  for (const row of rows) {
    out.push({
      value: String(row.value || ''),
      count: Number(row.c || 0),
    });
  }
  return out;
};

const queryEntityMentions = (db) => db.prepare(`
  SELECT memory_id, entity_key
  FROM memory_entity_mentions
  WHERE source = 'memory_current'
  ORDER BY entity_key ASC, memory_id ASC
`).all();

const queryLinkedSources = (db) => db.prepare(`
  SELECT
    linked_memory_id,
    source_path,
    source_kind,
    MIN(line_start) AS first_line,
    COUNT(*) AS chunk_count
  FROM memory_native_chunks
  WHERE status = 'active'
    AND linked_memory_id IS NOT NULL
  GROUP BY linked_memory_id, source_path, source_kind
  ORDER BY linked_memory_id ASC, source_path ASC
`).all();

const queryNativeSourceRows = (db) => db.prepare(`
  SELECT
    source_path,
    source_kind,
    source_date,
    COUNT(*) AS active_chunks,
    MAX(last_seen_at) AS last_seen_at
  FROM memory_native_chunks
  WHERE status = 'active'
  GROUP BY source_path, source_kind, source_date
  ORDER BY source_path ASC
`).all();

const normalizeMemoryRow = (row) => ({
  ...row,
  id: String(row.memory_id || row.id || ''),
  confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : 0,
  quality_score: Number.isFinite(Number(row.value_score)) ? Number(row.value_score) : null,
  tags: parseJsonArray(row.tags),
});

const collectNativeSources = ({ db, config, workspaceRoot }) => {
  const candidatePaths = resolveNativeSourcePaths(config);
  const rows = queryNativeSourceRows(db);
  const rowByPath = new Map(rows.map((row) => [String(row.source_path || ''), row]));
  const items = [];
  for (const sourcePath of candidatePaths) {
    const stat = fs.existsSync(sourcePath) ? fs.statSync(sourcePath) : null;
    const row = rowByPath.get(String(sourcePath)) || {};
    const workspaceRelPath = toPosix(path.relative(workspaceRoot, sourcePath));
    items.push({
      source_path: workspaceRelPath,
      source_kind: String(row.source_kind || '').trim() || (workspaceRelPath === 'MEMORY.md' ? 'memory_md' : 'daily_note'),
      source_date: String(row.source_date || '').trim() || null,
      active_chunks: Number(row.active_chunks || 0),
      last_seen_at: String(row.last_seen_at || '').trim() || null,
      mtime_at: stat ? new Date(stat.mtimeMs).toISOString() : null,
      note_path: nativeNotePath(workspaceRelPath),
    });
  }
  const lastSource = latestEntry(items, (item) => Date.parse(String(item.mtime_at || '')) || 0);
  const lastDaily = latestEntry(
    items.filter((item) => item.source_kind === 'daily_note'),
    (item) => Date.parse(String(item.mtime_at || '')) || 0,
  );
  return {
    total: items.length,
    items,
    last_source_at: lastSource?.mtime_at || null,
    last_daily_note_at: lastDaily?.mtime_at || null,
  };
};

const collectActiveNodes = ({ db, config, workspaceRoot }) => {
  const activeRows = listCurrentMemories(db, { statuses: ['active'], limit: 10000 })
    .map(normalizeMemoryRow)
    .filter((row) => {
      const tier = String(row.memory_tier || '').trim()
        || resolveMemoryTier({ row, entityKeys: [] });
      return isDurableMemoryTier(tier);
    });
  const activeIds = new Set(activeRows.map((row) => row.id));
  const entityRows = queryEntityMentions(db);
  const linkedSourceRows = queryLinkedSources(db);

  const entitiesByMemory = new Map();
  const memoriesByEntity = new Map();
  for (const row of entityRows) {
    const memoryId = String(row.memory_id || '');
    const entityKey = String(row.entity_key || '').trim();
    if (!activeIds.has(memoryId) || !entityKey) continue;
    const list = entitiesByMemory.get(memoryId) || new Set();
    list.add(entityKey);
    entitiesByMemory.set(memoryId, list);
    const memories = memoriesByEntity.get(entityKey) || new Set();
    memories.add(memoryId);
    memoriesByEntity.set(entityKey, memories);
  }

  const sourcesByMemory = new Map();
  for (const row of linkedSourceRows) {
    const memoryId = String(row.linked_memory_id || '');
    if (!activeIds.has(memoryId)) continue;
    const list = sourcesByMemory.get(memoryId) || [];
    const sourcePath = String(row.source_path || '');
    const relPath = toPosix(path.relative(workspaceRoot, sourcePath));
    list.push({
      source_path: relPath,
      source_kind: String(row.source_kind || ''),
      source_line: Number(row.first_line || 0) || null,
      chunk_count: Number(row.chunk_count || 0),
      note_path: nativeNotePath(relPath),
      label: relPath,
    });
    sourcesByMemory.set(memoryId, list);
  }

  const rowsById = new Map(activeRows.map((row) => [row.id, row]));
  const out = [];
  for (const row of activeRows) {
    const entities = Array.from(entitiesByMemory.get(row.id) || []).sort();
    const related = new Set();
    for (const entity of entities) {
      const ids = memoriesByEntity.get(entity) || new Set();
      for (const otherId of ids) {
        if (otherId !== row.id) related.add(otherId);
      }
    }
    const relatedLinks = Array.from(related)
      .map((memoryId) => rowsById.get(memoryId))
      .filter(Boolean)
      .sort((a, b) => Date.parse(String(b.updated_at || '')) - Date.parse(String(a.updated_at || '')))
      .slice(0, 8)
      .map((other) => ({
        id: other.id,
        note_path: toPosix(path.join('20 Nodes', 'active', other.type || 'CONTEXT', `${safeFileName(other.id)}.md`)),
        label: `${other.type} · ${other.content.slice(0, 72)}`,
      }));
    const sourceLinks = (sourcesByMemory.get(row.id) || []).slice(0, 8);
    const rawSourcePath = String(row.source_path || '').trim();
    const rawSourceLayer = String(row.source_layer || '').trim();
    const sourceRelPath = rawSourcePath
      ? toPosix(path.relative(workspaceRoot, rawSourcePath))
      : '';
    const primarySourceKind = sourceLinks[0]?.source_kind
      || (sourceRelPath === 'MEMORY.md' ? 'memory_md' : sourceRelPath ? 'daily_note' : null);
    const effectiveSourceLayer = sourceLinks.length > 0 && !rawSourcePath && (!rawSourceLayer || rawSourceLayer === 'registry')
      ? 'native'
      : (rawSourceLayer || (sourceLinks.length > 0 ? 'native' : 'registry'));
    out.push({
      ...row,
      reason_codes: row.value_label ? [String(row.value_label)] : [],
      source_layer: effectiveSourceLayer,
      source_kind: primarySourceKind,
      source_path: sourceLinks[0]?.source_path || sourceRelPath || null,
      source_line: sourceLinks[0]?.source_line || (Number(row.source_line || 0) || null),
      source_note_path: sourceRelPath ? nativeNotePath(sourceRelPath) : '',
      matched_memory_id: row.superseded_by || null,
      linked_entities: entities,
      linked_nodes: relatedLinks.map((item) => item.id),
      source_links: sourceLinks,
      related_links: relatedLinks,
      note_path: toPosix(path.join('20 Nodes', 'active', row.type || 'CONTEXT', `${safeFileName(row.id)}.md`)),
    });
  }
  out.sort((a, b) => Date.parse(String(b.updated_at || '')) - Date.parse(String(a.updated_at || '')));
  return out;
};

const collectWorldModel = ({ db }) => {
  const entities = listEntities(db, { limit: 5000 });
  const entityDetails = entities.map((entity) => {
    const beliefs = listBeliefs(db, { entityId: entity.entity_id, limit: 200 });
    const episodes = listEpisodes(db, { entityId: entity.entity_id, limit: 100 });
    const openLoops = listOpenLoops(db, { entityId: entity.entity_id, limit: 100 });
    const syntheses = listSyntheses(db, { subjectType: 'entity', subjectId: entity.entity_id, limit: 20 });
    const notePath = entityNotePath(entity);
    return {
      ...entity,
      note_path: notePath,
      beliefs,
      episodes,
      open_loops: openLoops,
      syntheses,
    };
  });
  return {
    entities: entityDetails,
    beliefs: listBeliefs(db, { limit: 5000 }),
    episodes: listEpisodes(db, { limit: 5000 }),
    open_loops: listOpenLoops(db, { limit: 5000 }),
    contradictions: listContradictions(db, { limit: 5000 }),
    syntheses: listSyntheses(db, { limit: 5000 }),
  };
};

const renderEntityNote = (entity = {}) => {
  const frontmatter = renderFrontmatter({
    id: entity.entity_id,
    kind: entity.kind,
    status: entity.status,
    confidence: Number.isFinite(Number(entity.confidence)) ? Number(entity.confidence) : 0,
    aliases: Array.isArray(entity.aliases) ? entity.aliases : [],
    belief_count: Array.isArray(entity.beliefs) ? entity.beliefs.length : 0,
    episode_count: Array.isArray(entity.episodes) ? entity.episodes.length : 0,
    open_loop_count: Array.isArray(entity.open_loops) ? entity.open_loops.length : 0,
  });

  const lines = [];
  lines.push(`# ${entity.display_name}`);
  lines.push('');
  lines.push(`- kind: ${entity.kind}`);
  lines.push(`- confidence: ${formatMaybeNumber(entity.confidence)}`);
  if (Array.isArray(entity.aliases) && entity.aliases.length > 0) {
    lines.push(`- aliases: ${entity.aliases.join(', ')}`);
  }
  lines.push('');

  if (entity.syntheses?.[0]?.content) {
    lines.push('## Brief');
    lines.push('');
    lines.push(entity.syntheses[0].content.trim());
    lines.push('');
  }

  lines.push('## Current Beliefs');
  lines.push('');
  const currentBeliefs = selectSurfaceBeliefsForEntity(entity, entity.beliefs || [], 8);
  if (currentBeliefs.length === 0) lines.push('- none');
  for (const belief of currentBeliefs.slice(0, 12)) {
    lines.push(`- ${belief.content}`);
  }
  lines.push('');

  const surfaceEpisodes = (entity.episodes || []).filter((episode) => isDisplaySurfaceEpisode(episode));
  if (surfaceEpisodes.length > 0) {
    lines.push('## Key Episodes');
    lines.push('');
    for (const episode of surfaceEpisodes.slice(0, 10)) {
      const when = String(episode.start_date || episode.end_date || 'undated');
      lines.push(`- ${when}: ${episode.summary || episode.title}`);
    }
    lines.push('');
  }

  return `${frontmatter}${lines.join('\n')}\n`;
};

const isCuratedSurfaceEntity = (entity = {}) => entity?.payload?.surface_curated === true;

const shouldExportEntityPage = (entity = {}, config = {}) => {
  if (config?.surface?.obsidian?.entityPages === false) return false;
  const mode = String(config?.surface?.obsidian?.exportEntityPages || 'stable_only').trim().toLowerCase();
  if (mode === 'off') return false;
  if (mode === 'all_visible') return entity?.payload?.surface_visible !== false;
  return isCuratedSurfaceEntity(entity);
};

const collectReviewQueue = ({ queuePath }) => {
  const rows = readJsonlRows(queuePath, 2000);
  const byReason = {};
  let pending = 0;
  const normalizeReviewItem = (row = {}) => {
    const payload = row && typeof row.payload === 'object' && row.payload ? row.payload : {};
    const isMemoryAction = String(row.action || '').trim() === 'memory_action_review'
      || String(row.reason_code || row.reason || '').trim() === 'memory_action_review';
    const suggestedCommands = Array.isArray(payload.suggested_commands)
      ? payload.suggested_commands.map((value) => String(value || '').trim()).filter(Boolean)
      : [];
    const candidateRows = Array.isArray(payload.candidates) ? payload.candidates : [];
    const content = String(payload.content || payload.excerpt || '').trim();
    const requestedAction = String(payload.requested_action || '').trim();
    return {
      ...row,
      review_kind: isMemoryAction ? 'memory_action' : 'generic',
      requested_action: requestedAction,
      title: isMemoryAction
        ? `${requestedAction || 'memory action'} · ${content || String(payload.target || 'review target').trim()}`
        : `${String(row.reason || row.reason_code || 'review').trim()} · ${content || String(row.memory_id || 'unknown').trim()}`,
      suggested_commands: suggestedCommands,
      candidates: candidateRows,
    };
  };
  for (const row of rows) {
    const reason = String(row.reason || row.reason_code || 'unknown').trim() || 'unknown';
    byReason[reason] = Number(byReason[reason] || 0) + 1;
    if (String(row.status || '').trim().toLowerCase() === 'pending') pending += 1;
  }
  return {
    total: rows.length,
    pending,
    items: rows.slice(0, 50).map((row) => normalizeReviewItem(row)),
    by_reason: byReason,
  };
};

const collectRecentArchives = ({ db, outputDir, limit, outputPaths = {} }) => {
  const latestExecution = resolveLatestNonDryRunExecutionArtifact(outputDir, outputPaths.executionArtifactPath);
  const artifactPath = String(latestExecution?.data?.artifacts?.archived_or_killed_jsonl || '').trim();
  const rowsFromArtifact = readJsonlRows(artifactPath, limit)
    .filter((row) => String(row.after_status || '').toLowerCase() === 'archived');
  if (rowsFromArtifact.length > 0) {
    return {
      source: artifactPath,
      count: rowsFromArtifact.length,
      items: rowsFromArtifact,
    };
  }
  const rows = db.prepare(`
    SELECT memory_id, type, scope, status, archived_at, value_label, superseded_by, content
    FROM memory_current
    WHERE status = 'archived'
    ORDER BY COALESCE(archived_at, updated_at) DESC
    LIMIT ?
  `).all(Math.max(1, Number(limit || 0) || 200));
  return {
    source: '',
    count: rows.length,
    items: rows.map((row) => ({
      memory_id: String(row.memory_id || ''),
      type: String(row.type || ''),
      scope: String(row.scope || ''),
      after_status: 'archived',
      reason_codes: row.value_label ? [String(row.value_label)] : [],
      matched_memory_id: row.superseded_by ? String(row.superseded_by) : null,
      content: String(row.content || ''),
      archived_at: String(row.archived_at || ''),
    })),
  };
};

const collectArtifactRefs = ({ outputDir, outputPaths = {} }) => {
  const latestNightly = resolveLatestNonDryRunExecutionArtifact(outputDir, outputPaths.executionArtifactPath);
  const latestNightlyPath = latestNightly.source_path;
  const latestNativeSyncPath = String(latestNightly?.data?.artifacts?.native_sync_report_path || '').trim()
    || findLatestFileMatching(outputDir, (name) => /^memory-native-sync-.*\.md$/i.test(name));
  return {
    latest_nightly: {
      source_path: latestNightlyPath,
      data: latestNightly.data || {},
      note_path: latestNightlyPath ? '40 Reports/nightly-execution-latest.json' : '',
    },
    latest_native_sync: {
      source_path: latestNativeSyncPath,
      note_path: latestNativeSyncPath ? '40 Reports/native-sync-latest.md' : '',
    },
  };
};

const collectSurfaceSummary = ({ db, config, runId, outputPaths = {} }) => {
  const workspaceRoot = String(config?.runtime?.paths?.workspaceRoot || process.cwd());
  const outputDir = String(config?.runtime?.paths?.outputDir || path.join(workspaceRoot, 'output'));
  const { vaultRoot, subdir, mirrorRoot } = resolveMirrorRoot(config);
  const nativeSources = collectNativeSources({ db, config, workspaceRoot });
  const activeNodes = collectActiveNodes({ db, config, workspaceRoot });
  const worldModel = collectWorldModel({ db });
  const reviewQueue = collectReviewQueue({ queuePath: config?.runtime?.paths?.reviewQueuePath });
  const recentArchives = collectRecentArchives({
    db,
    outputDir,
    limit: Number(config?.vault?.exportRecentArchivesLimit || 200),
    outputPaths,
  });
  const reports = collectArtifactRefs({ outputDir, outputPaths });
  const statusCounts = queryStatusCounts(db);
  const typeCounts = queryBreakdown(db, 'type');
  const scopeCounts = queryBreakdown(db, 'scope');
  const sourceLayerCounts = activeNodes.reduce((acc, node) => {
    const key = String(node.source_layer || 'registry');
    acc[key] = Number(acc[key] || 0) + 1;
    return acc;
  }, {});

  const nativeLastMs = Date.parse(String(nativeSources.last_source_at || '')) || 0;
  const dailyLastMs = Date.parse(String(nativeSources.last_daily_note_at || '')) || 0;
  const buildMs = Date.now();

  return {
    enabled: config?.vault?.enabled === true,
    generated_at: new Date().toISOString(),
    run_id: runId,
    workspace_root: workspaceRoot,
    output_dir: outputDir,
    vault_root: vaultRoot,
    subdir,
    mirror_root: mirrorRoot,
    source_files: nativeSources.total,
    active_nodes: activeNodes.length,
    entities: worldModel.entities.length,
    counts: {
      by_status: statusCounts,
      by_type: typeCounts,
      by_scope: scopeCounts,
      by_source_layer: sourceLayerCounts,
    },
    native_sources: nativeSources,
    nodes: activeNodes,
    world_model: worldModel,
    review_queue: reviewQueue,
    recent_archives: recentArchives,
    reports,
    surface: {
      obsidian_mode: String(config?.surface?.obsidian?.mode || 'curated').trim().toLowerCase() || 'curated',
      export_diagnostics: config?.surface?.obsidian?.exportDiagnostics === true,
      export_entity_pages: String(config?.surface?.obsidian?.exportEntityPages || 'stable_only').trim().toLowerCase() || 'stable_only',
    },
    paths: {
      home_note: homeNotePath(config?.vault?.homeNoteName || 'Home'),
    },
    freshness: {
      native: {
        last_source_at: nativeSources.last_source_at,
        last_daily_note_at: nativeSources.last_daily_note_at,
        stale: nativeLastMs > 0 ? (Date.now() - nativeLastMs) > daysToMs(STALE_WINDOWS_DAYS.native) : true,
        daily_note_stale: dailyLastMs > 0 ? (Date.now() - dailyLastMs) > daysToMs(STALE_WINDOWS_DAYS.daily) : true,
      },
      vault: {
        last_built_at: new Date(buildMs).toISOString(),
        stale: false,
      },
      manual_protection: {
        ok: true,
        issues: [],
      },
    },
    manifest: {
      generated_files: [],
    },
  };
};

const buildViewFiles = ({ summary, config, db }) => {
  if (config?.vault?.views?.enabled === false) return [];

  const files = [];
  const activeNodes = summary.nodes;
  const entities = Array.isArray(summary.world_model?.entities) ? summary.world_model.entities : [];
  const beliefs = Array.isArray(summary.world_model?.beliefs) ? summary.world_model.beliefs : [];
  const openLoops = Array.isArray(summary.world_model?.open_loops) ? summary.world_model.open_loops : [];
  const contradictions = Array.isArray(summary.world_model?.contradictions) ? summary.world_model.contradictions : [];
  const syntheses = Array.isArray(summary.world_model?.syntheses) ? summary.world_model.syntheses : [];
  const mode = String(config?.surface?.obsidian?.mode || 'curated').trim().toLowerCase();
  const exportDiagnostics = config?.surface?.obsidian?.exportDiagnostics === true || mode === 'diagnostic';
  const currentState = syntheses.find((row) => row.kind === 'current_state');
  const sessionBrief = syntheses.find((row) => row.kind === 'session_brief');
  const whatChanged = syntheses.find((row) => row.kind === 'what_changed');
  const surfacedPeople = entities
    .filter((entity) => entity.kind === 'person' && isCuratedSurfaceEntity(entity))
    .filter((entity) => Boolean(pickSurfaceSummaryBelief(
      entity,
      beliefs.filter((belief) => belief.entity_id === entity.entity_id),
    )))
    .sort((a, b) => Number(b.payload?.surface_priority || 0) - Number(a.payload?.surface_priority || 0) || Number(b.confidence || 0) - Number(a.confidence || 0));
  const surfacedProjects = entities
    .filter((entity) => ['project', 'organization'].includes(String(entity.kind || '')) && isCuratedSurfaceEntity(entity))
    .filter((entity) => Boolean(pickSurfaceSummaryBelief(
      entity,
      beliefs.filter((belief) => belief.entity_id === entity.entity_id),
    )))
    .sort((a, b) => Number(b.payload?.surface_priority || 0) - Number(a.payload?.surface_priority || 0) || Number(b.confidence || 0) - Number(a.confidence || 0));

  files.push({
    relPath: '30 Views/Current State.md',
    content: currentState
      ? `# Current State\n\n${currentState.content.trim()}\n`
      : '# Current State\n\n- No current state briefing is available yet.\n',
  });

  files.push({
    relPath: '30 Views/What Changed.md',
    content: whatChanged
      ? `# What Changed\n\n${whatChanged.content.trim()}\n`
      : '# What Changed\n\n- none\n',
  });

  files.push({
    relPath: '30 Views/Important People.md',
    content: renderListView({
      title: 'Important People',
      intro: [
        `- generated_at: ${summary.generated_at}`,
        '- only stable, surfaced entities are shown here',
      ],
      sections: [
        {
          heading: 'People',
          lines: surfacedPeople.map((entity) => {
            const currentBelief = pickSurfaceSummaryBelief(
              entity,
              beliefs.filter((belief) => belief.entity_id === entity.entity_id),
            );
            const suffix = currentBelief ? ` · ${currentBelief.content}` : '';
            return `- ${wikiLink(entity.note_path, entity.display_name)}${suffix}`;
          }),
        },
      ],
    }),
  });

  files.push({
    relPath: '30 Views/Important Projects.md',
    content: renderListView({
      title: 'Important Projects',
      intro: [
        `- generated_at: ${summary.generated_at}`,
        '- stable projects and organizations with strong evidence',
      ],
      sections: [
        {
          heading: 'Projects and Organizations',
          lines: surfacedProjects.map((entity) => {
            const currentBelief = pickSurfaceSummaryBelief(
              entity,
              beliefs.filter((belief) => belief.entity_id === entity.entity_id),
            );
            const suffix = currentBelief ? ` · ${currentBelief.content}` : '';
            return `- ${wikiLink(entity.note_path, `${entity.display_name} (${entity.kind})`)}${suffix}`;
          }),
        },
      ],
    }),
  });

  files.push({
    relPath: '30 Views/Native Notes.md',
    content: renderListView({
      title: 'Native Notes',
      intro: [
        `- source_files: ${summary.native_sources.total}`,
        `- last_source_at: ${summary.native_sources.last_source_at || 'none'}`,
        `- last_daily_note_at: ${summary.native_sources.last_daily_note_at || 'none'}`,
      ],
      sections: [
        {
          heading: 'Sources',
          lines: summary.native_sources.items.map((item) => (
            `- ${wikiLink(item.note_path, `${item.source_kind} · ${item.source_path}`)} (chunks: ${item.active_chunks})`
          )),
        },
      ],
    }),
  });

  if (sessionBrief) {
    files.push({
      relPath: '50 Briefings/Session Brief.md',
      content: `# Session Brief\n\n${sessionBrief.content.trim()}\n`,
    });
  }

  if (exportDiagnostics) {
    files.push({
      relPath: '30 Views/Active Memories.md',
      content: renderListView({
        title: 'Active Memories',
        intro: [
          `- active_nodes: ${summary.active_nodes}`,
          `- generated_at: ${summary.generated_at}`,
        ],
        sections: [
          {
            heading: 'Live Registry',
            lines: activeNodes.map((node) => (
              `- ${wikiLink(node.note_path, `${node.type} · ${node.content.slice(0, 96)}`)}`
            )),
          },
        ],
      }),
    });

    files.push({
      relPath: '30 Views/Current Beliefs.md',
      content: renderListView({
        title: 'Current Beliefs',
        intro: [`- total: ${beliefs.filter((belief) => belief.status === 'current').length}`],
        sections: [
          {
            heading: 'Live Beliefs',
            lines: beliefs
              .filter((belief) => belief.status === 'current')
              .slice(0, 200)
              .map((belief) => {
                const entity = entities.find((item) => item.entity_id === belief.entity_id);
                const prefix = entity ? `${wikiLink(entity.note_path, entity.display_name)} · ` : '';
                return `- ${prefix}${belief.content}`;
              }),
          },
        ],
      }),
    });

    files.push({
      relPath: '30 Views/Recent Archives.md',
      content: renderListView({
        title: 'Recent Archives',
        intro: [
          `- rows: ${summary.recent_archives.count}`,
          `- source: ${summary.recent_archives.source || 'db'}`,
        ],
        sections: [
          {
            heading: 'Latest Archived Memories',
            lines: summary.recent_archives.items.map((row) => `- ${String(row.archived_at || '').trim() || 'recent'} · ${String(row.type || '')} · ${String(row.content || '').slice(0, 96)}`),
          },
        ],
      }),
    });

    // Phase 5A: Entity Relationships view (co-occurrence pairs)
    if (db) {
      try {
        const relationships = listRelationships(db, { limit: 500, minEvidence: 1 });
        const entityMap = new Map(entities.map((e) => [e.entity_id, e]));
        const relLines = relationships.map((rel) => {
          const entityA = entityMap.get(rel.entity_id_a);
          const entityB = entityMap.get(rel.entity_id_b);
          const nameA = entityA?.display_name || rel.entity_id_a;
          const nameB = entityB?.display_name || rel.entity_id_b;
          return `| ${nameA} | ${nameB} | ${rel.evidence_count} | ${Number(rel.confidence || 0).toFixed(2)} |`;
        });
        const tableHeader = relLines.length > 0
          ? ['| Entity A | Entity B | Shared Evidence | Confidence |', '| --- | --- | --- | --- |', ...relLines].join('\n')
          : '- No entity relationships found yet.';
        files.push({
          relPath: '30 Views/Relationships.md',
          content: `# Entity Relationships\n\n- generated_at: ${summary.generated_at}\n- total: ${relationships.length}\n\n## Co-occurrence Relationships\n\n${tableHeader}\n`,
        });
      } catch {
        files.push({
          relPath: '30 Views/Relationships.md',
          content: '# Entity Relationships\n\n- No relationship data available.\n',
        });
      }
    }

    // Build contradiction resolution suggestions if db is available
    const contradictionSuggestions = db ? (() => {
      try {
        const suggestions = suggestContradictionResolution(db, { limit: 200 });
        const byLoopId = new Map(suggestions.map((s) => [s.loop_id, s]));
        return byLoopId;
      } catch { return new Map(); }
    })() : new Map();

    files.push({
      relPath: '40 Reviews/Internal Diagnostics.md',
      content: renderListView({
        title: 'Internal Diagnostics',
        intro: [
          `- contradictions: ${contradictions.length}`,
          `- open_loops: ${openLoops.length}`,
          `- review_queue: ${summary.review_queue.total}`,
        ],
        sections: [
          {
            heading: 'Contradictions',
            lines: contradictions.flatMap((loop) => {
              const lines = [`- ${loop.title}`];
              const suggestion = contradictionSuggestions.get(loop.loop_id);
              if (suggestion?.suggested_resolution) {
                const res = suggestion.suggested_resolution;
                lines.push(`  - Suggested resolution: keep **${String(res.winner?.content || '').slice(0, 80)}** (${res.reason}, confidence delta: ${res.confidence_delta.toFixed(2)})`);
              }
              return lines;
            }),
          },
          {
            heading: 'Open Loops',
            lines: openLoops.map((loop) => `- [${loop.kind}] ${loop.title}`),
          },
        ],
      }),
    });
  }

  return files;
};

const ensureManualFolders = ({ mirrorRoot, manualFolders, dryRun }) => {
  if (dryRun) return;
  ensureDir(mirrorRoot);
  for (const folder of manualFolders) {
    ensureDir(path.join(mirrorRoot, folder));
  }
};

const writeSurfaceSummaryArtifact = ({ summary, outputDir, dryRun }) => {
  if (dryRun) return '';
  const filePath = path.join(outputDir, 'memory-surface-summary.json');
  ensureFileDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  return filePath;
};

const buildVaultSurface = ({
  db,
  dbPath = '',
  config,
  dryRun = false,
  runId = '',
  outputPaths = {},
} = {}) => {
  const vaultEnabled = config?.vault?.enabled === true;
  const { vaultRoot, subdir, mirrorRoot } = resolveMirrorRoot(config);
  const workspaceRoot = String(config?.runtime?.paths?.workspaceRoot || process.cwd());
  const outputDir = String(config?.runtime?.paths?.outputDir || path.join(workspaceRoot, 'output'));
  const manualFolders = Array.isArray(config?.vault?.manualFolders) ? config.vault.manualFolders : ['Inbox', 'Manual'];
  const summaryBase = {
    enabled: vaultEnabled,
    vault_root: vaultRoot,
    subdir,
    source_files: 0,
    active_nodes: 0,
    entities: 0,
    copied_files: 0,
    skipped_unchanged: 0,
    removed_files: 0,
    native_sources: { total: 0, items: [] },
    world_model: {
      entities: [],
      beliefs: [],
      episodes: [],
      open_loops: [],
      contradictions: [],
      syntheses: [],
    },
    review_queue: { total: 0, pending: 0, items: [] },
    recent_archives: { count: 0, items: [] },
    counts: {
      by_status: {},
      by_type: [],
      by_scope: [],
      by_source_layer: {},
    },
    freshness: {
      native: {
        last_source_at: null,
        last_daily_note_at: null,
        stale: true,
        daily_note_stale: true,
      },
      vault: {
        last_built_at: null,
        stale: true,
      },
      manual_protection: {
        ok: true,
        issues: [],
      },
    },
    reports: {
      latest_nightly: { source_path: '', note_path: '' },
      latest_native_sync: { source_path: '', note_path: '' },
    },
    manifest: {
      generated_files: [],
    },
  };

  if (!vaultEnabled || !vaultRoot) {
    return summaryBase;
  }

  const context = openContextDb({ db, dbPath, config });
  try {
    const summary = collectSurfaceSummary({
      db: context.db,
      config,
      runId: String(runId || `vault-build-${new Date().toISOString().replace(/[:.]/g, '-')}`),
      outputPaths,
    });
    const writer = createWriterState({ mirrorRoot, dryRun });
    ensureManualFolders({ mirrorRoot, manualFolders, dryRun });

    for (const sourcePath of resolveNativeSourcePaths(config)) {
      const workspaceRelPath = toPosix(path.relative(workspaceRoot, sourcePath));
      if (!workspaceRelPath || workspaceRelPath.startsWith('../')) continue;
      copyManagedFile(writer, nativeNotePath(workspaceRelPath), sourcePath);
    }

    writeManagedText(writer, summary.paths.home_note, renderHomeNote(summary));
    writeManagedText(writer, 'vault-index.md', renderVaultIndex(summary));

    if (config?.vault?.exportActiveNodes !== false) {
      for (const node of summary.nodes) {
        writeManagedText(writer, node.note_path, renderNodeNote(node));
      }
    }

    if (config?.surface?.obsidian?.entityPages !== false && config?.surface?.obsidian?.exportEntityPages !== 'off') {
      for (const entity of summary.world_model?.entities || []) {
        if (!shouldExportEntityPage(entity, config)) continue;
        writeManagedText(writer, entity.note_path, renderEntityNote(entity));
      }
    }

    for (const viewFile of buildViewFiles({ summary, config, db: context.db })) {
      writeManagedText(writer, viewFile.relPath, viewFile.content);
    }

    if (config?.vault?.reports?.enabled !== false) {
      const plannedReportFiles = [
        '40 Reports/vault-build-summary.md',
        '40 Reports/vault-build-summary.json',
        '40 Reports/vault-manifest.json',
        '40 Reports/vault-freshness.json',
        '40 Reports/surface-summary.json',
      ];
      const exportDiagnostics = config?.surface?.obsidian?.exportDiagnostics === true
        || String(config?.surface?.obsidian?.mode || 'curated').trim().toLowerCase() === 'diagnostic';
      if (exportDiagnostics) {
        plannedReportFiles.push(
          '40 Reviews/Internal Diagnostics.md',
          '60 Reports/open-loops-report.md',
          '60 Reports/contradiction-report.md',
        );
      }
      if (summary.world_model?.syntheses?.some((row) => row.kind === 'session_brief')) plannedReportFiles.push('50 Briefings/Session Brief.md');
      if (summary.reports.latest_nightly.note_path) plannedReportFiles.push(summary.reports.latest_nightly.note_path);
      if (summary.reports.latest_native_sync.note_path) plannedReportFiles.push(summary.reports.latest_native_sync.note_path);
      for (const relPath of plannedReportFiles) registerGenerated(writer, relPath);
    }

    if (config?.vault?.clean !== false) {
      removeStaleManagedFiles({ state: writer, manualFolders });
    }

    if (config?.vault?.reports?.enabled !== false) {
      if (summary.reports.latest_nightly.source_path && fs.existsSync(summary.reports.latest_nightly.source_path)) {
        copyManagedFile(writer, summary.reports.latest_nightly.note_path, summary.reports.latest_nightly.source_path);
      }
      if (summary.reports.latest_native_sync.source_path && fs.existsSync(summary.reports.latest_native_sync.source_path)) {
        copyManagedFile(writer, summary.reports.latest_native_sync.note_path, summary.reports.latest_native_sync.source_path);
      }
    }

    const manualIssues = [];
    for (const folder of manualFolders) {
      const fullPath = path.join(mirrorRoot, folder);
      if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isDirectory()) {
        manualIssues.push(`missing manual folder: ${folder}`);
      }
    }

    summary.freshness.manual_protection = {
      ok: manualIssues.length === 0,
      issues: manualIssues,
    };
    summary.freshness.vault = {
      last_built_at: summary.generated_at,
      stale: false,
    };

    summary.manifest = {
      generated_at: summary.generated_at,
      vault_root: vaultRoot,
      mirror_root: mirrorRoot,
      generated_files: Array.from(writer.generatedFiles).sort(),
      manual_folders: [...manualFolders],
      source_files: summary.source_files,
      active_nodes: summary.active_nodes,
    };

    const freshness = {
      generated_at: summary.generated_at,
      native: summary.freshness.native,
      vault: summary.freshness.vault,
      manual_protection: summary.freshness.manual_protection,
    };
    summary.surface_summary_path = dryRun ? '' : path.join(outputDir, 'memory-surface-summary.json');

    const buildReportMarkdown = renderVaultBuildMarkdown({
      timestamp: summary.generated_at,
      runId: summary.run_id,
      summary,
    });

    if (config?.vault?.reports?.enabled !== false) {
      const exportDiagnostics = config?.surface?.obsidian?.exportDiagnostics === true
        || String(config?.surface?.obsidian?.mode || 'curated').trim().toLowerCase() === 'diagnostic';
      const openLoopsReport = summary.world_model?.syntheses?.find((row) => row.kind === 'open_loops_report');
      const contradictionReport = summary.world_model?.syntheses?.find((row) => row.kind === 'contradiction_report');
      if (exportDiagnostics) {
        const diagnosticLines = ['# Internal Diagnostics', ''];
        diagnosticLines.push(`- contradictions: ${Array.isArray(summary.world_model?.contradictions) ? summary.world_model.contradictions.length : 0}`);
        diagnosticLines.push(`- open_loops: ${Array.isArray(summary.world_model?.open_loops) ? summary.world_model.open_loops.length : 0}`);
        diagnosticLines.push(`- review_queue: ${Number(summary.review_queue?.total || 0)}`);
        diagnosticLines.push('');
        if (openLoopsReport?.content) {
          writeManagedText(writer, '60 Reports/open-loops-report.md', `# Open Loops Report\n\n${openLoopsReport.content.trim()}\n`);
        }
        if (contradictionReport?.content) {
          writeManagedText(writer, '60 Reports/contradiction-report.md', `# Contradiction Report\n\n${contradictionReport.content.trim()}\n`);
        }
        writeManagedText(writer, '40 Reviews/Internal Diagnostics.md', `${diagnosticLines.join('\n')}\n`);
      }
      writeManagedText(writer, '40 Reports/vault-build-summary.md', buildReportMarkdown);
      writeManagedText(writer, '40 Reports/vault-build-summary.json', `${JSON.stringify(summary, null, 2)}\n`);
      writeManagedText(writer, '40 Reports/vault-manifest.json', `${JSON.stringify(summary.manifest, null, 2)}\n`);
      writeManagedText(writer, '40 Reports/vault-freshness.json', `${JSON.stringify(freshness, null, 2)}\n`);
      writeManagedText(writer, '40 Reports/surface-summary.json', `${JSON.stringify(summary, null, 2)}\n`);
    }

    const outputSummaryPath = writeSurfaceSummaryArtifact({ summary, outputDir, dryRun });

    return {
      ...summary,
      copied_files: writer.copied,
      skipped_unchanged: writer.skipped,
      removed_files: writer.removed,
      surface_summary_path: outputSummaryPath,
      manifest_path: config?.vault?.reports?.enabled !== false
        ? path.join(mirrorRoot, '40 Reports', 'vault-manifest.json')
        : '',
      freshness_path: config?.vault?.reports?.enabled !== false
        ? path.join(mirrorRoot, '40 Reports', 'vault-freshness.json')
        : '',
      build_report_path: config?.vault?.reports?.enabled !== false
        ? path.join(mirrorRoot, '40 Reports', 'vault-build-summary.md')
        : '',
      manifest: {
        ...summary.manifest,
        generated_files: Array.from(writer.generatedFiles).sort(),
      },
    };
  } finally {
    if (context.close) context.db.close();
  }
};

const loadSurfaceSummary = ({ config } = {}) => {
  const workspaceRoot = String(config?.runtime?.paths?.workspaceRoot || process.cwd());
  const outputDir = String(config?.runtime?.paths?.outputDir || path.join(workspaceRoot, 'output'));
  const filePath = path.join(outputDir, 'memory-surface-summary.json');
  return {
    filePath,
    summary: readJsonIfExists(filePath, null),
  };
};

const inspectVaultHealth = ({
  config,
  db,
  dbPath = '',
} = {}) => {
  const loaded = loadSurfaceSummary({ config });
  const existing = loaded.summary;
  if (existing) {
    const { mirrorRoot, vaultRoot } = resolveMirrorRoot(config);
    const manualFolders = Array.isArray(config?.vault?.manualFolders) ? config.vault.manualFolders : ['Inbox', 'Manual'];
    const manualIssues = [];
    for (const folder of manualFolders) {
      const folderPath = path.join(mirrorRoot, folder);
      if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) manualIssues.push(`missing manual folder: ${folder}`);
    }
    const nativeLastMs = Date.parse(String(existing?.freshness?.native?.last_source_at || '')) || 0;
    const dailyLastMs = Date.parse(String(existing?.freshness?.native?.last_daily_note_at || '')) || 0;
    const buildLastMs = Date.parse(String(existing?.freshness?.vault?.last_built_at || existing?.generated_at || '')) || 0;
    return {
      enabled: config?.vault?.enabled === true,
      vault_root: vaultRoot,
      mirror_root: mirrorRoot,
      native: {
        last_source_at: existing?.freshness?.native?.last_source_at || null,
        last_daily_note_at: existing?.freshness?.native?.last_daily_note_at || null,
        stale: nativeLastMs > 0 ? (Date.now() - nativeLastMs) > daysToMs(STALE_WINDOWS_DAYS.native) : true,
        daily_note_stale: dailyLastMs > 0 ? (Date.now() - dailyLastMs) > daysToMs(STALE_WINDOWS_DAYS.daily) : true,
      },
      vault: {
        last_built_at: existing?.freshness?.vault?.last_built_at || existing?.generated_at || null,
        stale: buildLastMs > 0 ? (Date.now() - buildLastMs) > daysToMs(STALE_WINDOWS_DAYS.vault) : true,
      },
      manual_protection: {
        ok: manualIssues.length === 0,
        issues: manualIssues,
      },
      summary_path: loaded.filePath,
    };
  }

  const context = openContextDb({ db, dbPath, config });
  try {
    const nativeSources = collectNativeSources({
      db: context.db,
      config,
      workspaceRoot: String(config?.runtime?.paths?.workspaceRoot || process.cwd()),
    });
    const { mirrorRoot, vaultRoot } = resolveMirrorRoot(config);
    const manualFolders = Array.isArray(config?.vault?.manualFolders) ? config.vault.manualFolders : ['Inbox', 'Manual'];
    const manualIssues = [];
    for (const folder of manualFolders) {
      const folderPath = path.join(mirrorRoot, folder);
      if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) manualIssues.push(`missing manual folder: ${folder}`);
    }
    const buildReportPath = path.join(mirrorRoot, '40 Reports', 'vault-build-summary.md');
    const buildLastMs = fs.existsSync(buildReportPath) ? fs.statSync(buildReportPath).mtimeMs : 0;
    const nativeLastMs = Date.parse(String(nativeSources.last_source_at || '')) || 0;
    const dailyLastMs = Date.parse(String(nativeSources.last_daily_note_at || '')) || 0;
    return {
      enabled: config?.vault?.enabled === true,
      vault_root: vaultRoot,
      mirror_root: mirrorRoot,
      native: {
        last_source_at: nativeSources.last_source_at,
        last_daily_note_at: nativeSources.last_daily_note_at,
        stale: nativeLastMs > 0 ? (Date.now() - nativeLastMs) > daysToMs(STALE_WINDOWS_DAYS.native) : true,
        daily_note_stale: dailyLastMs > 0 ? (Date.now() - dailyLastMs) > daysToMs(STALE_WINDOWS_DAYS.daily) : true,
      },
      vault: {
        last_built_at: buildLastMs > 0 ? new Date(buildLastMs).toISOString() : null,
        stale: buildLastMs > 0 ? (Date.now() - buildLastMs) > daysToMs(STALE_WINDOWS_DAYS.vault) : true,
      },
      manual_protection: {
        ok: manualIssues.length === 0,
        issues: manualIssues,
      },
      summary_path: loaded.filePath,
    };
  } finally {
    if (context.close) context.db.close();
  }
};

const syncVaultPull = ({
  host = '',
  remotePath = '',
  target = '',
  subdir = 'Gigabrain',
  manualFolders = ['Inbox', 'Manual'],
  preserveManual = true,
  dryRun = false,
} = {}) => {
  const sourceRoot = String(remotePath || '').trim();
  const targetRoot = String(target || '').trim();
  if (!sourceRoot) throw new Error('vault pull requires --remote-path');
  if (!targetRoot) throw new Error('vault pull requires --target');

  ensureDir(targetRoot);

  const normalizedSubdir = String(subdir || 'Gigabrain').trim() || 'Gigabrain';
  const args = ['-a', '--delete'];
  if (dryRun) args.push('--dry-run', '--itemize-changes');
  if (preserveManual) {
    args.push('--filter', 'P .obsidian/***');
    for (const folder of manualFolders) {
      args.push('--filter', `P ${normalizedSubdir}/${folder}/***`);
    }
  }
  const sourceSpec = host
    ? `${String(host).trim()}:${sourceRoot.replace(/\/+$/, '')}/`
    : `${sourceRoot.replace(/\/+$/, '')}/`;
  const targetSpec = `${targetRoot.replace(/\/+$/, '')}/`;
  const run = spawnSync('rsync', [...args, sourceSpec, targetSpec], {
    encoding: 'utf8',
  });
  if (Number(run.status || 0) !== 0) {
    throw new Error(`vault pull failed: ${String(run.stderr || run.stdout || 'unknown rsync error').trim()}`);
  }
  const changes = String(run.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith('sending incremental') && !line.startsWith('sent ') && !line.startsWith('total size'));
  return {
    ok: true,
    host: String(host || '').trim() || null,
    remote_path: sourceRoot,
    target: targetRoot,
    dry_run: dryRun,
    preserve_manual: preserveManual,
    manual_folders: manualFolders,
    subdir: normalizedSubdir,
    changed_paths: changes,
    command: ['rsync', ...args, sourceSpec, targetSpec].join(' '),
  };
};

export {
  buildVaultSurface,
  inspectVaultHealth,
  loadSurfaceSummary,
  renderVaultBuildMarkdown,
  renderVaultDoctorMarkdown,
  syncVaultPull,
  buildVaultSurface as syncVaultMirror,
  renderVaultBuildMarkdown as renderVaultMirrorMarkdown,
};
