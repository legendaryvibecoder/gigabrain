#!/usr/bin/env node
/**
 * vault-export.js — Export active memories from registry.sqlite to vault markdown files.
 *
 * Usage:
 *   node scripts/vault-export.js [--db <path>] [--vault <path>] [--dry-run] [--clean]
 *
 * Flags:
 *   --db     Path to registry.sqlite  (default: ~/.openclaw/gigabrain/memory/registry.sqlite)
 *   --vault  Path to vault directory   (default: ~/.openclaw/gigabrain/vault/)
 *   --dry-run  Print stats without writing files
 *   --clean    Remove stale vault files whose memory_id is no longer active
 */

import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../lib/core/sqlite.js';

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);

const readFlag = (name, fallback) => {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1] && !String(args[idx + 1]).startsWith('--')) return args[idx + 1];
  const withEq = args.find((a) => String(a).startsWith(`${name}=`));
  if (withEq) return withEq.split('=').slice(1).join('=');
  return fallback;
};

const hasFlag = (name) => args.includes(name);

const DB_PATH = readFlag('--db', `${process.env.HOME}/.openclaw/gigabrain/memory/registry.sqlite`);
const VAULT_DIR = readFlag('--vault', `${process.env.HOME}/.openclaw/gigabrain/vault/`);
const DRY_RUN = hasFlag('--dry-run');
const CLEAN = hasFlag('--clean');

// ---------------------------------------------------------------------------
// Type -> category mapping
// ---------------------------------------------------------------------------
const TYPE_TO_CATEGORY = {
  USER_FACT: 'facts',
  DECISION: 'decisions',
  PREFERENCE: 'preferences',
  CONTEXT: 'context',
  ENTITY: 'people',
  EPISODE: 'context',
  AGENT_IDENTITY: 'context',
};

const CATEGORIES = [...new Set(Object.values(TYPE_TO_CATEGORY))];

// ---------------------------------------------------------------------------
// Slug generation: first ~60 chars of content, lowercased, cleaned
// ---------------------------------------------------------------------------
const slugify = (text, maxLen = 80) => {
  let slug = text
    .replace(/\n/g, ' ')           // newlines to spaces
    .slice(0, maxLen)               // truncate
    .toLowerCase()
    .replace(/[äÄ]/g, 'ae')
    .replace(/[öÖ]/g, 'oe')
    .replace(/[üÜ]/g, 'ue')
    .replace(/[ß]/g, 'ss')
    .replace(/[éè]/g, 'e')
    .replace(/[àá]/g, 'a')
    .replace(/[^a-z0-9\s-]/g, '')  // remove special chars
    .trim()
    .replace(/\s+/g, '-')          // spaces to hyphens
    .replace(/-+/g, '-')           // collapse multiple hyphens
    .replace(/^-|-$/g, '');         // trim leading/trailing hyphens
  // ensure minimum length
  if (slug.length < 3) slug = 'note-' + slug;
  return slug;
};

