#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../lib/core/sqlite.js';

import { loadResolvedConfig } from '../lib/core/config.js';
import {
  ensureProjectionStore,
  listCurrentMemories,
  materializeProjectionFromMemories,
} from '../lib/core/projection-store.js';
import { ensureNativeStore, syncNativeMemory } from '../lib/core/native-sync.js';
import { normalizeContent } from '../lib/core/policy.js';

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

const readInt = (name, fallback, min = 1, max = 100000) => {
  const raw = readFlag(name, String(fallback));
  const num = Number(raw);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(num)));
};

const ensureDir = (targetPath) => {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
};

const backupIfExists = (targetPath) => {
  if (!fs.existsSync(targetPath)) return '';
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${targetPath}.bak.${stamp}`;
  ensureDir(backupPath);
  fs.copyFileSync(targetPath, backupPath);
  return backupPath;
};

const parseList = (value, fallback = []) => {
  const raw = String(value || '').trim();
  if (!raw) return [...fallback];
  const out = raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  return out.length > 0 ? out : [...fallback];
};

const parseStatusList = (value) => {
  const allowed = new Set(['active', 'archived', 'rejected', 'superseded']);
  const parsed = parseList(value, ['active', 'archived']).filter((item) => allowed.has(item));
  return parsed.length > 0 ? parsed : ['active', 'archived'];
};

const TYPE_ORDER = Object.freeze([
  'USER_FACT',
  'PREFERENCE',
  'DECISION',
  'ENTITY',
  'EPISODE',
  'AGENT_IDENTITY',
  'CONTEXT',
]);

const typeRank = (type) => {
  const idx = TYPE_ORDER.indexOf(String(type || '').toUpperCase());
  return idx === -1 ? TYPE_ORDER.length : idx;
};

const sortRows = (rows = []) => [...rows].sort((a, b) => {
  const typeCmp = typeRank(a.type) - typeRank(b.type);
  if (typeCmp !== 0) return typeCmp;
  const aMs = Date.parse(String(a.updated_at || a.created_at || '')) || 0;
  const bMs = Date.parse(String(b.updated_at || b.created_at || '')) || 0;
  if (aMs !== bMs) return bMs - aMs;
  return String(a.memory_id || '').localeCompare(String(b.memory_id || ''));
});

const cleanContent = (value, maxChars = 320) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(64, maxChars - 1)).trimEnd()}…`;
};

const selectRows = ({
  rows,
  maxRows,
  perTypeLimit,
  minConfidence,
}) => {
  const byKey = new Set();
  const perType = new Map();
  const selected = [];

  for (const row of rows) {
    const confidence = Number(row?.confidence);
    if (Number.isFinite(minConfidence) && Number.isFinite(confidence) && confidence < minConfidence) continue;

    const key = `${String(row?.scope || 'shared')}|${normalizeContent(row?.normalized || row?.content || '')}`;
    if (!key || key.endsWith('|')) continue;
    if (byKey.has(key)) continue;

    const type = String(row?.type || 'CONTEXT').toUpperCase();
    const seenType = Number(perType.get(type) || 0);
    if (seenType >= perTypeLimit) continue;

    byKey.add(key);
    perType.set(type, seenType + 1);
    selected.push(row);
    if (selected.length >= maxRows) break;
  }

  return selected;
};

