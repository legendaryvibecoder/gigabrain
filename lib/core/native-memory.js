import fs from 'node:fs';
import path from 'node:path';

import { normalizeContent } from './policy.js';

const HEADING_BY_TYPE = Object.freeze({
  PREFERENCE: 'Preferences',
  DECISION: 'Decisions',
  USER_FACT: 'User Facts',
  AGENT_IDENTITY: 'Agent Identity',
  ENTITY: 'Entities',
  EPISODE: 'Episodes',
  CONTEXT: 'Session Notes',
});

const CHECKPOINT_BASE_SECTION_TITLES = Object.freeze({
  decisions: 'Decisions',
  open_loops: 'Open Loops',
  touched_files: 'Touched Files',
  durable_candidates: 'Durable Candidates',
});

const MEMORY_LINK_RE = /\[m:[0-9a-f-]{8,}\]\s*/ig;
const BULLET_RE = /^\s*(?:[-*]|\d+\.)\s+(.+?)\s*$/;
const SCOPE_COMMENT_RE = /\s*<!--\s*gigabrain:scope=([^\s>]+)\s*-->\s*$/i;

// Path validation constants
const VALID_FILENAME_RE = /^[a-zA-Z0-9_\-.]{1,256}$/;
const MAX_PATH_LENGTH = 4096;

const ensureDir = (dirPath) => {
  fs.mkdirSync(dirPath, { recursive: true });
};

const resolveRealPath = (filePath) => {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return null;
  }
};

const validateFilePath = (filePath, allowedRoot) => {
  if (!filePath || typeof filePath !== 'string') return false;
  if (filePath.length > MAX_PATH_LENGTH) return false;
  // Block path traversal attempts
  if (filePath.includes('..')) return false;
  if (filePath.includes('\0')) return false;

  // Resolve to absolute path and ensure it's within allowed root
  const resolved = path.resolve(filePath);
  const resolvedRoot = path.resolve(allowedRoot);

  // Check that resolved path starts with resolved root
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }

  // Additional check: ensure the path doesn't escape through symlinks
  const realPath = resolveRealPath(resolved);
  if (realPath) {
    const realRoot = resolveRealPath(resolvedRoot) || resolvedRoot;
    const realRelative = path.relative(realRoot, realPath);
    if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
      return false;
    }
  }

  return true;
};

const stripScopeComment = (value = '') => {
  const raw = String(value || '');
  const match = raw.match(SCOPE_COMMENT_RE);
  return {
    scope: String(match?.[1] || '').trim(),
    text: raw.replace(SCOPE_COMMENT_RE, '').trim(),
  };
};

const appendScopeComment = (value = '', scope = '') => {
  const text = String(value || '').trim();
  const normalizedScope = String(scope || '').trim();
  if (!normalizedScope) return text;
  return `${text} <!-- gigabrain:scope=${normalizedScope} -->`;
};

const normalizeCheckpointSurface = (value = '') => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'codex';
  if (normalized === 'codex' || normalized === 'claude' || normalized === 'openclaw' || normalized === 'agent') {
    return normalized;
  }
  return 'agent';
};

const checkpointSurfaceLabel = (surface = '') => {
  switch (normalizeCheckpointSurface(surface)) {
    case 'claude':
      return 'Claude';
    case 'openclaw':
      return 'OpenClaw';
    case 'agent':
      return 'Agent';
    case 'codex':
    default:
      return 'Codex App';
  }
};

const checkpointSectionTitlesForSurface = (surface = '') => {
  const label = checkpointSurfaceLabel(surface);
  return {
    summary: `${label} Sessions`,
    ...CHECKPOINT_BASE_SECTION_TITLES,
  };
};

const headingForType = (type, durable) => {
  const normalizedType = String(type || '').trim().toUpperCase() || 'CONTEXT';
  if (!durable && (normalizedType === 'USER_FACT' || normalizedType === 'PREFERENCE')) return 'Remembered Today';
  return HEADING_BY_TYPE[normalizedType] || (durable ? 'Durable Notes' : 'Session Notes');
};

