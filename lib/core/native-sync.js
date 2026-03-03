import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { containsEntity } from './person-service.js';
import { normalizeContent } from './policy.js';

const MEMORY_ID_RE = /\[m:([0-9a-f-]{8,})\]/i;
const MEMORY_ID_GLOBAL_RE = /\[m:[0-9a-f-]{8,}\]\s*/ig;
const HEADING_RE = /^(#{1,3})\s+(.+?)\s*$/;
const BULLET_RE = /^\s*(?:[-*]|\d+\.)\s+(.+?)\s*$/;
const FALLBACK_DAILY_RE = /^\d{4}-\d{2}-\d{2}.*\.md$/i;

const sha1 = (value) => crypto.createHash('sha1').update(String(value || '')).digest('hex');

const toIsoDate = (value) => {
  const ms = Date.parse(String(value || ''));
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().slice(0, 10);
};

const basenameDate = (filePath) => {
  const base = path.basename(String(filePath || ''));
  const match = base.match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] || null;
};

const globToRegex = (pattern) => {
  const raw = String(pattern || '').replace(/\\/g, '/').trim();
  if (!raw) return /^$/;
  let escaped = raw
    .replace(/[\\.+^${}()|]/g, '\\$&')
    .replace(/\*\*/g, '__GB_GLOBSTAR__')
    .replace(/\*/g, '__GB_STAR__')
    .replace(/\?/g, '__GB_QMARK__');
  escaped = escaped
    .replace(/__GB_GLOBSTAR__/g, '.*')
    .replace(/__GB_STAR__/g, '[^/]*')
    .replace(/__GB_QMARK__/g, '.');
  escaped = escaped
    .replace(/\\\[([^\]]+)\\\]/g, '[$1]');
  return new RegExp(`^${escaped}$`, 'i');
};

const normalizeRelative = (workspaceRoot, filePath) => {
  const rel = path.relative(workspaceRoot, filePath);
  return String(rel || '').replace(/\\/g, '/');
};

const includePath = (workspaceRoot, filePath, excludeGlobs = []) => {
  const rel = normalizeRelative(workspaceRoot, filePath);
  if (!rel || rel.startsWith('../')) return false;
  for (const glob of excludeGlobs) {
    const re = globToRegex(glob);
    if (re.test(rel)) return false;
  }
  return true;
};

const parseHeadingStack = (state, line) => {
  const match = String(line || '').match(HEADING_RE);
  if (!match) return;
  const level = Number(String(match[1] || '').length || 1);
  const text = String(match[2] || '').trim();
  if (!text) return;
  if (level === 1) {
    state.h1 = text;
    state.h2 = '';
    state.h3 = '';
    return;
  }
  if (level === 2) {
    state.h2 = text;
    state.h3 = '';
    return;
  }
  state.h3 = text;
};

const sectionLabel = (state = {}) => (
  [state.h1, state.h2, state.h3]
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .join(' > ')
);

const parseChunksFromText = ({
  sourcePath,
  sourceKind,
  sourceDate,
  rawText,
  maxChunkChars,
}) => {
  const lines = String(rawText || '').split(/\r?\n/);
  const chunks = [];
  const headings = { h1: '', h2: '', h3: '' };
  const pushChunk = ({
    text,
    lineStart,
    lineEnd,
    section,
    linkedMemoryId,
  }) => {
    const content = String(text || '').trim().slice(0, maxChunkChars);
    if (!content) return;
    const normalized = normalizeContent(content);
    if (!normalized) return;
    const lineKey = `${lineStart || 0}:${lineEnd || 0}`;
    const chunkId = sha1(`${sourcePath}|${lineKey}|${normalized}`);
    chunks.push({
      chunk_id: chunkId,
      source_path: sourcePath,
      source_kind: sourceKind,
      source_date: sourceDate,
      section: section || null,
      line_start: Number(lineStart || 0) || 0,
      line_end: Number(lineEnd || lineStart || 0) || 0,
      content,
      normalized,
      hash: sha1(normalized),
      linked_memory_id: linkedMemoryId || null,
    });
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = String(lines[idx] || '');
    parseHeadingStack(headings, line);
    const bullet = line.match(BULLET_RE);
    if (!bullet?.[1]) continue;
    const original = String(bullet[1] || '').trim();
    if (!original) continue;
    const linkedMemoryId = original.match(MEMORY_ID_RE)?.[1] || null;
    const cleaned = original.replace(MEMORY_ID_GLOBAL_RE, '').trim();
    if (!cleaned || cleaned.length < 4) continue;
    pushChunk({
      text: cleaned,
      lineStart: idx + 1,
      lineEnd: idx + 1,
      section: sectionLabel(headings),
      linkedMemoryId,
    });
  }

  if (chunks.length > 0) return chunks;

  let buffer = [];
  let startLine = 0;
  const flush = (lineEnd) => {
    if (buffer.length === 0) return;
    const joined = buffer.join(' ').replace(/\s+/g, ' ').trim();
    if (joined.length >= 16) {
      pushChunk({
        text: joined,
        lineStart: startLine,
        lineEnd,
        section: sectionLabel(headings),
        linkedMemoryId: null,
      });
    }
    buffer = [];
    startLine = 0;
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = String(lines[idx] || '');
    parseHeadingStack(headings, line);
    if (!line.trim() || HEADING_RE.test(line)) {
      flush(idx);
      continue;
    }
    if (!startLine) startLine = idx + 1;
    buffer.push(line.trim());
    if (buffer.join(' ').length >= maxChunkChars) flush(idx + 1);
  }
  flush(lines.length);

  return chunks;
};

