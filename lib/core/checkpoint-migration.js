import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  appendCheckpointEpisode,
  ensureControlPlaneStore,
} from './control-plane.js';
import { readRegularFileWithStatNoFollowSync } from './safe-fs.js';

const DAILY_NOTE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
const HEADING_RE = /^\s*##\s+(.+?)\s*$/;
const BULLET_RE = /^\s*(?:[-*]|\d+\.)\s+(.+?)\s*$/;
const SCOPE_COMMENT_RE = /\s*<!--\s*gigabrain:scope=([^\s>]+)\s*-->\s*$/i;
const MAX_LEGACY_FILE_BYTES = 5 * 1024 * 1024;

const SECTION_KINDS = new Map([
  ['decisions', 'decision'],
  ['open loops', 'open_loop'],
  ['touched files', 'touched_file'],
  ['durable candidates', 'durable_candidate'],
]);

const SUMMARY_SURFACES = new Map([
  ['codex app sessions', 'codex'],
  ['claude sessions', 'claude_code'],
  ['openclaw sessions', 'openclaw'],
  ['agent sessions', 'agent'],
]);

const normalizeText = (value = '') => String(value || '').replace(/\s+/g, ' ').trim();
const sha256 = (value = '') => createHash('sha256').update(String(value || '')).digest('hex');

const stripScopeComment = (value = '') => {
  const raw = String(value || '');
  const match = raw.match(SCOPE_COMMENT_RE);
  return {
    scope: normalizeText(match?.[1]),
    text: normalizeText(raw.replace(SCOPE_COMMENT_RE, '')),
  };
};

const stripLegacyPrefix = (kind, value = '') => {
  const text = normalizeText(value);
  if (kind === 'decision') return normalizeText(text.replace(/^Decision:\s*/i, ''));
  if (kind === 'open_loop') return normalizeText(text.replace(/^Open loop:\s*/i, ''));
  if (kind === 'touched_file') return normalizeText(text.replace(/^Touched file:\s*/i, ''));
  return text;
};

const sourceAgentForSurfaces = (surfaces = []) => {
  const unique = Array.from(new Set(surfaces.filter(Boolean)));
  if (unique.length === 1) return unique[0];
  if (unique.length > 1) return 'legacy_multi_agent';
  return 'legacy_import';
};

const parseLegacyCheckpointMarkdown = (text = '', options = {}) => {
  const defaultScope = normalizeText(options.defaultScope) || 'project:workspace';
  const entries = [];
  let section = null;
  let sawCheckpointSummary = false;
  const lines = String(text || '').replace(/\r/g, '').split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = line.match(HEADING_RE);
    if (heading) {
      const title = normalizeText(heading[1]).toLowerCase();
      if (SUMMARY_SURFACES.has(title)) {
        section = { kind: 'summary', surface: SUMMARY_SURFACES.get(title) };
        sawCheckpointSummary = true;
      } else if (SECTION_KINDS.has(title)) {
        section = { kind: SECTION_KINDS.get(title), surface: '' };
      } else {
        section = null;
      }
      continue;
    }
    if (!section) continue;
    const bullet = line.match(BULLET_RE);
    if (!bullet) continue;
    const scoped = stripScopeComment(bullet[1]);
    const content = stripLegacyPrefix(section.kind, scoped.text);
    if (!content) continue;
    entries.push({
      kind: section.kind,
      surface: section.surface,
      scope: scoped.scope,
      content,
      line: index + 1,
    });
  }

  if (!sawCheckpointSummary) return [];
  const explicitSummaryScopes = Array.from(new Set(
    entries.filter((entry) => entry.kind === 'summary' && entry.scope).map((entry) => entry.scope),
  ));
  const unscopedFallback = explicitSummaryScopes.length === 1 ? explicitSummaryScopes[0] : defaultScope;
  const grouped = new Map();
  for (const entry of entries) {
    const scope = entry.scope || unscopedFallback;
    if (!grouped.has(scope)) grouped.set(scope, []);
    grouped.get(scope).push({ ...entry, scope });
  }

  return Array.from(grouped.entries()).map(([scope, scopedEntries]) => {
    const values = (kind) => scopedEntries.filter((entry) => entry.kind === kind).map((entry) => entry.content);
    const summaries = values('summary');
    return {
      scope,
      source_agent: sourceAgentForSurfaces(scopedEntries.map((entry) => entry.surface)),
      summary: summaries.length > 0 ? summaries.join(' | ') : 'Legacy checkpoint imported from a daily note.',
      decisions: values('decision'),
      open_loops: values('open_loop'),
      touched_files: values('touched_file'),
      durable_candidates: values('durable_candidate'),
      source_line: Math.min(...scopedEntries.map((entry) => entry.line)),
      entry_count: scopedEntries.length,
      grouping_ambiguous: summaries.length !== 1,
    };
  });
};

const tableExists = (db, tableName) => Boolean(db.prepare(`
  SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1
`).get(String(tableName || ''))?.present);

