import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { ensureProjectionStore, upsertCurrentMemory } from '../lib/core/projection-store.js';
import { ensureEventStore } from '../lib/core/event-store.js';

const makeTempWorkspace = (prefix = 'gb-v3-test-') => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const workspace = path.join(root, 'workspace');
  const memoryRoot = path.join(workspace, 'memory');
  const outputRoot = path.join(workspace, 'output');
  fs.mkdirSync(memoryRoot, { recursive: true });
  fs.mkdirSync(outputRoot, { recursive: true });
  return {
    root,
    workspace,
    memoryRoot,
    outputRoot,
    dbPath: path.join(memoryRoot, 'registry.sqlite'),
    configPath: path.join(root, 'openclaw.json'),
  };
};

const seedMemoryCurrent = (db, rows = []) => {
  ensureProjectionStore(db);
  ensureEventStore(db);
  const nowIso = new Date().toISOString();
  for (const row of rows) {
    upsertCurrentMemory(db, {
      memory_id: row.memory_id || randomUUID(),
      type: row.type || 'CONTEXT',
      content: row.content || 'unknown',
      normalized: row.normalized || '',
      source: row.source || 'capture',
      source_agent: row.source_agent || 'main',
      source_session: row.source_session || 'sess',
      confidence: row.confidence ?? 0.6,
      scope: row.scope || 'shared',
      status: row.status || 'active',
      value_score: row.value_score ?? null,
      value_label: row.value_label || null,
      created_at: row.created_at || nowIso,
      updated_at: row.updated_at || nowIso,
      tags: row.tags || [],
      content_time: row.content_time || null,
      valid_until: row.valid_until || null,
    });
  }
};

const makeConfigObject = (workspace) => ({
  plugins: {
    entries: {
      gigabrain: {
        enabled: true,
        config: {
          enabled: true,
          runtime: {
            cleanupVersion: 'v3.0.0-test',
            paths: {
              workspaceRoot: workspace,
              memoryRoot: 'memory',
              outputDir: 'output',
              reviewQueuePath: 'output/memory-review-queue.jsonl',
            },
          },
          capture: {
            enabled: true,
            requireMemoryNote: true,
            minConfidence: 0.65,
            minContentChars: 25,
            queueOnModelUnavailable: true,
          },
          dedupe: {
            exactEnabled: true,
            semanticEnabled: true,
            autoThreshold: 0.92,
            reviewThreshold: 0.85,
            crossScopeGlobal: false,
          },
          recall: {
            topK: 8,
            minScore: 0.45,
            maxTokens: 1200,
            archiveFallbackEnabled: true,
            mode: 'hybrid',
            classBudgets: { core: 0.45, situational: 0.3, decisions: 0.25 },
          },
          quality: {
            mode: 'knowledge_rich',
            junkFilterEnabled: true,
            minContentChars: 25,
            junkPatternsAppend: [],
            junkPatternsReplace: false,
            highValueShortEnabled: true,
            highValueShortPatternsAppend: [],
            durableEnabled: true,
            durablePatternsAppend: [],
            valueThresholds: { keep: 0.75, archive: 0.45, reject: 0.45 },
          },
          llm: {
            provider: 'none',
            timeoutMs: 12000,
            review: {
              enabled: false,
              limit: 200,
              minScore: 0.24,
              maxScore: 0.52,
              minConfidence: 0.7,
            },
          },
          maintenance: {
            snapshotDir: 'memory/backups',
            eventsPath: 'output/memory-events.jsonl',
            usageLogPath: 'memory/usage-log.md',
            compactDays: 30,
            emergencyUnvacuumedDays: 7,
            maxEmergencyFiles: 1,
            vacuum: true,
          },
          native: {
            enabled: true,
            memoryMdPath: 'MEMORY.md',
            dailyNotesGlob: 'memory/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*.md',
            includeFiles: [
              'memory/latest.md',
              'memory/recent-changes.md',
              'memory/whois.md',
              'memory/pinned-core-people.md',
              'memory/pinned/core-people.md',
            ],
            excludeGlobs: [
              'memory/archive/**',
              'memory/debug/**',
              'memory/private/**',
              'memory/working.md',
              'memory/*-captured.md',
            ],
            syncMode: 'hybrid',
            maxChunkChars: 900,
            onDemandTemporalDays: 3650,
          },
          person: {
            keepPublicFacts: true,
            relationshipPriorityBoost: 0.35,
            publicProfileBoost: 0.1,
            requireWordBoundaryMatch: true,
          },
        },
      },
    },
  },
});

const writeConfigFile = (configPath, payload) => {
  fs.writeFileSync(configPath, JSON.stringify(payload, null, 2), 'utf8');
};

const openDb = (dbPath) => {
  const db = new DatabaseSync(dbPath);
  ensureProjectionStore(db);
  ensureEventStore(db);
  return db;
};

const getStatusCounts = (db) => {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS c
    FROM memory_current
    GROUP BY status
  `).all();
  const out = {};
  for (const row of rows) {
    out[String(row.status || 'unknown')] = Number(row.c || 0);
  }
  return out;
};

const assertFileExists = (filePath, label) => {
  assert.equal(fs.existsSync(filePath), true, `${label || filePath} must exist`);
};

export {
  makeTempWorkspace,
  seedMemoryCurrent,
  makeConfigObject,
  writeConfigFile,
  openDb,
  getStatusCounts,
  assertFileExists,
};