const resolveDailyNoteFiles = (workspaceRoot, config = {}) => {
  const globPattern = String(config?.native?.dailyNotesGlob || 'memory/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*.md').trim();
  const relativeDir = path.dirname(globPattern);
  const basenamePattern = path.basename(globPattern);
  const notesDir = path.resolve(workspaceRoot, relativeDir || 'memory');
  if (!fs.existsSync(notesDir)) return [];
  const baseRe = globToRegex(basenamePattern || FALLBACK_DAILY_RE.source);
  return fs.readdirSync(notesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((name) => baseRe.test(name) || FALLBACK_DAILY_RE.test(name))
    .map((name) => path.join(notesDir, name))
    .sort();
};

const classifySourceKind = ({
  sourcePath,
  memoryMdPath,
  includeFiles,
}) => {
  const normalized = String(sourcePath || '');
  if (normalized === String(memoryMdPath || '')) return 'memory_md';
  if (includeFiles.includes(normalized)) return 'curated';
  return 'daily_note';
};

const ensureNativeStore = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_native_chunks (
      chunk_id TEXT PRIMARY KEY,
      source_path TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_date TEXT,
      section TEXT,
      line_start INTEGER,
      line_end INTEGER,
      content TEXT NOT NULL,
      normalized TEXT NOT NULL,
      hash TEXT NOT NULL,
      linked_memory_id TEXT,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    );
    CREATE INDEX IF NOT EXISTS idx_memory_native_chunks_source ON memory_native_chunks(source_path, status);
    CREATE INDEX IF NOT EXISTS idx_memory_native_chunks_kind ON memory_native_chunks(source_kind, status);
    CREATE INDEX IF NOT EXISTS idx_memory_native_chunks_date ON memory_native_chunks(source_date, status);
    CREATE INDEX IF NOT EXISTS idx_memory_native_chunks_linked ON memory_native_chunks(linked_memory_id);

    CREATE TABLE IF NOT EXISTS memory_native_sync_state (
      source_path TEXT PRIMARY KEY,
      mtime_ms INTEGER NOT NULL,
      size_bytes INTEGER NOT NULL,
      hash TEXT NOT NULL,
      last_synced_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memory_native_sync_state_synced ON memory_native_sync_state(last_synced_at);
  `);
};

const syncNativeMemory = ({
  db,
  config,
  dryRun = false,
} = {}) => {
  ensureNativeStore(db);
  const workspaceRoot = String(config?.runtime?.paths?.workspaceRoot || process.cwd());
  const nowIso = new Date().toISOString();
  const maxChunkChars = Math.max(120, Number(config?.native?.maxChunkChars || 900) || 900);
  const memoryMdPath = path.resolve(String(config?.native?.memoryMdPath || path.join(workspaceRoot, 'MEMORY.md')));
  const includeFiles = Array.isArray(config?.native?.includeFiles)
    ? config.native.includeFiles.map((item) => path.resolve(String(item)))
    : [];
  const excludeGlobs = Array.isArray(config?.native?.excludeGlobs) ? config.native.excludeGlobs : [];

  const candidateSet = new Set();
  if (fs.existsSync(memoryMdPath)) candidateSet.add(memoryMdPath);
  for (const filePath of includeFiles) {
    if (fs.existsSync(filePath)) candidateSet.add(filePath);
  }
  for (const filePath of resolveDailyNoteFiles(workspaceRoot, config)) {
    candidateSet.add(filePath);
  }

  const candidatePaths = Array.from(candidateSet)
    .filter((filePath) => includePath(workspaceRoot, filePath, excludeGlobs))
    .sort();

  const existingStateRows = db.prepare(`
    SELECT source_path, mtime_ms, size_bytes, hash
    FROM memory_native_sync_state
  `).all();
  const existingState = new Map(existingStateRows.map((row) => [String(row.source_path), row]));

  const summary = {
    scanned_files: candidatePaths.length,
    changed_files: 0,
    skipped_unchanged: 0,
    inserted_chunks: 0,
    linked_chunks: 0,
    removed_sources: 0,
    active_sources: candidatePaths,
  };

  const insertChunk = db.prepare(`
    INSERT INTO memory_native_chunks (
      chunk_id, source_path, source_kind, source_date, section, line_start, line_end,
      content, normalized, hash, linked_memory_id, first_seen_at, last_seen_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const upsertState = db.prepare(`
    INSERT INTO memory_native_sync_state (source_path, mtime_ms, size_bytes, hash, last_synced_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(source_path) DO UPDATE SET
      mtime_ms = excluded.mtime_ms,
      size_bytes = excluded.size_bytes,
      hash = excluded.hash,
      last_synced_at = excluded.last_synced_at
  `);
  const deleteChunksForSource = db.prepare('DELETE FROM memory_native_chunks WHERE source_path = ?');
  const markInactiveForSource = db.prepare(`
    UPDATE memory_native_chunks
    SET status = 'inactive', last_seen_at = ?
    WHERE source_path = ? AND status = 'active'
  `);
  const deleteState = db.prepare('DELETE FROM memory_native_sync_state WHERE source_path = ?');

  const runInTx = (fn) => {
    db.exec('BEGIN');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  runInTx(() => {
    for (const sourcePath of candidatePaths) {
      if (!fs.existsSync(sourcePath)) continue;
      const stat = fs.statSync(sourcePath);
      const raw = fs.readFileSync(sourcePath, 'utf8');
      const fileHash = sha1(raw);
      const known = existingState.get(sourcePath);
      const unchanged = known
        && Number(known.mtime_ms) === Number(stat.mtimeMs)
        && Number(known.size_bytes) === Number(stat.size)
        && String(known.hash || '') === String(fileHash);
      if (unchanged) {
        summary.skipped_unchanged += 1;
        continue;
      }
      summary.changed_files += 1;
      const sourceKind = classifySourceKind({
        sourcePath,
        memoryMdPath,
        includeFiles,
      });
      const sourceDate = basenameDate(sourcePath) || toIsoDate(stat.mtime.toISOString());
      const parsed = parseChunksFromText({
        sourcePath,
        sourceKind,
        sourceDate,
        rawText: raw,
        maxChunkChars,
      });
      if (!dryRun) {
        deleteChunksForSource.run(sourcePath);
        for (const chunk of parsed) {
          if (chunk.linked_memory_id) summary.linked_chunks += 1;
          insertChunk.run(
            chunk.chunk_id,
            chunk.source_path,
            chunk.source_kind,
            chunk.source_date,
            chunk.section,
            chunk.line_start,
            chunk.line_end,
            chunk.content,
            chunk.normalized,
            chunk.hash,
            chunk.linked_memory_id,
            nowIso,
            nowIso,
            'active',
          );
          summary.inserted_chunks += 1;
        }
        upsertState.run(sourcePath, Number(stat.mtimeMs), Number(stat.size), fileHash, nowIso);
      } else {
        summary.inserted_chunks += parsed.length;
        summary.linked_chunks += parsed.filter((chunk) => Boolean(chunk.linked_memory_id)).length;
      }
    }

    const activeSet = new Set(candidatePaths);
    for (const row of existingStateRows) {
      const sourcePath = String(row.source_path || '');
      if (!sourcePath || activeSet.has(sourcePath)) continue;
      summary.removed_sources += 1;
      if (!dryRun) {
        markInactiveForSource.run(nowIso, sourcePath);
        deleteState.run(sourcePath);
      }
    }
  });

  return summary;
};

const lexicalScore = (content, tokens = []) => {
  const normalized = normalizeContent(content);
  if (!normalized || tokens.length === 0) return 0;
  let hit = 0;
  for (const token of tokens) {
    if (!token) continue;
    if (containsEntity(normalized, token, true)) hit += 1;
  }
  return hit / Math.max(1, tokens.length);
};

const queryNativeChunks = ({
  db,
  config,
  query = '',
  scope = 'shared',
  startDate = '',
  endDate = '',
  limit = 24,
  entityKeys = [],
} = {}) => {
  ensureNativeStore(db);
  const topK = Math.max(1, Math.min(500, Number(limit || 24) || 24));
  const normalizedQuery = normalizeContent(query);
  const tokens = normalizedQuery.split(/\s+/).filter(Boolean).slice(0, 10);
  const entityList = Array.isArray(entityKeys) ? entityKeys.map((item) => normalizeContent(item)).filter(Boolean) : [];
  const searchTerms = Array.from(new Set([...tokens, ...entityList]))
    .filter((term) => term.length >= 3)
    .slice(0, 12);
  const where = ['status = ?'];
  const params = ['active'];
  if (String(scope || 'shared') === 'shared') {
    where.push('source_kind = ?');
    params.push('curated');
  }
  if (startDate) {
    where.push('(source_date IS NOT NULL AND source_date >= ?)');
    params.push(String(startDate));
  }
  if (endDate) {
    where.push('(source_date IS NOT NULL AND source_date <= ?)');
    params.push(String(endDate));
  }
  if (searchTerms.length > 0) {
    where.push(`(${searchTerms.map(() => '(normalized LIKE ? OR content LIKE ?)').join(' OR ')})`);
    for (const term of searchTerms) {
      const like = `%${term}%`;
      params.push(like, like);
    }
  }
  const sqlLimit = Math.max(
    searchTerms.length > 0 ? 600 : 120,
    searchTerms.length > 0 ? topK * 24 : topK * 8,
  );
  const rows = db.prepare(`
    SELECT
      chunk_id, source_path, source_kind, source_date, section, line_start, line_end,
      content, normalized, hash, linked_memory_id, first_seen_at, last_seen_at, status
    FROM memory_native_chunks
    WHERE ${where.join(' AND ')}
    ORDER BY source_date DESC, last_seen_at DESC
    LIMIT ?
  `).all(...params, Math.min(8000, sqlLimit));

  const filtered = rows
    .map((row) => {
      const lex = lexicalScore(row.content || row.normalized || '', tokens);
      let entityHit = 0;
      if (entityList.length > 0) {
        const normalized = normalizeContent(row.content || row.normalized || '');
        for (const key of entityList) {
          if (containsEntity(normalized, key, true)) {
            entityHit += 1;
            break;
          }
        }
      }
      return {
        ...row,
        score_lexical: lex,
        score_entity: entityHit > 0 ? 1 : 0,
        score_total: lex + (entityHit > 0 ? 0.35 : 0),
      };
    })
    .filter((row) => row.score_total > 0 || entityList.length === 0)
    .sort((a, b) => Number(b.score_total || 0) - Number(a.score_total || 0))
    .slice(0, topK);
  return filtered;
};

const renderNativeSyncMarkdown = ({ timestamp, runId, summary }) => {
  const lines = [];
  lines.push('# Native Memory Sync Report');
  lines.push('');
  lines.push(`- timestamp: ${timestamp}`);
  lines.push(`- run_id: \`${runId}\``);
  lines.push(`- scanned_files: ${Number(summary?.scanned_files || 0)}`);
  lines.push(`- changed_files: ${Number(summary?.changed_files || 0)}`);
  lines.push(`- skipped_unchanged: ${Number(summary?.skipped_unchanged || 0)}`);
  lines.push(`- inserted_chunks: ${Number(summary?.inserted_chunks || 0)}`);
  lines.push(`- linked_chunks: ${Number(summary?.linked_chunks || 0)}`);
  lines.push(`- removed_sources: ${Number(summary?.removed_sources || 0)}`);
  lines.push('');
  const sources = Array.isArray(summary?.active_sources) ? summary.active_sources : [];
  if (sources.length > 0) {
    lines.push('## Sources');
    lines.push('');
    for (const sourcePath of sources) {
      lines.push(`- ${sourcePath}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
};

export {
  ensureNativeStore,
  syncNativeMemory,
  queryNativeChunks,
  renderNativeSyncMarkdown,
};
