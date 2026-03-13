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

const CHECKPOINT_SECTION_TITLES = Object.freeze({
  summary: 'Codex App Sessions',
  decisions: 'Decisions',
  open_loops: 'Open Loops',
  touched_files: 'Touched Files',
  durable_candidates: 'Durable Candidates',
});

const MEMORY_LINK_RE = /\[m:[0-9a-f-]{8,}\]\s*/ig;
const BULLET_RE = /^\s*(?:[-*]|\d+\.)\s+(.+?)\s*$/;
const SCOPE_COMMENT_RE = /\s*<!--\s*gigabrain:scope=([^\s>]+)\s*-->\s*$/i;

const ensureDir = (dirPath) => {
  fs.mkdirSync(dirPath, { recursive: true });
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

const appendSectionAndBullet = ({ filePath, title, sectionHeading, bulletLine, content, scope = '' }) => {
  ensureDir(path.dirname(filePath));
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
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
    }));
  }
  return results;
};

const writeNativeSessionCheckpoint = ({
  config,
  timestamp = new Date().toISOString(),
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
  const filePath = path.join(memoryRoot, `${dateKey}.md`);
  const title = dateKey;

  const normalizedSummary = String(summary || '').replace(/\s+/g, ' ').trim();
  const normalizedLabel = String(sessionLabel || '').replace(/\s+/g, ' ').trim();
  const summaryEntries = normalizedSummary
    ? [normalizedLabel ? `Codex App session (${normalizedLabel}): ${normalizedSummary}` : `Codex App session: ${normalizedSummary}`]
    : [];
  const decisionEntries = normalizeCheckpointItems(decisions).map((item) => prefixCheckpointItem('Decision', item));
  const openLoopEntries = normalizeCheckpointItems(openLoops).map((item) => prefixCheckpointItem('Open loop', item));
  const touchedFileEntries = normalizeCheckpointItems(touchedFiles).map((item) => prefixCheckpointItem('Touched file', item));
  const durableCandidateEntries = normalizeCheckpointItems(durableCandidates);

  const sections = [
    [CHECKPOINT_SECTION_TITLES.summary, summaryEntries],
    [CHECKPOINT_SECTION_TITLES.decisions, decisionEntries],
    [CHECKPOINT_SECTION_TITLES.open_loops, openLoopEntries],
    [CHECKPOINT_SECTION_TITLES.touched_files, touchedFileEntries],
    [CHECKPOINT_SECTION_TITLES.durable_candidates, durableCandidateEntries],
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
    section: CHECKPOINT_SECTION_TITLES.summary,
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
  });

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
};