const normalizeBulletContent = (line) => {
  const match = String(line || '').match(BULLET_RE);
  const { scope, text } = stripScopeComment(match?.[1] || '');
  const raw = String(text || '').replace(MEMORY_LINK_RE, '').trim();
  return {
    normalized: normalizeContent(raw),
    scope,
  };
};

const findExistingBulletLine = (lines, content, scope = '') => {
  const target = normalizeContent(content);
  const targetScope = String(scope || '').trim();
  if (!target) return 0;
  for (let index = 0; index < lines.length; index += 1) {
    if (!BULLET_RE.test(String(lines[index] || ''))) continue;
    const existing = normalizeBulletContent(lines[index]);
    if (existing.normalized === target && existing.scope === targetScope) return index + 1;
  }
  return 0;
};

const appendSectionAndBullet = ({ filePath, title, sectionHeading, bulletLine, content, scope = '' }, allowedRoot = '') => {
  // Validate filePath to prevent path traversal
  const memoryRoot = allowedRoot || process.env.GIGABRAIN_MEMORY_ROOT || '/tmp/gigabrain';
  if (!validateFilePath(filePath, memoryRoot)) {
    throw new Error('Invalid file path: path traversal detected');
  }

  ensureDir(path.dirname(filePath));
  // Use atomic read to avoid TOCTOU race condition
  let existing = '';
  try {
    existing = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    existing = '';
  }
  const lines = existing ? existing.replace(/\r/g, '').split('\n') : [];
  const existingLine = findExistingBulletLine(lines, content, scope);
  if (existingLine > 0) {
    return {
      written: false,
      line: existingLine,
    };
  }

  const appended = [];
  if (lines.length === 0) {
    appended.push(`# ${title}`, '', `## ${sectionHeading}`, '', bulletLine, '');
  } else {
    if (String(lines[lines.length - 1] || '').trim() !== '') appended.push('');
    const lastMeaningful = [...lines].reverse().find((line) => String(line || '').trim());
    if (String(lastMeaningful || '').trim() !== `## ${sectionHeading}`) {
      appended.push(`## ${sectionHeading}`, '');
    }
    appended.push(bulletLine, '');
  }

  const startLine = lines.length + 1;
  const lineNumber = startLine + appended.findIndex((line) => line === bulletLine);
  const merged = [...lines, ...appended].join('\n').replace(/\n{3,}$/g, '\n\n');
  fs.writeFileSync(filePath, `${merged.endsWith('\n') ? merged : `${merged}\n`}`, 'utf8');
  return {
    written: true,
    line: lineNumber,
  };
};

