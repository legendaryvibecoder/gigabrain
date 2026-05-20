import fs from 'node:fs';
import path from 'node:path';

import { ensureProjectionStore, listCurrentMemories, normalizeProjectionScope } from './projection-store.js';
import { expandMemorySourceLinks, getSyncStatus, hasSecretRisk, listMemorySources, redactMemoryText } from './host-memory-sync.js';
import { ensureWorldModelStore, listContradictions } from './world-model.js';

const PASSPORT_TARGETS = [
  {
    key: 'agents',
    label: 'AGENTS.md',
    fileName: 'AGENTS.memory-brief.md',
    heading: '# AGENTS.md Memory Brief',
  },
  {
    key: 'claude_code',
    label: 'CLAUDE.md',
    fileName: 'CLAUDE.memory-brief.md',
    heading: '# CLAUDE.md Memory Brief',
  },
  {
    key: 'chatgpt_manual',
    label: 'ChatGPT manual import',
    fileName: 'ChatGPT.memory-brief.md',
    heading: '# ChatGPT Memory Brief',
  },
  {
    key: 'claude_manual',
    label: 'Claude.ai manual import',
    fileName: 'Claude.memory-brief.md',
    heading: '# Claude.ai Memory Brief',
  },
  {
    key: 'gemini_manual',
    label: 'Gemini manual import',
    fileName: 'Gemini.memory-brief.md',
    heading: '# Gemini Memory Brief',
  },
  {
    key: 'copilot_manual',
    label: 'Copilot manual import',
    fileName: 'Copilot.memory-brief.md',
    heading: '# Copilot Memory Brief',
  },
];

const asNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const clamp = (value, min, max, fallback) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
};

const isoOrEmpty = (value = '') => {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) return '';
  return new Date(parsed).toISOString();
};

const redactedPreview = (value = '', maxLength = 180) => {
  const redacted = redactMemoryText(value).replace(/\s+/g, ' ').trim();
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
};

const escapeHtml = (value = '') => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const markdownTable = (headers = [], rows = []) => {
  if (!rows.length) return '_None._\n';
  const clean = (value) => String(value ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
  return [
    `| ${headers.map(clean).join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(clean).join(' | ')} |`),
    '',
  ].join('\n');
};

const countBy = (rows = [], key) => {
  const out = {};
  for (const row of rows) {
    const value = String(typeof key === 'function' ? key(row) : row?.[key] || 'unknown');
    out[value] = (out[value] || 0) + 1;
  }
  return out;
};

const detectDuplicateGroups = (db, { scope = '', limit = 25 } = {}) => {
  const where = ['status = ?'];
  const params = ['active'];
  if (scope) {
    where.push('scope = ?');
    params.push(scope);
  }
  const rows = db.prepare(`
    SELECT normalized_hash, scope, COUNT(*) AS count, MAX(updated_at) AS latest_at
    FROM memory_current
    WHERE ${where.join(' AND ')}
      AND COALESCE(normalized_hash, '') <> ''
    GROUP BY normalized_hash, scope
    HAVING COUNT(*) > 1
    ORDER BY count DESC, latest_at DESC
    LIMIT ?
  `).all(...params, limit);
  return rows.map((row) => {
    const members = db.prepare(`
      SELECT memory_id, source_host, source_kind, source_path, source_line, content, updated_at
      FROM memory_current
      WHERE normalized_hash = ? AND scope = ? AND status = 'active'
      ORDER BY updated_at DESC
      LIMIT 8
    `).all(row.normalized_hash, row.scope).map((member) => ({
      memory_id: member.memory_id,
      source_host: member.source_host || 'gigabrain',
      source_kind: member.source_kind || 'registry',
      source_path: member.source_path || '',
      source_line: member.source_line || null,
      updated_at: member.updated_at || '',
      preview: redactedPreview(member.content),
      links: expandMemorySourceLinks(db, member.memory_id),
    }));
    return {
      normalized_hash: row.normalized_hash,
      scope: row.scope,
      count: asNumber(row.count),
      latest_at: row.latest_at || '',
      preview: members[0]?.preview || '',
      members,
    };
  });
};

