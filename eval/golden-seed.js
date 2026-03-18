import { randomUUID } from 'node:crypto';

import { ensureProjectionStore, upsertCurrentMemory } from '../lib/core/projection-store.js';
import { ensurePersonStore, rebuildEntityMentions } from '../lib/core/person-service.js';
import { ensureWorldModelReady, rebuildWorldModel } from '../lib/core/world-model.js';

const NOW = new Date().toISOString();

const makeId = (label) => `golden-${label}-${randomUUID().slice(0, 8)}`;

/**
 * A fixed set of memories for deterministic evaluation.
 * Covers entity facts, preferences, episodes, decisions, contexts, and agent identity.
 */
const GOLDEN_MEMORIES = [
  // --- Entity: Jordan (person, main user) ---
  { label: 'jordan-identity', type: 'USER_FACT', content: 'Jordan is the main user of this workspace and lives in Vienna.', confidence: 0.95, scope: 'shared', value_score: 0.92, content_time: '2026-01-01' },
  { label: 'jordan-role', type: 'USER_FACT', content: 'Jordan works as a software architect and focuses on AI-first products.', confidence: 0.93, scope: 'shared', value_score: 0.88 },
  { label: 'jordan-preference-season', type: 'PREFERENCE', content: 'Jordan prefers winter and associates it with calm focus and deep work.', confidence: 0.91, scope: 'main', value_score: 0.80 },
  { label: 'jordan-preference-tool', type: 'PREFERENCE', content: 'Jordan prefers using Claude and Codex for coding workflows.', confidence: 0.88, scope: 'main', value_score: 0.75 },
  { label: 'jordan-health-goal', type: 'USER_FACT', content: 'Jordan has a goal weight of 85kg and tracks calories via the Calorie Club.', confidence: 0.90, scope: 'shared', value_score: 0.85 },
  { label: 'jordan-poly', type: 'USER_FACT', content: 'Jordan is active in the polyamorous community and lives polyamorously.', confidence: 0.89, scope: 'shared', value_score: 0.78 },

  // --- Entity: Riley (partner) ---
  { label: 'riley-identity', type: 'USER_FACT', content: 'Riley is Jordan partner and they live together in Vienna.', confidence: 0.95, scope: 'shared', value_score: 0.95 },
  { label: 'riley-birthday', type: 'USER_FACT', content: 'Riley has birthday on November 6.', confidence: 0.94, scope: 'shared', value_score: 0.90 },
  { label: 'riley-role', type: 'USER_FACT', content: 'Riley works as a Lebens- und Sozialberaterin in Vienna.', confidence: 0.92, scope: 'shared', value_score: 0.87 },
  { label: 'riley-coaching', type: 'USER_FACT', content: 'Riley offers relationship coaching and specializes in consensual non-monogamy.', confidence: 0.88, scope: 'shared', value_score: 0.82 },

  // --- Entity: Stefan (collaborator) ---
  { label: 'stefan-identity', type: 'USER_FACT', content: 'Stefan is a collaborator who runs clusterberatung.at and lives in Graz.', confidence: 0.90, scope: 'shared', value_score: 0.84 },
  { label: 'stefan-tech', type: 'CONTEXT', content: 'Stefan manages the Hetzner VPS and uses Coolify for deployments.', confidence: 0.87, scope: 'shared', value_score: 0.76 },

  // --- Entity: Liz / Elisabeth ---
  { label: 'liz-identity', type: 'USER_FACT', content: 'Liz is Elisabeth Rieder, a life coach and speaker based in Vienna.', confidence: 0.92, scope: 'shared', value_score: 0.88 },
  { label: 'liz-website', type: 'CONTEXT', content: 'Liz has a website at elisabethrieder.life and a coaching practice.', confidence: 0.85, scope: 'shared', value_score: 0.72 },

  // --- Entity: Chris ---
  { label: 'chris-identity', type: 'USER_FACT', content: 'Chris is a close friend of Jordan and is involved in tech projects.', confidence: 0.88, scope: 'shared', value_score: 0.80 },
  { label: 'chris-preference', type: 'PREFERENCE', content: 'Chris prefers minimal tooling and fast iteration cycles when building.', confidence: 0.84, scope: 'shared', value_score: 0.72 },

  // --- Entity: Sam ---
  { label: 'sam-identity', type: 'USER_FACT', content: 'Sam is a close collaborator in the active project circle.', confidence: 0.86, scope: 'shared', value_score: 0.76 },

  // --- Entity: Alex ---
  { label: 'alex-identity', type: 'USER_FACT', content: 'Alex is part of the active project circle and contributes to research.', confidence: 0.85, scope: 'shared', value_score: 0.74 },

  // --- Entity: Tria (project) ---
  { label: 'tria-identity', type: 'USER_FACT', content: 'Tria is a neobank startup preparing for an investor intro round.', confidence: 0.92, scope: 'main', value_score: 0.88 },
  { label: 'tria-investor', type: 'CONTEXT', content: 'Tria is preparing an investor intro with Jordan scheduled for February 2026.', confidence: 0.89, scope: 'main', value_score: 0.83, content_time: '2026-02-01' },

  // --- Entity: Atlas (agent identity) ---
  { label: 'atlas-identity', type: 'AGENT_IDENTITY', content: 'Atlas is the coding agent identity for this workspace.', confidence: 0.94, scope: 'main', value_score: 0.90 },
  { label: 'atlas-role', type: 'AGENT_IDENTITY', content: 'Atlas handles memory management, recall, and maintenance in the Gigabrain system.', confidence: 0.90, scope: 'main', value_score: 0.85 },

  // --- Entity: Novara ---
  { label: 'novara-fact', type: 'USER_FACT', content: 'Novara is Jordan partner and birthday November 6.', confidence: 0.93, scope: 'shared', value_score: 0.90 },

  // --- Projects and tools ---
  { label: 'gigabrain-project', type: 'CONTEXT', content: 'Gigabrain is the local-first memory layer for OpenClaw, Codex, and Claude.', confidence: 0.95, scope: 'shared', value_score: 0.92 },
  { label: 'openclaw-project', type: 'CONTEXT', content: 'OpenClaw is the gateway and plugin framework that hosts Gigabrain and other tools.', confidence: 0.93, scope: 'shared', value_score: 0.88 },
  { label: 'vault-project', type: 'CONTEXT', content: 'The vault is an Obsidian-based export of Gigabrain memories with structured views.', confidence: 0.88, scope: 'shared', value_score: 0.80 },
  { label: 'viral-machine', type: 'CONTEXT', content: 'The Viral Machine is a tweet discovery and posting pipeline running on the Mac Studio.', confidence: 0.86, scope: 'shared', value_score: 0.78 },
  { label: 'spark-project', type: 'CONTEXT', content: 'Spark is the intelligence layer that provides advisory and suggestion flows to Gigabrain.', confidence: 0.87, scope: 'shared', value_score: 0.80 },
  { label: 'oura-project', type: 'CONTEXT', content: 'The Oura health dashboard tracks sleep, HRV, and longevity scores via a FastAPI backend.', confidence: 0.85, scope: 'shared', value_score: 0.76 },
  { label: 'ollama-setup', type: 'CONTEXT', content: 'Ollama runs on the Mac Studio with qwen3.5:9b and bge-m3 models for memory review and embeddings.', confidence: 0.84, scope: 'shared', value_score: 0.72 },

  // --- Temporal episodes ---
  { label: 'episode-jan-2026', type: 'DECISION', content: 'In January 2026, Jordan and Atlas worked on the gigabrain architecture and entity cleanup.', confidence: 0.92, scope: 'main', value_score: 0.88, content_time: '2026-01-15' },
  { label: 'episode-feb-2026', type: 'DECISION', content: 'In February 2026, Jordan finalized the owl avatar rollout and vault v3 migration.', confidence: 0.94, scope: 'main', value_score: 0.90, content_time: '2026-02-10' },
  { label: 'episode-mar-2026', type: 'DECISION', content: 'In March 2026, Jordan completed the vault sync stabilization and memorybench cleanup.', confidence: 0.90, scope: 'main', value_score: 0.85, content_time: '2026-03-01' },
  { label: 'episode-migration', type: 'CONTEXT', content: 'The migration from VPS to Mac Studio happened on February 9, 2026 with 107 path replacements.', confidence: 0.91, scope: 'shared', value_score: 0.86, content_time: '2026-02-09' },

  // --- Decisions ---
  { label: 'decision-spark-bridge', type: 'DECISION', content: 'Decision: Spark advisory bridge v2.0 uses contract-based pull/ack semantics with JSONL store.', confidence: 0.90, scope: 'main', value_score: 0.84 },
  { label: 'decision-fts5', type: 'DECISION', content: 'Decision: FTS5 full-text search was added to memory_current on March 11, 2026 for improved recall.', confidence: 0.89, scope: 'main', value_score: 0.82, content_time: '2026-03-11' },
  { label: 'decision-nightly', type: 'DECISION', content: 'Decision: All Gigabrain maintenance runs as a single nightly cron job at 23:40 UTC.', confidence: 0.88, scope: 'main', value_score: 0.80 },

  // --- Quick context items ---
  { label: 'context-telegram', type: 'CONTEXT', content: 'The Telegram bot handles user interactions and is connected to OpenClaw via the gateway.', confidence: 0.84, scope: 'shared', value_score: 0.72 },
  { label: 'context-architecture', type: 'CONTEXT', content: 'The architecture uses a projection store with memory_current table, entity mentions, and world model.', confidence: 0.90, scope: 'shared', value_score: 0.86 },
  { label: 'context-calorie-club', type: 'CONTEXT', content: 'The Calorie Club is a shared weight tracking initiative between Jordan and friends.', confidence: 0.82, scope: 'shared', value_score: 0.70 },

  // --- Cross-scope / shared knowledge ---
  { label: 'shared-weight-goal', type: 'USER_FACT', content: 'Jordan and the team share a weight goal tracking system called the Calorie Club with a target of 85kg.', confidence: 0.86, scope: 'shared', value_score: 0.78 },

  // --- Negation / contradiction test data ---
  { label: 'outdated-jordan-city', type: 'CONTEXT', content: 'Jordan used to live in Berlin before moving to Vienna.', confidence: 0.70, scope: 'shared', value_score: 0.50, content_time: '2024-06-01' },

  // --- Flint and Kimi ---
  { label: 'flint-identity', type: 'CONTEXT', content: 'Flint is a Telegram bot identity used for automated responses.', confidence: 0.82, scope: 'shared', value_score: 0.68 },
  { label: 'kimi-identity', type: 'CONTEXT', content: 'Kimi is an AI model used for food image analysis alongside Nimbus cross-model comparison.', confidence: 0.80, scope: 'shared', value_score: 0.66 },

  // --- Moonshot ---
  { label: 'moonshot-identity', type: 'CONTEXT', content: 'Moonshot is a project concept for ambitious long-term product goals.', confidence: 0.78, scope: 'shared', value_score: 0.64 },

  // --- Audit and maintenance ---
  { label: 'audit-context', type: 'CONTEXT', content: 'The last full memory audit ran on March 10, 2026 with 211 active and 954 archived memories.', confidence: 0.88, scope: 'main', value_score: 0.80, content_time: '2026-03-10' },
  { label: 'nightly-context', type: 'CONTEXT', content: 'The nightly maintenance pipeline runs 18 steps plus graph build at 23:40 UTC daily.', confidence: 0.87, scope: 'main', value_score: 0.78 },
];