const normalizeCheckpointItems = (items = []) => {
  if (!Array.isArray(items)) return [];
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const text = String(item || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const key = normalizeContent(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
};

const prefixCheckpointItem = (prefix, value) => `${prefix}: ${String(value || '').trim()}`;

const writeCheckpointSection = ({
  filePath,
  title,
  sectionHeading,
  entries = [],
  scope = '',
  allowedRoot = '',
} = {}) => {
  const results = [];
  for (const entry of entries) {
    const text = String(entry || '').trim();
    if (!text) continue;
    results.push(appendSectionAndBullet({
      filePath,
      title,
      sectionHeading,
      bulletLine: `- ${appendScopeComment(text, scope)}`,
      content: text,
      scope,
    }, allowedRoot));
  }
  return results;
};

const writeNativeSessionCheckpoint = ({
  config,
  timestamp = new Date().toISOString(),
  surface = '',
  sessionLabel = '',
  summary = '',
  decisions = [],
  openLoops = [],
  touchedFiles = [],
  durableCandidates = [],
  scope = '',
} = {}) => {
  const dateKey = String(timestamp).slice(0, 10) || new Date().toISOString().slice(0, 10);
  const memoryRoot = String(config?.runtime?.paths?.memoryRoot || '').trim();
  if (!memoryRoot) {
    throw new Error('memoryRoot is required');
  }
  // Validate dateKey is a safe filename (YYYY-MM-DD format)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw new Error('Invalid date format for checkpoint filename');
  }
  const filePath = path.join(memoryRoot, `${dateKey}.md`);
  const title = dateKey;
  const surfaceLabel = checkpointSurfaceLabel(surface);
  const sectionTitles = checkpointSectionTitlesForSurface(surface);

  const normalizedSummary = String(summary || '').replace(/\s+/g, ' ').trim();
  const normalizedLabel = String(sessionLabel || '').replace(/\s+/g, ' ').trim();
  const summaryEntries = normalizedSummary
    ? [normalizedLabel ? `${surfaceLabel} session (${normalizedLabel}): ${normalizedSummary}` : `${surfaceLabel} session: ${normalizedSummary}`]
    : [];
  const decisionEntries = normalizeCheckpointItems(decisions).map((item) => prefixCheckpointItem('Decision', item));
  const openLoopEntries = normalizeCheckpointItems(openLoops).map((item) => prefixCheckpointItem('Open loop', item));
  const touchedFileEntries = normalizeCheckpointItems(touchedFiles).map((item) => prefixCheckpointItem('Touched file', item));
  const durableCandidateEntries = normalizeCheckpointItems(durableCandidates);

  const sections = [
    [sectionTitles.summary, summaryEntries],
    [sectionTitles.decisions, decisionEntries],
    [sectionTitles.open_loops, openLoopEntries],
    [sectionTitles.touched_files, touchedFileEntries],
    [sectionTitles.durable_candidates, durableCandidateEntries],
  ];

  let sourceLine = null;
  let written = false;
  let itemCount = 0;
  const writtenSections = [];
  for (const [sectionHeading, entries] of sections) {
    if (!Array.isArray(entries) || entries.length === 0) continue;
    const results = writeCheckpointSection({
      filePath,
      title,
      sectionHeading,
      entries,
      scope,
      allowedRoot: memoryRoot,
    });
    if (results.length === 0) continue;
    itemCount += results.length;
    writtenSections.push(sectionHeading);
    for (const result of results) {
      if (sourceLine == null && Number.isFinite(Number(result?.line))) {
        sourceLine = Number(result.line);
      }
      written = written || result?.written === true;
    }
  }

  return {
    written,
    source_path: filePath,
    source_line: sourceLine,
    source_kind: 'daily_note',
    section: sectionTitles.summary,
    written_sections: writtenSections,
    item_count: itemCount,
  };
};

const writeNativeMemoryEntry = ({
  config,
  memoryId = '',
  type = 'CONTEXT',
  content = '',
  durable = false,
  timestamp = new Date().toISOString(),
  scope = '',
} = {}) => {
  const note = String(content || '').trim();
  if (!note) {
    return {
      written: false,
      source_path: '',
      source_line: null,
      source_kind: durable ? 'memory_md' : 'daily_note',
    };
  }

  const dateKey = String(timestamp).slice(0, 10) || new Date().toISOString().slice(0, 10);
  const memoryRoot = String(config?.runtime?.paths?.memoryRoot || '').trim();
  const memoryMdPath = String(config?.native?.memoryMdPath || '').trim();

  // Validate paths to prevent path traversal
  if (!memoryRoot) {
    throw new Error('memoryRoot is required');
  }
  if (durable && !memoryMdPath) {
    throw new Error('memoryMdPath is required for durable entries');
  }

  // Validate dateKey is a safe filename (YYYY-MM-DD format)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) {
    throw new Error('Invalid date format for memory entry filename');
  }

  const filePath = durable
    ? memoryMdPath
    : path.join(memoryRoot, `${dateKey}.md`);
  const sectionHeading = headingForType(type, durable);
  const bulletContent = memoryId
    ? `[m:${memoryId}] ${note}`
    : note;
  const title = durable ? 'MEMORY' : dateKey;
  const result = appendSectionAndBullet({
    filePath,
    title,
    sectionHeading,
    bulletLine: `- ${appendScopeComment(bulletContent, scope)}`,
    content: note,
    scope,
  }, memoryRoot);

  return {
    written: result.written,
    source_path: filePath,
    source_line: result.line,
    source_kind: durable ? 'memory_md' : 'daily_note',
    section: sectionHeading,
  };
};

export {
  headingForType,
  writeNativeMemoryEntry,
  writeNativeSessionCheckpoint,
  normalizeCheckpointSurface,
};