const detectStaleMemories = (rows = [], { staleDays = 180, now = new Date(), limit = 50 } = {}) => {
  const cutoffMs = now.getTime() - (Math.max(1, staleDays) * 24 * 60 * 60 * 1000);
  const rowLimit = clamp(limit, 1, 200, 50);
  return rows
    .map((row) => {
      const updatedAtMs = Date.parse(String(row.updated_at || row.created_at || ''));
      const validUntilMs = Date.parse(String(row.valid_until || ''));
      const reasons = [];
      if (Number.isFinite(updatedAtMs) && updatedAtMs < cutoffMs) reasons.push(`not updated in ${staleDays}+ days`);
      if (Number.isFinite(validUntilMs) && validUntilMs < now.getTime()) reasons.push('valid_until is in the past');
      return {
        memory_id: row.memory_id,
        scope: row.scope,
        source_host: row.source_host || 'gigabrain',
        updated_at: row.updated_at || '',
        valid_until: row.valid_until || '',
        reasons,
        preview: redactedPreview(row.content),
      };
    })
    .filter((row) => row.reasons.length > 0)
    .sort((a, b) => String(a.updated_at || '').localeCompare(String(b.updated_at || '')))
    .slice(0, rowLimit);
};

const detectProvenanceGaps = (db, rows = [], { limit = 50 } = {}) => {
  const rowLimit = clamp(limit, 1, 200, 50);
  return rows.map((row) => {
    const links = expandMemorySourceLinks(db, row.memory_id);
    const sourceHost = String(row.source_host || '').trim();
    const sourcePath = String(row.source_path || '').trim();
    const weakHost = !sourceHost || sourceHost === 'gigabrain';
    const weakPath = !sourcePath && links.length === 0;
    if (!weakHost && !weakPath) return null;
    return {
      memory_id: row.memory_id,
      scope: row.scope,
      source_host: sourceHost || 'unknown',
      source_layer: row.source_layer || 'registry',
      source_path: sourcePath,
      link_count: links.length,
      preview: redactedPreview(row.content),
      reason: weakPath ? 'missing source path/provenance link' : 'registry-only source host',
    };
  })
    .filter(Boolean)
    .slice(0, rowLimit);
};

const detectSecretRisks = (rows = [], { limit = 50 } = {}) => rows
  .filter((row) => hasSecretRisk(row.content))
  .map((row) => ({
    memory_id: row.memory_id,
    scope: row.scope,
    source_host: row.source_host || 'gigabrain',
    source_path: row.source_path || '',
    source_line: row.source_line || null,
    preview: redactedPreview(row.content),
  }))
  .slice(0, clamp(limit, 1, 200, 50));

const loadContradictionRows = (db, { limit = 25 } = {}) => {
  try {
    ensureWorldModelStore(db);
    return listContradictions(db, { limit }).map((row) => ({
      loop_id: row.loop_id,
      title: row.title,
      status: row.status,
      priority: asNumber(row.priority),
      related_entity_id: row.related_entity_id || '',
      source_memory_ids: Array.isArray(row.source_memory_ids) ? row.source_memory_ids : [],
    }));
  } catch {
    return [];
  }
};

const selectSafeHandoffRows = (rows = [], { limit = 25 } = {}) => {
  const rowLimit = clamp(limit, 1, 100, 25);
  const selected = [];
  let omittedSecretRisks = 0;
  for (const row of rows) {
    if (hasSecretRisk(row.content)) {
      omittedSecretRisks += 1;
      continue;
    }
    if (selected.length < rowLimit) selected.push(row);
  }
  return {
    selected,
    omittedSecretRisks,
  };
};