/**
 * Seeds a test database with a fixed golden dataset for deterministic eval.
 *
 * @param {import('node:sqlite').DatabaseSync} db - An open DatabaseSync instance
 * @returns {{ seeded: number, entities_rebuilt: boolean }}
 */
const seedGoldenDb = (db) => {
  ensureProjectionStore(db);
  ensurePersonStore(db);

  let seeded = 0;
  for (const mem of GOLDEN_MEMORIES) {
    const memoryId = makeId(mem.label);
    upsertCurrentMemory(db, {
      memory_id: memoryId,
      type: mem.type || 'CONTEXT',
      content: mem.content,
      source: 'golden-seed',
      source_agent: 'eval',
      source_session: 'golden',
      confidence: mem.confidence ?? 0.8,
      scope: mem.scope || 'shared',
      status: 'active',
      value_score: mem.value_score ?? null,
      value_label: mem.value_score != null ? 'core' : null,
      created_at: NOW,
      updated_at: NOW,
      content_time: mem.content_time || null,
      tags: [],
    });
    seeded += 1;
  }

  rebuildEntityMentions(db);

  let entitiesRebuilt = false;
  try {
    ensureWorldModelReady({ db, config: {}, rebuildIfEmpty: true });
    entitiesRebuilt = true;
  } catch {
    try {
      rebuildWorldModel({ db, config: {} });
      entitiesRebuilt = true;
    } catch {
      // World model rebuild is best-effort in golden seed context
    }
  }

  return {
    seeded,
    entities_rebuilt: entitiesRebuilt,
  };
};

export { seedGoldenDb };
