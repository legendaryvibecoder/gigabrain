import assert from 'node:assert/strict';

import { normalizeConfig } from '../lib/core/config.js';
import { ensurePersonStore, rebuildEntityMentions } from '../lib/core/person-service.js';
import { recallForQuery } from '../lib/core/recall-service.js';
import { makeConfigObject, makeTempWorkspace, openDb, seedMemoryCurrent } from './helpers.js';

const run = async () => {
  const ws = makeTempWorkspace('gb-v6-unit-recall-service-');
  const config = normalizeConfig(makeConfigObject(ws.workspace).plugins.entries.gigabrain.config);
  config.recall.maxTokens = 2000;
  config.recall.topK = 5;
  config.recall.adaptiveBudgeting = { enabled: true };

  const db = openDb(ws.dbPath);
  try {
    seedMemoryCurrent(db, [
      {
        memory_id: 'bm25-strong',
        type: 'DECISION',
        content: 'Graph rollout rollout checklist for the nightly graph pipeline stabilization.',
        scope: 'shared',
        confidence: 0.96,
        value_score: 0.74,
        value_label: 'core',
      },
      {
        memory_id: 'bm25-weak',
        type: 'DECISION',
        content: 'Graph note for later follow-up.',
        scope: 'shared',
        confidence: 0.52,
        value_score: 0.18,
        value_label: 'situational',
      },
      {
        memory_id: 'situational-row',
        type: 'CONTEXT',
        content: 'Nightly graph pipeline follow-up and rollout owner reminder.',
        scope: 'shared',
        confidence: 0.64,
        value_score: 0.45,
        value_label: 'situational',
      },
      {
        memory_id: 'shared-mira',
        type: 'USER_FACT',
        content: 'Mira appears in the public release checklist template.',
        scope: 'shared',
        confidence: 0.81,
        value_score: 0.76,
        value_label: 'core',
      },
      {
        memory_id: 'alpha-mira',
        type: 'USER_FACT',
        content: 'Mira coordinates the alpha launch and owns the rollout.',
        scope: 'project:alpha',
        confidence: 0.92,
        value_score: 0.88,
        value_label: 'core',
      },
      {
        memory_id: 'beta-mira',
        type: 'USER_FACT',
        content: 'Mira coordinates the beta launch for another workspace.',
        scope: 'project:beta',
        confidence: 0.9,
        value_score: 0.82,
        value_label: 'core',
      },
    ]);
    ensurePersonStore(db);
    rebuildEntityMentions(db);

    const quickResult = recallForQuery({
      db,
      config,
      query: 'graph rollout',
      scope: 'shared',
      strategyContext: { strategy: 'quick_context' },
    });

    assert.equal(quickResult.results[0]?.memory_id, 'bm25-strong', 'recall should rank the denser BM25 match ahead of weaker lexical rows');
    assert.equal(quickResult.budget.maxTokens, 800, 'quick_context recall should use the adaptive quick-context token budget');
    assert.match(quickResult.injection, /recall_confidence:/, 'rendered injection should include confidence metadata');
    assert.match(quickResult.injection, /coverage: (high|medium|low)/, 'rendered injection should include coverage metadata');
    assert.match(quickResult.injection, /- \[(strong|medium|weak)\]/, 'rendered injection should annotate recalled rows with strength labels');

    const verificationResult = recallForQuery({
      db,
      config,
      query: 'graph rollout provenance',
      scope: 'shared',
      strategyContext: { strategy: 'verification_lookup' },
    });
    assert.equal(
      verificationResult.budget.maxTokens,
      1600,
      'verification_lookup recall should use the larger adaptive verification budget',
    );

    const semanticFallbackResult = recallForQuery({
      db,
      config: {
        ...config,
        recall: {
          ...config.recall,
          semanticRerankEnabled: true,
          ollamaUrl: 'http://127.0.0.1:9',
          embeddingTimeoutMs: 100,
        },
      },
      query: 'graph rollout',
      scope: 'shared',
      strategyContext: { strategy: 'quick_context' },
    });
    assert.equal(
      semanticFallbackResult.results[0]?.memory_id,
      'bm25-strong',
      'recall should gracefully keep BM25 order when semantic reranking is enabled but unavailable',
    );

    const alphaEntityResult = recallForQuery({
      db,
      config,
      query: 'who is mira',
      scope: 'project:alpha',
      strategyContext: { strategy: 'entity_brief' },
    });
    assert.equal(
      alphaEntityResult.results[0]?.memory_id,
      'alpha-mira',
      'entity recall should prioritize same-scope entity memories for project-scoped queries',
    );
    assert.equal(
      alphaEntityResult.results.some((row) => row.memory_id === 'beta-mira'),
      false,
      'entity recall should not leak foreign project entity rows into another project scope',
    );

    const sharedEntityResult = recallForQuery({
      db,
      config,
      query: 'who is mira',
      scope: 'shared',
      strategyContext: { strategy: 'entity_brief' },
    });
    assert.equal(
      sharedEntityResult.results.some((row) => row.memory_id === 'alpha-mira'),
      false,
      'shared-scope entity recall should not surface project-local entity memories',
    );
    assert.equal(
      sharedEntityResult.injection.includes('bootstrap_mode: true') || sharedEntityResult.results.every((row) => row.memory_id !== 'alpha-mira'),
      true,
      'shared-scope entity recall should fail closed to shared/bootstrap behavior instead of leaking project-local entity context',
    );
  } finally {
    db.close();
  }
};

export { run };