const buildHandoffBrief = ({ heading, label, rows = [], scope = '', limit = 25 } = {}) => {
  const { selected, omittedSecretRisks } = selectSafeHandoffRows(rows, { limit });
  const lines = [
    heading,
    '',
    `Target: ${label}`,
    scope ? `Scope: ${scope}` : '',
    '',
    'Generated by Gigabrain for explicit user-controlled paste/import. Review before use. Closed cloud memory products are manual-only; Gigabrain does not scrape them or write to them directly.',
    '',
  ].filter((line, index, all) => line !== '' || all[index - 1] !== '');
  if (omittedSecretRisks > 0) {
    lines.push(`Safety: omitted ${omittedSecretRisks} secret-risk memory row${omittedSecretRisks === 1 ? '' : 's'} from this brief. Review the Passport Secret Risk Audit instead of pasting redacted secrets into another host.`);
    lines.push('');
  }
  lines.push('## Portable Memories');
  lines.push('');
  if (selected.length === 0) {
    lines.push('_No active memories matched this Passport scope._');
  } else {
    for (const row of selected) {
      const host = String(row.source_host || 'gigabrain');
      const kind = String(row.source_kind || 'registry');
      lines.push(`- [${host}/${kind}] ${redactedPreview(row.content, 280)}`);
    }
  }
  return `${lines.join('\n').trim()}\n`;
};

const buildHandoffs = ({ rows = [], scope = '', limit = 25 } = {}) => Object.fromEntries(
  PASSPORT_TARGETS.map((target) => {
    const { selected, omittedSecretRisks } = selectSafeHandoffRows(rows, { limit });
    return [target.key, {
      target: target.key,
      label: target.label,
      fileName: target.fileName,
      format: 'markdown',
      item_count: selected.length,
      omitted_secret_risks: omittedSecretRisks,
      brief: buildHandoffBrief({
        heading: target.heading,
        label: target.label,
        rows,
        scope,
        limit,
      }),
    }];
  }),
);

const plural = (count, singular, pluralValue = `${singular}s`) => `${count} ${count === 1 ? singular : pluralValue}`;

const buildReadiness = ({ sections = {}, syncStatus = {} } = {}) => {
  const counts = {
    duplicates: sections.duplicates?.length || 0,
    contradictions: sections.contradictions?.length || 0,
    stale: sections.stale?.length || 0,
    provenance_gaps: sections.provenance_gaps?.length || 0,
    secret_risks: sections.secret_risks?.length || 0,
  };
  const neverSynced = Array.isArray(syncStatus?.groups?.never_synced) ? syncStatus.groups.never_synced.length : 0;
  const score = Math.max(0, Math.min(100, Math.round(
    100
    - (counts.secret_risks * 20)
    - (counts.contradictions * 12)
    - (counts.provenance_gaps * 5)
    - (counts.duplicates * 4)
    - (counts.stale * 2)
    - Math.min(10, neverSynced),
  )));
  const blockers = [];
  const nextActions = [];
  if (counts.secret_risks > 0) {
    blockers.push(`${plural(counts.secret_risks, 'secret-risk row')} must be removed, rotated, or explicitly accepted before public sharing.`);
  }
  if (counts.contradictions > 0) nextActions.push(`Resolve ${plural(counts.contradictions, 'contradiction')} before using handoffs as canonical memory.`);
  if (counts.provenance_gaps > 0) nextActions.push(`Backfill provenance for ${plural(counts.provenance_gaps, 'memory', 'memories')} with weak source links.`);
  if (counts.duplicates > 0) nextActions.push(`Review ${plural(counts.duplicates, 'duplicate group')} and keep the strongest canonical row.`);
  if (counts.stale > 0) nextActions.push(`Refresh or archive ${plural(counts.stale, 'stale memory', 'stale memories')}.`);
  if (neverSynced > 0) nextActions.push(`${plural(neverSynced, 'host')} has not synced yet; run sync-hosts for the surfaces you use.`);

  const status = blockers.length > 0 ? 'blocked' : score >= 90 ? 'ready' : score >= 70 ? 'needs_review' : 'blocked';
  const headline = status === 'ready'
    ? 'Ready to share after normal human review.'
    : status === 'needs_review'
      ? 'Usable for internal review, but cleanup is recommended before launch.'
      : 'Blocked for public or cross-host handoff until the listed risks are handled.';
  return {
    status,
    score,
    headline,
    blockers,
    next_actions: nextActions,
  };
};

