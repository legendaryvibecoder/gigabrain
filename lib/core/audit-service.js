import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { appendEvent } from './event-store.js';
import {
  ensureProjectionStore,
  listCurrentMemories,
  materializeProjectionFromMemories,
  updateCurrentStatus,
} from './projection-store.js';
import {
  classifyValue,
  jaccardSimilarity,
  resolvePolicy,
  resolveSemanticThresholds,
} from './policy.js';
import { reviewWithLlm } from './llm-router.js';
import { openDatabase } from './sqlite.js';

const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), '.openclaw', 'gigabrain', 'output');

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

const ensureDirFor = (filePath) => {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
};

const writeJson = (filePath, payload) => {
  ensureDirFor(filePath);
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf8');
};

const writeJsonl = (filePath, rows) => {
  ensureDirFor(filePath);
  const payload = (rows || []).map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, payload ? `${payload}\n` : '', 'utf8');
};

const writeMarkdown = (filePath, text) => {
  ensureDirFor(filePath);
  fs.writeFileSync(filePath, text, 'utf8');
};

const ensureReviewLedger = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_quality_reviews (
      id TEXT PRIMARY KEY,
      memory_id TEXT NOT NULL,
      reviewed_at TEXT NOT NULL,
      review_version TEXT NOT NULL,
      action TEXT NOT NULL,
      score REAL,
      reason_codes TEXT,
      before_status TEXT,
      after_status TEXT,
      features TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_memory_quality_reviews_version ON memory_quality_reviews(review_version, action);
    CREATE INDEX IF NOT EXISTS idx_memory_quality_reviews_memory ON memory_quality_reviews(memory_id, reviewed_at);
  `);
};

const actionToStatus = (action, beforeStatus = 'active') => {
  const key = String(action || '').trim().toLowerCase();
  if (key === 'reject') return 'rejected';
  if (key === 'archive') return 'archived';
  if (key === 'keep') return 'active';
  if (key === 'merge_candidate') return beforeStatus;
  return beforeStatus;
};

const labelForAction = (action, fallback = 'situational') => {
  const key = String(action || '').trim().toLowerCase();
  if (key === 'reject') return 'junk';
  if (key === 'archive') return 'archive_candidate';
  if (key === 'keep') return 'core';
  if (key === 'merge_candidate') return 'situational';
  return fallback;
};

const parseJsonSafe = (value, fallback = null) => {
  if (!value) return fallback;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
};

const writeLedgerRow = (db, row) => {
  ensureReviewLedger(db);
  const stmt = db.prepare(`
    INSERT INTO memory_quality_reviews (
      id, memory_id, reviewed_at, review_version, action, score,
      reason_codes, before_status, after_status, features
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    randomUUID(),
    String(row.memory_id),
    String(row.reviewed_at),
    String(row.review_version),
    String(row.action),
    Number.isFinite(Number(row.score)) ? Number(row.score) : null,
    JSON.stringify(Array.isArray(row.reason_codes) ? row.reason_codes : []),
    row.before_status ? String(row.before_status) : null,
    row.after_status ? String(row.after_status) : null,
    JSON.stringify(row.features && typeof row.features === 'object' ? row.features : {}),
  );
};

const MAX_SCOPE_SIZE_FOR_SEMANTIC = 200;
const buildSemanticMap = (rows = [], config = {}) => {
  const byScope = new Map();
  for (const row of rows) {
    const scope = String(row.scope || 'shared').trim() || 'shared';
    const list = byScope.get(scope) || [];
    list.push(row);
    byScope.set(scope, list);
  }
  const map = new Map();
  for (const list of byScope.values()) {
    const capped = list.length > MAX_SCOPE_SIZE_FOR_SEMANTIC ? list.slice(0, MAX_SCOPE_SIZE_FOR_SEMANTIC) : list;
    for (let i = 0; i < capped.length; i += 1) {
      const a = capped[i];
      for (let j = i + 1; j < capped.length; j += 1) {
        const b = capped[j];
        if (String(a.type || 'CONTEXT') !== String(b.type || 'CONTEXT')) continue;
        const similarity = jaccardSimilarity(a.content || a.normalized || '', b.content || b.normalized || '');
        if (!Number.isFinite(similarity)) continue;
        const thresholds = resolveSemanticThresholds(a.type, config);
        if (similarity < Number(thresholds.review)) continue;
        const prevA = map.get(String(a.memory_id));
        if (!prevA || similarity > prevA.similarity) {
          map.set(String(a.memory_id), { similarity, matched: b });
        }
        const prevB = map.get(String(b.memory_id));
        if (!prevB || similarity > prevB.similarity) {
          map.set(String(b.memory_id), { similarity, matched: a });
        }
      }
    }
  }
  return map;
};