// ---------------------------------------------------------------------------
// YAML frontmatter helper
// ---------------------------------------------------------------------------
const yamlValue = (val) => {
  if (val === null || val === undefined || val === '') return '""';
  const s = String(val);
  // Quote strings that contain special YAML chars or start with special chars
  if (/[:#\[\]{}&*!|>'"`,@%]/.test(s) || /^\s/.test(s) || /\s$/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
};

// ---------------------------------------------------------------------------
// Build markdown content for a memory
// ---------------------------------------------------------------------------
const buildMarkdown = (mem) => {
  const category = TYPE_TO_CATEGORY[mem.type] || 'context';
  const title = (mem.content || '').split('\n')[0].slice(0, 120) || '(untitled)';
  const dateStr = mem.created_at ? mem.created_at.slice(0, 10) : new Date().toISOString().slice(0, 10);

  const lines = [
    '---',
    `title: ${yamlValue(title)}`,
    `date: ${dateStr}`,
    `category: ${category}`,
    `memoryType: ${mem.type}`,
    `confidence: ${mem.confidence ?? 0.6}`,
    `source: ${yamlValue(mem.source || 'capture')}`,
    `sourceAgent: ${yamlValue(mem.source_agent || '')}`,
    `status: active`,
    `memoryId: ${yamlValue(mem.memory_id)}`,
    `scope: ${yamlValue(mem.scope || 'shared')}`,
    '---',
    '',
    (mem.content || '').trim(),
    '',
  ];
  return { markdown: lines.join('\n'), category, title, dateStr };
};

// ---------------------------------------------------------------------------
// Main export logic
// ---------------------------------------------------------------------------
const main = () => {
  console.log(`vault-export: db=${DB_PATH}`);
  console.log(`vault-export: vault=${VAULT_DIR}`);
  console.log(`vault-export: dry-run=${DRY_RUN}, clean=${CLEAN}`);

  if (!fs.existsSync(DB_PATH)) {
    console.error(`ERROR: database not found: ${DB_PATH}`);
    process.exit(1);
  }

  const db = openDatabase(DB_PATH, { readOnly: true });
  let rows;
  try {
    rows = db.prepare(`
      SELECT memory_id, type, content, source, source_agent, confidence,
             scope, status, created_at, tags
      FROM memory_current
      WHERE status = 'active'
      ORDER BY type, created_at
    `).all();
  } finally {
    db.close();
  }

  console.log(`vault-export: ${rows.length} active memories loaded`);

  if (DRY_RUN) {
    const byType = {};
    for (const r of rows) {
      byType[r.type] = (byType[r.type] || 0) + 1;
    }
    console.log('vault-export: breakdown by type:');
    for (const [t, c] of Object.entries(byType).sort()) {
      console.log(`  ${t}: ${c}`);
    }
    console.log('vault-export: dry-run complete, no files written');
    return;
  }

  // Ensure category directories exist
  for (const cat of CATEGORIES) {
    const dir = path.join(VAULT_DIR, cat);
    fs.mkdirSync(dir, { recursive: true });
  }

  // Track: memoryId -> filename (for dedup detection & clean pass)
  const exportedFiles = new Map();  // filename -> true
  const memoryIdToFile = new Map(); // memoryId -> filename
  // Track slugs per category to handle collisions
  const slugCounters = new Map();   // "category/slug" -> count

  let written = 0;
  let skipped = 0;

  for (const mem of rows) {
    const { markdown, category, title, dateStr } = buildMarkdown(mem);
    let baseSlug = slugify(mem.content || 'untitled');
    
    // Handle slug collisions within same category
    const slugKey = `${category}/${baseSlug}`;
    const prevCount = slugCounters.get(slugKey) || 0;
    slugCounters.set(slugKey, prevCount + 1);
    const slug = prevCount > 0 ? `${baseSlug}-${prevCount}` : baseSlug;

    const filename = `${slug}.md`;
    const filePath = path.join(VAULT_DIR, category, filename);

    fs.writeFileSync(filePath, markdown, 'utf8');
    exportedFiles.set(path.join(category, filename), true);
    memoryIdToFile.set(mem.memory_id, path.join(category, filename));
    written++;
  }

  console.log(`vault-export: ${written} files written, ${skipped} skipped`);

  // Clean pass: remove .md files in category dirs that are not in exportedFiles
  if (CLEAN) {
    let removed = 0;
    for (const cat of CATEGORIES) {
      const dir = path.join(VAULT_DIR, cat);
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
      for (const f of files) {
        const relPath = path.join(cat, f);
        if (!exportedFiles.has(relPath)) {
          fs.unlinkSync(path.join(dir, f));
          removed++;
        }
      }
    }
    console.log(`vault-export: clean pass removed ${removed} stale files`);
  }

  // Generate vault-index.md
  const indexLines = [
    '# Vault Index',
    `_Updated: ${new Date().toISOString()}_`,
    `_Total: ${written} notes_`,
    '',
    '| Note | Category | Type | Confidence |',
    '|------|----------|------|------------|',
  ];

  for (const mem of rows) {
    const category = TYPE_TO_CATEGORY[mem.type] || 'context';
    const relPath = memoryIdToFile.get(mem.memory_id);
    if (!relPath) continue;
    const noteLink = relPath.replace(/\.md$/, '');
    const conf = mem.confidence ?? 0.6;
    indexLines.push(`| [[${noteLink}]] | ${category} | ${mem.type} | ${conf} |`);
  }
  indexLines.push('');

  const indexPath = path.join(VAULT_DIR, 'vault-index.md');
  fs.writeFileSync(indexPath, indexLines.join('\n'), 'utf8');
  console.log(`vault-export: vault-index.md updated (${rows.length} entries)`);

  console.log('vault-export: done');
};

main();