const buildPassportMarkdown = (passport) => {
  const counts = passport.summary.counts;
  const sectionCounts = passport.summary.section_counts;
  const lines = [
    '# Gigabrain Memory Passport',
    '',
    `Generated: ${passport.generated_at}`,
    `Scope: ${passport.scope || 'all scopes'}`,
    '',
    '## Launch Position',
    '',
    'Gigabrain is the local-first Memory Passport and control plane for AI agents. It inventories host memories, audits trust risks, and produces safe handoff briefs while keeping the cross-memory bus as internal architecture.',
    '',
    '## Summary',
    '',
    `- Active memories: ${counts.active}`,
    `- Total memories: ${counts.total}`,
    `- Source hosts with synced provenance: ${counts.source_hosts}`,
    `- Duplicate groups: ${sectionCounts.duplicates}`,
    `- Contradictions: ${sectionCounts.contradictions}`,
    `- Stale memories: ${sectionCounts.stale}`,
    `- Provenance gaps: ${sectionCounts.provenance_gaps}`,
    `- Secret risks: ${sectionCounts.secret_risks}`,
    '',
    '## Readiness Verdict',
    '',
    `- Status: ${passport.readiness.status}`,
    `- Score: ${passport.readiness.score}/100`,
    `- Headline: ${passport.readiness.headline}`,
    ...(passport.readiness.blockers.length > 0 ? passport.readiness.blockers.map((item) => `- Blocker: ${item}`) : ['- Blocker: none']),
    ...(passport.readiness.next_actions.length > 0 ? passport.readiness.next_actions.map((item) => `- Next action: ${item}`) : ['- Next action: none']),
    '',
    '## Source Inventory',
    '',
    markdownTable(
      ['Host', 'Kind', 'Policy', 'Memories', 'Last seen', 'Path'],
      passport.sources.sources.map((row) => [
        row.source_host,
        row.source_kind,
        row.sync_policy,
        row.memory_count,
        row.last_seen_at || '',
        row.source_path || '',
      ]),
    ),
    '## Host Readiness',
    '',
    markdownTable(
      ['Host', 'Status', 'Local sources', 'Last sync', 'Policy', 'Error'],
      passport.sync_status.hosts.map((row) => [
        row.source_host,
        row.status,
        row.local_sources_detected,
        row.last_sync_at || '',
        row.sync_policy,
        row.error || '',
      ]),
    ),
    '## Dedupe Audit',
    '',
    markdownTable(
      ['Scope', 'Count', 'Latest', 'Preview'],
      passport.sections.duplicates.map((row) => [row.scope, row.count, row.latest_at || '', row.preview]),
    ),
    '## Contradiction Audit',
    '',
    markdownTable(
      ['Status', 'Priority', 'Title', 'Sources'],
      passport.sections.contradictions.map((row) => [
        row.status,
        row.priority,
        row.title,
        row.source_memory_ids.join(', '),
      ]),
    ),
    '## Stale Memory Audit',
    '',
    markdownTable(
      ['Memory', 'Scope', 'Updated', 'Valid until', 'Reason', 'Preview'],
      passport.sections.stale.map((row) => [
        row.memory_id,
        row.scope,
        row.updated_at || '',
        row.valid_until || '',
        row.reasons.join('; '),
        row.preview,
      ]),
    ),
    '## Provenance Audit',
    '',
    markdownTable(
      ['Memory', 'Scope', 'Source', 'Links', 'Reason', 'Preview'],
      passport.sections.provenance_gaps.map((row) => [
        row.memory_id,
        row.scope,
        row.source_host,
        row.link_count,
        row.reason,
        row.preview,
      ]),
    ),
    '## Secret Risk Audit',
    '',
    markdownTable(
      ['Memory', 'Scope', 'Source', 'Path', 'Preview'],
      passport.sections.secret_risks.map((row) => [
        row.memory_id,
        row.scope,
        row.source_host,
        row.source_path || '',
        row.preview,
      ]),
    ),
    '## Handoff Briefs',
    '',
    markdownTable(
      ['Target', 'File'],
      Object.values(passport.handoffs).map((handoff) => [handoff.label, handoff.fileName]),
    ),
  ];
  return `${lines.join('\n').trim()}\n`;
};