const shouldRunLlmReview = ({
  enabled,
  deterministic,
  llmConfig,
  semantic,
  action,
}) => {
  const provider = String(llmConfig?.provider || 'none').trim().toLowerCase();
  if (!enabled || provider === 'none') return false;
  const score = clamp01(deterministic?.value_score ?? 0);
  if (action === 'merge_candidate') return true;
  if (deterministic?.plausibility?.actionableCount > 0) return true;
  if (semantic && Number.isFinite(Number(semantic.similarity))) return true;
  return score >= clamp01(llmConfig?.minScore ?? 0.18) && score <= clamp01(llmConfig?.maxScore ?? 0.62);
};

const buildOutputPaths = (options = {}) => {
  const out = path.resolve(options.out || path.join(DEFAULT_OUTPUT_DIR, 'memory-audit-v3.jsonl'));
  const summary = path.resolve(options.summary || path.join(DEFAULT_OUTPUT_DIR, 'memory-audit-v3-summary.json'));
  const samples = path.resolve(options.samples || path.join(DEFAULT_OUTPUT_DIR, 'memory-audit-v3-samples.md'));
  return { out, summary, samples };
};

const summarizeRows = (rows = []) => {
  const summary = {
    total: rows.length,
    by_action: {},
    by_label: {},
    with_semantic_matches: 0,
  };
  for (const row of rows) {
    const action = String(row.action || 'unknown');
    const label = String(row.value_label || 'unknown');
    summary.by_action[action] = Number(summary.by_action[action] || 0) + 1;
    summary.by_label[label] = Number(summary.by_label[label] || 0) + 1;
    if (Number.isFinite(Number(row.similarity))) summary.with_semantic_matches += 1;
  }
  return summary;
};