const confineLegacyFile = (memoryRoot, filePath) => {
  const lstat = fs.lstatSync(filePath);
  if (!lstat.isFile() || lstat.isSymbolicLink()) return false;
  const realRoot = fs.realpathSync(memoryRoot);
  const realFile = fs.realpathSync(filePath);
  const relative = path.relative(realRoot, realFile);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const migrateLegacyCheckpoints = (db, options = {}) => {
  const memoryRoot = path.resolve(String(options.memoryRoot || options.memory_root || ''));
  if (!String(options.memoryRoot || options.memory_root || '').trim()) throw new Error('memoryRoot is required');
  if (!fs.existsSync(memoryRoot) || !fs.statSync(memoryRoot).isDirectory()) {
    throw new Error('memoryRoot must be an existing directory');
  }
  const dryRun = options.dryRun === true || options.dry_run === true;
  const includeToday = options.includeToday === true || options.include_today === true;
  const today = normalizeText(options.today) || new Date().toISOString().slice(0, 10);
  const defaultScope = normalizeText(options.defaultScope || options.default_scope) || 'project:workspace';
  const controlPlaneExists = tableExists(db, 'memory_checkpoints');
  if (!dryRun) ensureControlPlaneStore(db);

  const summary = {
    ok: true,
    schema_version: 'checkpoint.1',
    migration: 'legacy_markdown.1',
    dry_run: dryRun,
    scanned_files: 0,
    checkpoint_files: 0,
    candidate_episodes: 0,
    imported: 0,
    would_import: 0,
    already_imported: 0,
    drifted_after_import: 0,
    skipped_current_day: 0,
    skipped_files: 0,
    proposals_created: 0,
    episodes: [],
  };

  const fileNames = fs.readdirSync(memoryRoot)
    .filter((name) => DAILY_NOTE_RE.test(name))
    .sort();
  for (const fileName of fileNames) {
    const dateKey = fileName.slice(0, 10);
    if (!includeToday && dateKey >= today) {
      summary.skipped_current_day += 1;
      continue;
    }
    const filePath = path.join(memoryRoot, fileName);
    let text;
    try {
      if (!confineLegacyFile(memoryRoot, filePath)) {
        summary.skipped_files += 1;
        continue;
      }
      text = readRegularFileWithStatNoFollowSync(filePath, 'utf8', {
        maxBytes: MAX_LEGACY_FILE_BYTES,
      }).data;
    } catch {
      summary.skipped_files += 1;
      continue;
    }
    summary.scanned_files += 1;
    const parsed = parseLegacyCheckpointMarkdown(text, { defaultScope });
    if (parsed.length === 0) continue;
    summary.checkpoint_files += 1;
    const sourceHash = `sha256:${sha256(text)}`;
    for (const [groupIndex, episode] of parsed.entries()) {
      summary.candidate_episodes += 1;
      // Identity belongs to the source episode, not its mutable scope. Using
      // the deterministic group ordinal lets a corrected legacy scope report
      // drift against the immutable import instead of creating a duplicate.
      const identityHash = sha256(`${fileName}\n${groupIndex}`).slice(0, 32);
      const checkpointId = `cp_legacy_${identityHash}`;
      const sessionId = `ses_legacy_${identityHash}`;
      let existing = null;
      if (controlPlaneExists || !dryRun) {
        existing = db.prepare('SELECT checkpoint_id, payload FROM memory_checkpoints WHERE checkpoint_id = ?').get(checkpointId);
      }
      if (existing) {
        summary.already_imported += 1;
        let payload = {};
        try { payload = JSON.parse(String(existing.payload || '{}')); } catch { payload = {}; }
        if (String(payload.source_content_hash || '') !== sourceHash) summary.drifted_after_import += 1;
        summary.episodes.push({ checkpoint_id: checkpointId, scope: episode.scope, source_file: fileName, status: 'already_imported' });
        continue;
      }
      if (dryRun) {
        summary.would_import += 1;
        summary.episodes.push({ checkpoint_id: checkpointId, scope: episode.scope, source_file: fileName, status: 'would_import' });
        continue;
      }
      appendCheckpointEpisode(db, {
        checkpointId,
        sessionId,
        createdAt: `${dateKey}T00:00:00.000Z`,
        scope: episode.scope,
        sourceAgent: episode.source_agent,
        sourceClient: 'legacy_markdown',
        sourceHost: 'legacy-import',
        repo: { root: '', branch: '', commit: '', dirty: false },
        summary: episode.summary,
        decisions: episode.decisions,
        openLoops: episode.open_loops,
        touchedFiles: episode.touched_files,
        durableCandidates: episode.durable_candidates,
        outcomeStatus: 'legacy_imported',
        sourcePath: filePath,
        sourceLine: episode.source_line,
        sourceKind: 'daily_note',
        legacyUntyped: true,
        createProposals: false,
        payload: {
          migration: 'legacy_markdown.1',
          timestamp_precision: 'day',
          grouping_ambiguous: episode.grouping_ambiguous,
          source_content_hash: sourceHash,
          source_group_index: groupIndex,
          entry_count: episode.entry_count,
          durable_candidates_are_unreviewed: true,
        },
      });
      summary.imported += 1;
      summary.episodes.push({ checkpoint_id: checkpointId, scope: episode.scope, source_file: fileName, status: 'imported' });
    }
  }
  return summary;
};

export {
  MAX_LEGACY_FILE_BYTES,
  parseLegacyCheckpointMarkdown,
  migrateLegacyCheckpoints,
};