const renderMarkdown = ({
  rows,
  statuses,
  sourceDbPath,
}) => {
  const lines = [];
  lines.push('# Gigabrain Harmonized Memory');
  lines.push('');
  lines.push(`- generated_at: ${new Date().toISOString()}`);
  lines.push(`- statuses: ${statuses.join(', ')}`);
  lines.push(`- source_db: ${path.basename(sourceDbPath)}`);
  lines.push(`- rows: ${rows.length}`);
  lines.push('');

  const grouped = new Map();
  for (const row of sortRows(rows)) {
    const type = String(row?.type || 'CONTEXT').toUpperCase() || 'CONTEXT';
    const list = grouped.get(type) || [];
    list.push(row);
    grouped.set(type, list);
  }

  for (const type of TYPE_ORDER) {
    const list = grouped.get(type) || [];
    if (list.length === 0) continue;
    lines.push(`## ${type}`);
    lines.push('');
    for (const row of list) {
      const content = cleanContent(row?.content || '');
      if (!content) continue;
      const memoryId = String(row?.memory_id || '').trim();
      const scope = String(row?.scope || 'shared').trim() || 'shared';
      const updatedAt = String(row?.updated_at || row?.created_at || '').trim();
      const stamp = updatedAt ? updatedAt.slice(0, 10) : '';
      const confidence = Number(row?.confidence);
      const confLabel = Number.isFinite(confidence) ? `, c=${confidence.toFixed(2)}` : '';
      const idPart = memoryId ? `[m:${memoryId}] ` : '';
      const meta = `(${scope}${confLabel}${stamp ? `, ${stamp}` : ''})`;
      lines.push(`- ${idPart}${meta} ${content}`);
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
};

const uniquePaths = (values = []) => Array.from(
  new Set(values.map((item) => path.resolve(String(item || '').trim())).filter(Boolean)),
);

const main = () => {
  const configPath = readFlag('--config', '');
  const workspaceOverride = readFlag('--workspace', '');
  const loaded = loadResolvedConfig({
    configPath,
    workspaceRoot: workspaceOverride || undefined,
  });
  const config = loaded.config;
  const dbPath = path.resolve(readFlag('--db', config?.runtime?.paths?.registryPath || ''));
  if (!dbPath) throw new Error('Could not resolve db path. Pass --db or configure gigabrain.runtime.paths.registryPath.');

  const statuses = parseStatusList(readFlag('--statuses', 'active,archived'));
  const maxRows = readInt('--max-rows', 420, 10, 5000);
  const perTypeLimit = readInt('--per-type-limit', 120, 1, 2000);
  const minConfidence = Number(readFlag('--min-confidence', '0')) || 0;
  const syncNative = readBool('--sync-native', true);
  const includeInNative = readBool('--include-in-native', true);
  const makeBackup = readBool('--backup', true);

  const outPath = path.resolve(readFlag(
    '--out',
    path.join(config.runtime.paths.memoryRoot, 'gigabrain-harmonized.md'),
  ));

  const db = openDatabase(dbPath);
  let importedProjection = 0;
  try {
    ensureProjectionStore(db);
    const rowCount = db.prepare('SELECT COUNT(*) AS c FROM memory_current').get()?.c || 0;
    if (Number(rowCount) === 0) {
      const result = materializeProjectionFromMemories(db);
      importedProjection = Number(result?.imported || 0);
    }

    const sourceRows = listCurrentMemories(db, {
      statuses,
      limit: Math.max(maxRows * 12, 3000),
    });
    const selected = selectRows({
      rows: sourceRows,
      maxRows,
      perTypeLimit,
      minConfidence,
    });

    const markdown = renderMarkdown({
      rows: selected,
      statuses,
      sourceDbPath: dbPath,
    });
    ensureDir(outPath);
    const backupPath = makeBackup ? backupIfExists(outPath) : '';
    fs.writeFileSync(outPath, markdown, 'utf8');

    let nativeSyncSummary = null;
    if (syncNative) {
      ensureNativeStore(db);
      const nativeConfig = includeInNative
        ? {
          ...config,
          native: {
            ...config.native,
            includeFiles: uniquePaths([...(config?.native?.includeFiles || []), outPath]),
          },
        }
        : config;
      nativeSyncSummary = syncNativeMemory({
        db,
        config: nativeConfig,
        dryRun: false,
      });
    }

    console.log(JSON.stringify({
      ok: true,
      configPath: loaded.configPath,
      dbPath,
      outPath,
      backupPath,
      statuses,
      selectedRows: selected.length,
      importedProjection,
      syncNative,
      includeInNative,
      nativeSyncSummary,
    }, null, 2));
  } finally {
    db.close();
  }
};

try {
  main();
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exit(1);
}