const renderSamplesMarkdown = (rows = [], maxRows = 120) => {
  const lines = [];
  lines.push('# Gigabrain v3 Audit Samples');
  lines.push('');
  for (const row of rows.slice(0, maxRows)) {
    lines.push(`## ${row.action.toUpperCase()} - ${row.memory_id}`);
    lines.push(`- type: ${row.type}`);
    lines.push(`- scope: ${row.scope}`);
    lines.push(`- score: ${Number(row.score || 0).toFixed(4)}`);
    lines.push(`- reasons: ${(row.reason_codes || []).join(', ') || '(none)'}`);
    if (Number.isFinite(Number(row.similarity))) {
      lines.push(`- similarity: ${Number(row.similarity).toFixed(4)} (matched=${row.matched_memory_id || 'n/a'})`);
    }
    lines.push(`- content: ${String(row.content || '').trim()}`);
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
};

const runAudit = async ({
  dbPath,
  config,
  mode = 'shadow',
  reviewVersion = '',
  runId = '',
  out,
  summary,
  samples,
  llm = {},
}) => {
  const normalizedMode = String(mode || 'shadow').trim().toLowerCase();
  if (!['shadow', 'apply', 'restore'].includes(normalizedMode)) {
    throw new Error(`invalid audit mode=${mode}`);
  }
  if (normalizedMode === 'restore') {
    throw new Error('use runAuditRestore for mode=restore');
  }

  const db = openDatabase(dbPath);
  try {
    ensureProjectionStore(db);
    ensureReviewLedger(db);
    const count = db.prepare('SELECT COUNT(*) AS c FROM memory_current').get()?.c || 0;
    if (Number(count) === 0) {
      materializeProjectionFromMemories(db);
    }

    const activeRows = listCurrentMemories(db, {
      statuses: ['active'],
      limit: 200000,
    });
    const semanticMap = buildSemanticMap(activeRows, config);
    const policy = resolvePolicy(config);
    const cleanupVersion = String(config?.runtime?.cleanupVersion || 'v3.0.0');
    const nowIso = new Date().toISOString();
    const resolvedReviewVersion = String(reviewVersion || `rv-${nowIso.replace(/[:.]/g, '-')}`);
    const resolvedRunId = String(runId || `run-${nowIso.replace(/[:.]/g, '-')}`);

    // --- Idempotency: load reviews from this version to skip unchanged ---
    const priorReviews = new Map();
    try {
      const priorRows = db.prepare(`
        SELECT memory_id, action, score
        FROM memory_quality_reviews
        WHERE review_version = ?
        ORDER BY reviewed_at DESC
      `).all(resolvedReviewVersion);
      for (const pr of priorRows) {
        const mid = String(pr.memory_id);
        if (priorReviews.has(mid)) continue;
        priorReviews.set(mid, {
          action: String(pr.action || ''),
          score: Number.isFinite(Number(pr.score)) ? Number(pr.score) : 0,
        });
      }
    } catch (_) {
      // First run or missing table — review everything
    }

    const llmCfg = {
      provider: String(llm.provider || config?.llm?.provider || 'none'),
      baseUrl: String(llm.baseUrl || config?.llm?.baseUrl || ''),
      model: String(llm.model || config?.llm?.model || ''),
      apiKey: String(llm.apiKey || config?.llm?.apiKey || ''),
      timeoutMs: Number(llm.timeoutMs || config?.llm?.timeoutMs || 12000),
      taskProfiles: config?.llm?.taskProfiles || {},
      enabled: llm.enabled === true || config?.llm?.review?.enabled === true,
      minScore: Number(llm.minScore ?? config?.llm?.review?.minScore ?? 0.18),
      maxScore: Number(llm.maxScore ?? config?.llm?.review?.maxScore ?? 0.62),
      minConfidence: Number(llm.minConfidence ?? config?.llm?.review?.minConfidence ?? 0.8),
      limit: Math.max(0, Number(llm.limit ?? config?.llm?.review?.limit ?? 200)),
      profile: String(llm.profile || config?.llm?.review?.profile || 'memory_review'),
    };

    const rows = [];
    const llmReviewActive = llmCfg.enabled && String(llmCfg.provider || 'none').trim().toLowerCase() !== 'none';
    const llmStats = {
      enabled: llmReviewActive,
      provider: llmCfg.provider,
      attempted: 0,
      accepted: 0,
      failed: 0,
    };

    // Phase 1: classify all rows (including async LLM calls) outside transaction
    const classified = [];
    for (const memory of activeRows) {
      const deterministic = classifyValue(memory, policy);
      const semantic = semanticMap.get(String(memory.memory_id));
      let action = deterministic.action;
      let reasons = Array.from(new Set(deterministic.reason_codes || []));

      const semanticThresholds = resolveSemanticThresholds(memory?.type, config);
      if (semantic && Number(semantic.similarity) >= Number(semanticThresholds.auto)) {
        action = 'merge_candidate';
        reasons = Array.from(new Set([...reasons, 'duplicate_semantic']));
      }

      const prior = priorReviews.get(String(memory.memory_id));
      if (prior
        && prior.action === action
        && Math.abs(prior.score - (Number.isFinite(Number(deterministic.value_score)) ? Number(deterministic.value_score) : 0)) < 0.001
      ) {
        continue;
      }

      const canLlmReview = shouldRunLlmReview({
        enabled: llmReviewActive && llmStats.attempted < llmCfg.limit,
        deterministic,
        llmConfig: llmCfg,
        semantic,
        action,
      });
      if (canLlmReview) {
        llmStats.attempted += 1;
        const llmResult = await reviewWithLlm({
          provider: llmCfg.provider,
          baseUrl: llmCfg.baseUrl,
          model: llmCfg.model,
          apiKey: llmCfg.apiKey,
          timeoutMs: llmCfg.timeoutMs,
          memory,
          deterministic,
          taskProfiles: llmCfg.taskProfiles,
          profile: llmCfg.profile,
        });
        if (llmResult.ok) {
          if (Number(llmResult.confidence || 0) >= Number(llmCfg.minConfidence || 0.8) && llmResult.decision) {
            action = llmResult.decision;
            llmStats.accepted += 1;
            reasons = Array.from(new Set([
              ...reasons,
              action === 'keep' ? 'llm_second_opinion_keep' : action === 'archive' ? 'llm_second_opinion_archive' : 'llm_second_opinion',
            ]));
          }
        } else {
          llmStats.failed += 1;
        }
        classified.push({ memory, deterministic, semantic, action, reasons, canonicalHint: llmResult.canonical_hint || '' });
        continue;
      }

      classified.push({ memory, deterministic, semantic, action, reasons, canonicalHint: '' });
    }

    // Phase 2: apply all results inside a single transaction
    db.exec('BEGIN');
    try {
      for (const { memory, deterministic, semantic, action, reasons, canonicalHint } of classified) {
        const beforeStatus = String(memory.status || 'active');
        const afterStatus = actionToStatus(action, beforeStatus);
        const row = {
          memory_id: String(memory.memory_id),
          type: String(memory.type || ''),
          scope: String(memory.scope || ''),
          content: String(memory.content || ''),
          score: Number.isFinite(Number(deterministic.value_score)) ? Number(deterministic.value_score) : 0,
          action,
          value_label: deterministic.value_label || labelForAction(action, 'situational'),
          reason_codes: reasons,
          before_status: beforeStatus,
          after_status: afterStatus,
          reviewed_at: nowIso,
          review_version: resolvedReviewVersion,
          similarity: semantic ? Number(semantic.similarity) : null,
          matched_memory_id: semantic?.matched?.memory_id ? String(semantic.matched.memory_id) : null,
          features: deterministic.features || {},
          canonical_hint: canonicalHint || '',
        };
        rows.push(row);

        writeLedgerRow(db, row);

        if (normalizedMode === 'apply') {
          if (afterStatus !== beforeStatus || row.value_label || Number.isFinite(Number(row.score))) {
            updateCurrentStatus(db, row.memory_id, afterStatus, {
              value_score: row.score,
              value_label: row.value_label,
              timestamp: row.reviewed_at,
              last_reviewed_at: row.reviewed_at,
            });
          }
          appendEvent(db, {
            timestamp: row.reviewed_at,
            component: 'review',
            action: `audit_${action}`,
            reason_codes: row.reason_codes,
            memory_id: row.memory_id,
            cleanup_version: cleanupVersion,
            run_id: resolvedRunId,
            review_version: resolvedReviewVersion,
            similarity: row.similarity,
            matched_memory_id: row.matched_memory_id,
            payload: {
              before_status: row.before_status,
              after_status: row.after_status,
              value_score: row.score,
              value_label: row.value_label,
              features: row.features,
              ...(row.canonical_hint ? { canonical_hint: row.canonical_hint } : {}),
            },
          });
        }
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    const outputPaths = buildOutputPaths({ out, summary, samples });
    writeJsonl(outputPaths.out, rows);
    const summaryPayload = {
      ok: true,
      mode: normalizedMode,
      reviewVersion: resolvedReviewVersion,
      runId: resolvedRunId,
      rows: rows.length,
      summary: summarizeRows(rows),
      llmReview: llmStats,
      output: outputPaths,
    };
    writeJson(outputPaths.summary, summaryPayload);
    writeMarkdown(outputPaths.samples, renderSamplesMarkdown(rows));

    return summaryPayload;
  } finally {
    db.close();
  }
};

const runAuditRestore = ({
  dbPath,
  reviewVersion,
  runId = '',
  cleanupVersion = 'v3.0.0',
}) => {
  const db = openDatabase(dbPath);
  try {
    ensureProjectionStore(db);
    ensureReviewLedger(db);
    const version = String(reviewVersion || '').trim();
    if (!version) throw new Error('reviewVersion is required for restore');

    const rows = db.prepare(`
      SELECT
        memory_id, reviewed_at, action, before_status, after_status, score, reason_codes, features
      FROM memory_quality_reviews
      WHERE review_version = ?
      ORDER BY reviewed_at DESC
    `).all(version);
    if (!rows || rows.length === 0) {
      return { ok: true, restored: 0, reviewVersion: version };
    }
    const seen = new Set();
    let restored = 0;
    const nowIso = new Date().toISOString();
    db.exec('BEGIN');
    try {
      for (const row of rows) {
        const memoryId = String(row.memory_id || '');
        if (!memoryId || seen.has(memoryId)) continue;
        seen.add(memoryId);
        const beforeStatus = String(row.before_status || 'active');
        updateCurrentStatus(db, memoryId, beforeStatus, {
          timestamp: nowIso,
          last_reviewed_at: nowIso,
        });
        appendEvent(db, {
          timestamp: nowIso,
          component: 'review',
          action: 'audit_restore',
          reason_codes: ['restore'],
          memory_id: memoryId,
          cleanup_version: String(cleanupVersion || 'v3.0.0'),
          run_id: String(runId || `restore-${nowIso.replace(/[:.]/g, '-')}`),
          review_version: version,
          payload: {
            restored_to_status: beforeStatus,
          },
        });
        restored += 1;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return {
      ok: true,
      restored,
      reviewVersion: version,
    };
  } finally {
    db.close();
  }
};

const runAuditReport = ({
  dbPath,
  reviewVersion,
  out = '',
}) => {
  const db = openDatabase(dbPath);
  try {
    ensureReviewLedger(db);
    const version = String(reviewVersion || '').trim();
    if (!version) throw new Error('reviewVersion is required for report');

    const rows = db.prepare(`
      SELECT action, COUNT(*) AS count
      FROM memory_quality_reviews
      WHERE review_version = ?
      GROUP BY action
      ORDER BY count DESC
    `).all(version);
    const summary = {};
    let total = 0;
    for (const row of rows) {
      const count = Number(row.count || 0);
      summary[String(row.action || 'unknown')] = count;
      total += count;
    }

    const sampleRows = db.prepare(`
      SELECT memory_id, action, score, reason_codes, before_status, after_status
      FROM memory_quality_reviews
      WHERE review_version = ?
      ORDER BY reviewed_at DESC
      LIMIT 30
    `).all(version).map((row) => ({
      memory_id: String(row.memory_id || ''),
      action: String(row.action || ''),
      score: Number.isFinite(Number(row.score)) ? Number(row.score) : null,
      reason_codes: parseJsonSafe(row.reason_codes, []),
      before_status: row.before_status ? String(row.before_status) : null,
      after_status: row.after_status ? String(row.after_status) : null,
    }));

    const payload = {
      ok: true,
      reviewVersion: version,
      summary: {
        total_reviews: total,
        actions: summary,
      },
      samples: sampleRows,
    };
    if (out) writeJson(path.resolve(out), payload);
    return payload;
  } finally {
    db.close();
  }
};

/**
 * Remove no-op review rows where before_status === after_status,
 * keeping only the most recent no-op per memory (for audit trail).
 * Returns { ok, deleted, kept }.
 */
const purgeNoopReviews = ({ dbPath }) => {
  const db = openDatabase(dbPath);
  try {
    ensureReviewLedger(db);
    // Keep one latest no-op per memory, delete the rest
    const totalNoops = db.prepare(`
      SELECT COUNT(*) AS c FROM memory_quality_reviews
      WHERE before_status = after_status
    `).get()?.c || 0;
    const uniqueMemories = db.prepare(`
      SELECT COUNT(DISTINCT memory_id) AS c FROM memory_quality_reviews
      WHERE before_status = after_status
    `).get()?.c || 0;

    db.exec('BEGIN');
    try {
      db.exec(`
        DELETE FROM memory_quality_reviews
        WHERE before_status = after_status
          AND id NOT IN (
            SELECT id FROM (
              SELECT id, ROW_NUMBER() OVER (
                PARTITION BY memory_id ORDER BY reviewed_at DESC
              ) AS rn
              FROM memory_quality_reviews
              WHERE before_status = after_status
            ) WHERE rn = 1
          )
      `);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    const remaining = db.prepare('SELECT COUNT(*) AS c FROM memory_quality_reviews').get()?.c || 0;
    const deleted = totalNoops - uniqueMemories;
    return { ok: true, deleted, kept: remaining };
  } finally {
    db.close();
  }
};

export {
  ensureReviewLedger,
  runAudit,
  runAuditRestore,
  runAuditReport,
  purgeNoopReviews,
};
