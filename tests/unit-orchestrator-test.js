import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { rebuildEntityMentions } from '../lib/core/person-service.js';
import { ensureNativeStore } from '../lib/core/native-sync.js';
import { classifyQueryIntent, orchestrateRecall } from '../lib/core/orchestrator.js';
import { normalizeConfig } from '../lib/core/config.js';
import { runMaintenance } from '../lib/core/maintenance-service.js';
import { makeConfigObject, makeTempWorkspace, openDb, seedMemoryCurrent } from './helpers.js';

const run = async () => {
  const ws = makeTempWorkspace('gb-v5-orchestrator-');
  const config = normalizeConfig(makeConfigObject(ws.workspace).plugins.entries.gigabrain.config);
  const db = openDb(ws.dbPath);
  try {
    seedMemoryCurrent(db, [
      {
        memory_id: 'm-1',
        type: 'USER_FACT',
        content: 'Liz is Chris partner and works as a life coach in Vienna.',
        scope: 'nimbusmain',
        confidence: 0.92,
        value_score: 0.91,
      },
      {
        memory_id: 'm-1b',
        type: 'USER_FACT',
        content: 'Liz prefers structured Memory-Notes.',
        scope: 'nimbusmain',
        confidence: 0.95,
        value_score: 0.84,
      },
      {
        memory_id: 'm-2',
        type: 'EPISODE',
        content: 'The Tria interview happened on January 29 2026 and went well afterwards.',
        scope: 'shared',
        confidence: 0.81,
        value_score: 0.79,
        content_time: '2026-01-29',
      },
      {
        memory_id: 'm-3',
        type: 'USER_FACT',
        content: 'Tria is a neobank and Chris is an investor there.',
        scope: 'shared',
        confidence: 0.78,
        value_score: 0.77,
      },
      {
        memory_id: 'm-4',
        type: 'USER_FACT',
        content: 'Chris started his weight loss journey at 90kg and wants to reach 80kg.',
        scope: 'shared',
        confidence: 0.95,
        value_score: 0.99,
      },
      {
        memory_id: 'm-5',
        type: 'EPISODE',
        content: 'Calorie tracker research found Austrian terminology like Topfen and Semmel in the nutrition database.',
        scope: 'shared',
        confidence: 0.88,
        value_score: 0.84,
        content_time: '2026-02-17',
      },
      {
        memory_id: 'm-6',
        type: 'AGENT_IDENTITY',
        content: 'Atlas is the coding agent for this workspace.',
        scope: 'nimbusmain',
        confidence: 0.94,
        value_score: 0.84,
      },
      {
        memory_id: 'm-7',
        type: 'PREFERENCE',
        content: 'Jordan prefers winter and associates it with calm focus.',
        scope: 'nimbusmain',
        confidence: 0.91,
        value_score: 0.8,
      },
      {
        memory_id: 'm-8',
        type: 'DECISION',
        content: 'In March 2026, Jordan completed the vault sync stabilization.',
        scope: 'nimbusmain',
        confidence: 0.9,
        value_score: 0.72,
        content_time: '2026-03-14',
      },
    ]);
    ensureNativeStore(db);
    rebuildEntityMentions(db);

    assert.equal(classifyQueryIntent('Who is Liz?').strategy, 'entity_brief');
    assert.equal(classifyQueryIntent('When did the Tria interview happen?').strategy, 'timeline_brief');
    assert.equal(classifyQueryIntent('Where is that written exactly?').strategy, 'verification_lookup');

    const entityRecall = orchestrateRecall({
      db,
      config,
      query: 'Who is Liz?',
      scope: 'nimbusmain',
    });
    assert.equal(entityRecall.strategy, 'entity_brief');
    assert.equal(entityRecall.profile, 'identity_profile');
    assert.equal(entityRecall.usedWorldModel, true, 'entity query should prefer world-model brief');
    assert.equal(entityRecall.deepLookupAllowed, false, 'normal entity queries should not automatically allow deep lookup');
    assert.equal(entityRecall.deepLookupReason, 'none', 'normal entity queries should stay in Gigabrain-first mode');
    assert.equal(entityRecall.selectedEntityId, 'person:liz');
    assert.equal(entityRecall.rankingMode, 'entity_brief:entity_locked');
    assert.equal(entityRecall.injection.includes('world_model_brief:'), true, 'injection should contain a synthesized brief');
    assert.equal(entityRecall.injection.includes('Source:'), false, 'injection must not leak visible provenance');
    assert.equal(entityRecall.results.every((row) => !String(row.content || '').includes('weight loss journey')), true, 'entity-locked recall should suppress unrelated high-value rows');
    assert.equal(String(entityRecall.results[0]?.content || '').toLowerCase().includes('memory-notes'), false, 'entity recall should not rank weak memory-note meta above direct relationship/profile facts');

    const selfRecall = orchestrateRecall({
      db,
      config,
      query: 'what do you know about yourself atlas',
      scope: 'nimbusmain',
    });
    assert.equal(selfRecall.strategy, 'entity_brief', 'self-identity prompts should keep entity-brief routing even without a locked world-model entity');
    assert.equal(selfRecall.usedWorldModel, false, 'self-identity fallback should still work without a synthesized world-model brief');
    assert.equal(String(selfRecall.results[0]?.type || ''), 'AGENT_IDENTITY', 'self-identity prompts should prioritize AGENT_IDENTITY rows');
    assert.equal(String(selfRecall.results[0]?.content || '').toLowerCase().includes('atlas is the coding agent'), true, 'self-identity prompts should surface the agent identity row');

    const preferenceRecall = orchestrateRecall({
      db,
      config,
      query: 'welche jahreszeit magst du',
      scope: 'nimbusmain',
    });
    assert.equal(String(preferenceRecall.results[0]?.type || ''), 'PREFERENCE', 'short preference prompts should prioritize preference memories');
    assert.equal(String(preferenceRecall.results[0]?.content || '').toLowerCase().includes('winter'), true, 'short preference prompts should recover the season preference row');

    const timelineRecall = orchestrateRecall({
      db,
      config,
      query: 'What happened with Tria in January 2026?',
      scope: 'shared',
    });
    assert.equal(timelineRecall.strategy, 'timeline_brief');
    assert.equal(timelineRecall.profile, 'project_profile');
    assert.equal(timelineRecall.deepLookupAllowed, false, 'timeline brief should not enable deep lookup unless exact verification is requested');
    assert.equal(timelineRecall.entityIds[0], 'organization:tria', 'timeline brief should prefer the real subject entity over temporal topic aliases');
    assert.equal(timelineRecall.rankingMode, 'timeline_brief:entity_locked');
    assert.equal(timelineRecall.injection.includes('timeline_items:'), true, 'timeline brief should include timeline items');
    assert.equal(Boolean(timelineRecall.temporalWindow), true, 'timeline brief should carry a temporal window');
    assert.equal(String(timelineRecall.results[0]?.content || '').toLowerCase().includes('tria'), true, 'timeline recall should keep the selected entity at the top of supporting rows');
    assert.equal(String(timelineRecall.results[0]?.content || '').toLowerCase().includes('weight loss'), false, 'timeline recall should not promote unrelated high-value rows');
    assert.equal(timelineRecall.results.every((row) => !String(row.content || '').toLowerCase().includes('austrian terminology')), true, 'timeline recall should not treat substring matches like tria/austrian as entity-linked evidence');

    const monthOnlyTimelineRecall = orchestrateRecall({
      db,
      config,
      query: 'What happened in March 2026?',
      scope: 'nimbusmain',
    });
    assert.equal(monthOnlyTimelineRecall.strategy, 'timeline_brief', 'month-only prompts should keep timeline-brief routing even without a locked entity');
    assert.equal(Boolean(monthOnlyTimelineRecall.temporalWindow), true, 'month-only prompts should preserve temporal windows');
    assert.equal(String(monthOnlyTimelineRecall.results[0]?.content || '').toLowerCase().includes('march 2026'), true, 'month-only prompts should prioritize rows in the requested month');

    const noisyEntityRecall = orchestrateRecall({
      db,
      config,
      query: 'Conversation info (untrusted metadata):\n```json\n{"message_id":"480","sender":"PRINT"}\n```\n\nwho is Liz?',
      scope: 'nimbusmain',
    });
    assert.equal(noisyEntityRecall.strategy, 'entity_brief', 'sanitized entity prompts should keep entity-brief routing after metadata stripping');
    assert.equal(String(noisyEntityRecall.results[0]?.content || '').toLowerCase().includes('liz is chris partner'), true, 'sanitized entity prompts should still surface the right entity row');

    const wmOnlyWs = makeTempWorkspace('gb-v5-orchestrator-world-');
    const wmOnlyConfig = normalizeConfig(makeConfigObject(wmOnlyWs.workspace).plugins.entries.gigabrain.config);
    fs.writeFileSync(path.join(wmOnlyWs.workspace, 'MEMORY.md'), '# MEMORY\n\n- Riley is Jordan partner and they live together.\n', 'utf8');
    const wmOnlyMaintenance = runMaintenance({
      dbPath: wmOnlyWs.dbPath,
      config: wmOnlyConfig,
      dryRun: false,
      runId: 'wm-only-maint',
      reviewVersion: 'rv-wm-only-maint',
    });
    assert.equal(Boolean(wmOnlyMaintenance?.ok), true, 'maintenance should succeed for world-model-only orchestrator fixture');
    const wmOnlyDb = openDb(wmOnlyWs.dbPath);
    try {
      const wmOnlyRecall = orchestrateRecall({
        db: wmOnlyDb,
        config: wmOnlyConfig,
        query: 'wer ist riley?',
        scope: 'shared',
      });
      assert.equal(wmOnlyRecall.strategy, 'entity_brief', 'world-model-only entity prompts should keep entity-brief routing');
      assert.equal(wmOnlyRecall.selectedEntityId, 'person:riley', 'world-model-only entity prompts should still lock onto the selected entity');
      assert.equal(wmOnlyRecall.rankingMode, 'entity_brief:entity_locked', 'reported ranking mode should reflect entity-brief routing even when no supporting recall rows survive');
      assert.equal(Array.isArray(wmOnlyRecall.results), true);
      assert.equal(wmOnlyRecall.results.length, 0, 'world-model-only fallback fixture should not require supporting recall rows');
    } finally {
      wmOnlyDb.close();
    }

    const verifyRecall = orchestrateRecall({
      db,
      config,
      query: 'Where is that written for Tria exactly?',
      scope: 'shared',
    });
    assert.equal(verifyRecall.strategy, 'verification_lookup');
    assert.equal(verifyRecall.profile, 'verification_profile');
    assert.equal(verifyRecall.deepLookupAllowed, true, 'exact/source request should allow deep lookup');
    assert.equal(verifyRecall.deepLookupReason, 'source_request', 'source request should surface a single normalized deep lookup reason');
    assert.equal(Array.isArray(verifyRecall.explain.result_breakdown), true, 'explain output should expose ranked result breakdown');
    assert.equal(verifyRecall.results.every((row) => String(row.content || '').toLowerCase().includes('tria')), true, 'verification recall should stay scoped to the selected entity when one is available');
  } finally {
    db.close();
  }
};

export { run };