const buildPassportHtml = (passport) => {
  const markdown = buildPassportMarkdown(passport);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gigabrain Memory Passport</title>
  <style>
    :root { color-scheme: light; --ink: #172026; --muted: #5d6871; --line: #d9e1e7; --panel: #f7fafc; --accent: #1f7a68; --risk: #9a3412; }
    body { margin: 0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--ink); background: #ffffff; }
    main { max-width: 1120px; margin: 0 auto; padding: 40px 24px 64px; }
    h1 { font-size: 40px; line-height: 1.05; margin: 0 0 8px; letter-spacing: 0; }
    h2 { font-size: 22px; margin: 34px 0 12px; letter-spacing: 0; }
    p, li { color: var(--muted); line-height: 1.55; }
    .meta { color: var(--muted); margin-bottom: 24px; }
    .summary { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin: 24px 0; }
    .metric { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: var(--panel); }
    .metric strong { display: block; font-size: 24px; }
    table { width: 100%; border-collapse: collapse; font-size: 14px; }
    th, td { border-bottom: 1px solid var(--line); padding: 9px 8px; text-align: left; vertical-align: top; }
    th { color: var(--muted); font-weight: 650; }
    code { overflow-wrap: anywhere; }
    .risk { color: var(--risk); }
    pre { white-space: pre-wrap; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); padding: 16px; overflow: auto; }
  </style>
</head>
<body>
  <main>
    <h1>Gigabrain Memory Passport</h1>
    <div class="meta">Generated ${escapeHtml(passport.generated_at)} · Scope ${escapeHtml(passport.scope || 'all scopes')}</div>
    <p>Local-first Memory Passport and control plane for AI agents. Source inventory, audit findings, and handoff briefs are generated from the local Gigabrain registry.</p>
    <section class="summary">
      ${Object.entries({
    'Active memories': passport.summary.counts.active,
    'Source hosts': passport.summary.counts.source_hosts,
    'Duplicates': passport.summary.section_counts.duplicates,
    'Contradictions': passport.summary.section_counts.contradictions,
    'Stale': passport.summary.section_counts.stale,
    'Secret risks': passport.summary.section_counts.secret_risks,
    [`Readiness: ${passport.readiness.status}`]: `${passport.readiness.score}/100`,
  }).map(([label, value]) => `<div class="metric"><strong>${escapeHtml(value)}</strong>${escapeHtml(label)}</div>`).join('\n      ')}
    </section>
    <h2>Report</h2>
    <pre>${escapeHtml(markdown)}</pre>
  </main>
</body>
</html>
`;
};

const buildMemoryPassport = ({
  db,
  config = {},
  scope = '',
  includeDiscovery = true,
  staleDays = 180,
  limit = 50,
  handoffLimit = 25,
  ...hostOptions
} = {}) => {
  if (!db) throw new Error('buildMemoryPassport requires db');
  ensureProjectionStore(db);
  const normalizedScope = normalizeProjectionScope(scope || '', { allowEmpty: true });
  const rows = listCurrentMemories(db, {
    statuses: ['active'],
    scope: normalizedScope,
    limit: 10000,
  });
  const totalRow = db.prepare('SELECT COUNT(*) AS c FROM memory_current').get();
  const activeRow = db.prepare("SELECT COUNT(*) AS c FROM memory_current WHERE status = 'active'").get();
  const sources = listMemorySources({
    db,
    config,
    includeDiscovery,
    ...hostOptions,
  });
  const syncStatus = getSyncStatus({
    db,
    config,
    ...hostOptions,
  });
  const sectionLimit = clamp(limit, 1, 200, 50);
  const sections = {
    duplicates: detectDuplicateGroups(db, { scope: normalizedScope, limit: sectionLimit }),
    contradictions: loadContradictionRows(db, { limit: sectionLimit }),
    stale: detectStaleMemories(rows, { staleDays, limit: sectionLimit }),
    provenance_gaps: detectProvenanceGaps(db, rows, { limit: sectionLimit }),
    secret_risks: detectSecretRisks(rows, { limit: sectionLimit }),
  };
  const sourceHosts = new Set(sources.sources.map((row) => String(row.source_host || '')).filter(Boolean));
  const passport = {
    ok: true,
    generated_at: new Date().toISOString(),
    product: {
      name: 'Gigabrain Memory Passport',
      positioning: 'Local-first Memory Passport/control plane for AI agents',
      architecture: 'Cross-memory bus with read-only local adapters and manual cloud handoffs',
    },
    scope: normalizedScope,
    summary: {
      counts: {
        total: asNumber(totalRow?.c),
        active: asNumber(activeRow?.c),
        scoped_active: rows.length,
        source_hosts: sourceHosts.size,
        by_scope: countBy(rows, 'scope'),
        by_type: countBy(rows, 'type'),
        by_source_host: countBy(rows, (row) => row.source_host || 'gigabrain'),
      },
      section_counts: {
        duplicates: sections.duplicates.length,
        contradictions: sections.contradictions.length,
        stale: sections.stale.length,
        provenance_gaps: sections.provenance_gaps.length,
        secret_risks: sections.secret_risks.length,
      },
    },
    sources,
    sync_status: syncStatus,
    sections,
    readiness: buildReadiness({ sections, syncStatus }),
    handoffs: buildHandoffs({
      rows,
      scope: normalizedScope,
      limit: handoffLimit,
    }),
  };
  passport.markdown = buildPassportMarkdown(passport);
  passport.html = buildPassportHtml(passport);
  return passport;
};

const normalizeFormats = (formats = []) => {
  const list = Array.isArray(formats) ? formats : String(formats || '').split(',');
  const normalized = list.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean);
  if (normalized.length === 0 || normalized.includes('all')) return new Set(['markdown', 'html', 'json', 'handoffs']);
  return new Set(normalized);
};

const writeMemoryPassport = (passport, { outputDir, formats = ['all'], includeHandoffs = true } = {}) => {
  if (!outputDir) throw new Error('writeMemoryPassport requires outputDir');
  const selected = normalizeFormats(formats);
  fs.mkdirSync(outputDir, { recursive: true });
  const files = {};
  if (selected.has('markdown') || selected.has('md')) {
    const filePath = path.join(outputDir, 'memory-passport.md');
    fs.writeFileSync(filePath, passport.markdown, 'utf8');
    files.markdown = filePath;
  }
  if (selected.has('html')) {
    const filePath = path.join(outputDir, 'memory-passport.html');
    fs.writeFileSync(filePath, passport.html, 'utf8');
    files.html = filePath;
  }
  if (selected.has('json')) {
    const filePath = path.join(outputDir, 'memory-passport.json');
    const { markdown, html, ...serializable } = passport;
    fs.writeFileSync(filePath, JSON.stringify(serializable, null, 2), 'utf8');
    files.json = filePath;
  }
  if (includeHandoffs && selected.has('handoffs')) {
    const handoffDir = path.join(outputDir, 'handoffs');
    fs.mkdirSync(handoffDir, { recursive: true });
    files.handoffs = {};
    for (const handoff of Object.values(passport.handoffs)) {
      const filePath = path.join(handoffDir, handoff.fileName);
      fs.writeFileSync(filePath, handoff.brief, 'utf8');
      files.handoffs[handoff.target] = filePath;
    }
  }
  return files;
};

export {
  PASSPORT_TARGETS,
  buildMemoryPassport,
  buildPassportHtml,
  buildPassportMarkdown,
  detectSecretRisks,
  redactedPreview,
  writeMemoryPassport,
};
