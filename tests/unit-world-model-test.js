import assert from 'node:assert/strict';

import { rebuildEntityMentions } from '../lib/core/person-service.js';
import { ensureNativeStore } from '../lib/core/native-sync.js';
import {
  ensureWorldModelReady,
  getEntityDetail,
  listContradictions,
  listEntities,
  listSyntheses,
  pickSurfaceSummaryBelief,
  resolveMemoryTier,
  selectSurfaceBeliefsForEntity,
  rebuildWorldModel,
} from '../lib/core/world-model.js';
import { makeConfigObject, makeTempWorkspace, openDb, seedMemoryCurrent } from './helpers.js';
import { normalizeConfig } from '../lib/core/config.js';

const run = async () => {
  const ws = makeTempWorkspace('gb-v5-world-model-');
  const config = normalizeConfig(makeConfigObject(ws.workspace).plugins.entries.gigabrain.config);
  const db = openDb(ws.dbPath);
  try {
    assert.equal(
      resolveMemoryTier({
        row: { type: 'AGENT_IDENTITY', content: 'Agent identity: On 2026-02-09: HEARTBEAT_OK' },
        claimSignal: { topic: 'ops', subtopic: 'identity_diagnostic' },
      }),
      'ops_runbook',
      'diagnostic agent identity rows should not stay in durable personal memory',
    );
    assert.equal(
      resolveMemoryTier({
        row: { type: 'USER_FACT', content: 'Chris — Telegram: 779443319 (@legendary_gainz)' },
        claimSignal: { topic: 'contact', subtopic: 'telegram.primary' },
      }),
      'working_reference',
      'contact facts should not enter default durable recall tiers',
    );
    assert.equal(
      resolveMemoryTier({
        row: { type: 'USER_FACT', content: 'The repo codename is Atlas Beacon.' },
      }),
      'durable_project',
      'stable project identity facts like repo codenames should stay recallable',
    );

    const empty = rebuildWorldModel({ db, config, now: '2026-03-08T11:00:00.000Z' });
    assert.equal(empty.cleared, true, 'empty world rebuild should stay empty instead of generating ghost syntheses');
    assert.equal(empty.counts.syntheses, 0, 'empty world rebuild should not emit syntheses');

    seedMemoryCurrent(db, [
      {
        memory_id: 'm-1',
        type: 'USER_FACT',
        content: 'Liz is Chris partner and lives in Vienna.',
        scope: 'nimbusmain',
        confidence: 0.92,
        created_at: '2026-03-08T11:00:00.000Z',
        updated_at: '2026-03-08T11:00:00.000Z',
      },
      {
        memory_id: 'm-1b',
        type: 'USER_FACT',
        content: 'Liz is a mail friend of the agent.',
        scope: 'nimbusmain',
        confidence: 0.9,
        created_at: '2026-03-08T11:00:10.000Z',
        updated_at: '2026-03-08T11:00:10.000Z',
      },
      {
        memory_id: 'm-1c',
        type: 'USER_FACT',
        content: 'Liz prefers structured Memory-Notes.',
        scope: 'nimbusmain',
        confidence: 0.95,
        created_at: '2026-03-08T11:00:20.000Z',
        updated_at: '2026-03-08T11:00:20.000Z',
      },
      {
        memory_id: 'm-2',
        type: 'USER_FACT',
        content: 'Liz lives in Graz now.',
        scope: 'nimbusmain',
        confidence: 0.82,
        created_at: '2026-03-08T11:01:00.000Z',
        updated_at: '2026-03-08T11:01:00.000Z',
      },
      {
        memory_id: 'm-3',
        type: 'EPISODE',
        content: 'The Tria interview happened on January 29 2026 and went well.',
        scope: 'shared',
        confidence: 0.8,
        content_time: '2026-01-29',
        created_at: '2026-03-08T11:02:00.000Z',
        updated_at: '2026-03-08T11:02:00.000Z',
      },
      {
        memory_id: 'm-4',
        type: 'CONTEXT',
        content: 'Follow up with Tria the neobank about the next crypto banking update?',
        scope: 'shared',
        confidence: 0.72,
        created_at: '2026-03-08T11:03:00.000Z',
        updated_at: '2026-03-08T11:03:00.000Z',
      },
      {
        memory_id: 'm-5',
        type: 'USER_FACT',
        content: 'Liz is active in the poly community in Vienna.',
        scope: 'nimbusmain',
        confidence: 0.86,
        created_at: '2026-03-08T11:04:00.000Z',
        updated_at: '2026-03-08T11:04:00.000Z',
      },
      {
        memory_id: 'm-6',
        type: 'CONTEXT',
        content: 'January is an important topic for Tria planning.',
        scope: 'shared',
        confidence: 0.74,
        created_at: '2026-03-08T11:05:00.000Z',
        updated_at: '2026-03-08T11:05:00.000Z',
      },
      {
        memory_id: 'm-6b',
        type: 'EPISODE',
        content: 'Calorie tracker deep research uses Austrian terminology like Topfen and Semmel in one nutrition database.',
        scope: 'shared',
        confidence: 0.86,
        created_at: '2026-03-08T11:05:30.000Z',
        updated_at: '2026-03-08T11:05:30.000Z',
      },
      {
        memory_id: 'm-6c',
        type: 'CONTEXT',
        content: 'Chrome remote debugging öffnen, Email eingeben, Verify code klicken und Cookies speichern. Tria ist die Neobank, nicht Setup.',
        scope: 'shared',
        confidence: 0.78,
        created_at: '2026-03-08T11:05:40.000Z',
        updated_at: '2026-03-08T11:05:40.000Z',
      },
      {
        memory_id: 'm-6d',
        type: 'USER_FACT',
        content: 'Samira Zumstein is a social worker and dates Chris.',
        scope: 'shared',
        confidence: 0.86,
        created_at: '2026-03-08T11:05:50.000Z',
        updated_at: '2026-03-08T11:05:50.000Z',
      },
      {
        memory_id: 'm-6e',
        type: 'USER_FACT',
        content: 'Elisabeth Rieder is Chris partner and works in relationship counseling.',
        scope: 'nimbusmain',
        confidence: 0.9,
        created_at: '2026-03-08T11:05:55.000Z',
        updated_at: '2026-03-08T11:05:55.000Z',
      },
      {
        memory_id: 'm-6f',
        type: 'CONTEXT',
        content: '2026-02-27 heartbeat: New unread emails in nimbus@agentmail.to — Elisabeth Rieder replied and shared update details.',
        scope: 'nimbusmain',
        confidence: 0.82,
        created_at: '2026-03-08T11:05:56.000Z',
        updated_at: '2026-03-08T11:05:56.000Z',
      },
      {
        memory_id: 'm-6g',
        type: 'USER_FACT',
        content: 'Chris — Telegram: 779443319 (@legendary_gainz)',
        scope: 'shared',
        confidence: 0.9,
        created_at: '2026-03-08T11:05:57.000Z',
        updated_at: '2026-03-08T11:05:57.000Z',
      },
    ]);

    ensureNativeStore(db);
    rebuildEntityMentions(db);
    const summary = rebuildWorldModel({ db, config, now: '2026-03-08T12:00:00.000Z' });
    assert.equal(summary.ok, true);
    assert.equal(summary.counts.entities >= 2, true, 'world model should create at least two entities');
    assert.equal(summary.counts.beliefs >= 4, true, 'beliefs should be projected from active memories');
    assert.equal(summary.counts.episodes >= 1, true, 'temporal/episode memories should create episodes');
    assert.equal(summary.counts.open_loops >= 1, true, 'question/follow-up memories should create open loops');
    assert.equal(summary.counts.contradictions, 0, 'clear slot winners should auto-resolve instead of surfacing contradiction reviews by default');
    assert.equal(summary.counts.syntheses >= 5, true, 'entity and curated global syntheses should be created');

    const entities = listEntities(db, { limit: 20 });
    const liz = entities.find((entity) => entity.display_name.toLowerCase().includes('liz'));
    assert.equal(Boolean(liz), true, 'Liz entity should exist');
    assert.equal(entities.some((entity) => entity.entity_id === 'organization:tria'), true, 'strong alias-scoped organization entities should remain visible');

    const detail = getEntityDetail(db, liz.entity_id);
    assert.equal(detail.kind, 'person', 'relationship memory should classify Liz as a person');
    assert.equal(detail.beliefs.length >= 2, true, 'entity detail should include beliefs');
    assert.equal(detail.open_loops.length, 0, 'clear slot resolution should avoid user-facing review loops on stable entities');
    assert.equal(detail.syntheses.some((row) => ['entity_brief', 'relationship_brief'].includes(row.kind)), true, 'entity brief synthesis should exist');
    const lizSummary = pickSurfaceSummaryBelief(detail, detail.beliefs);
    assert.equal(Boolean(lizSummary), true, 'Liz should have a surface summary belief');
    assert.doesNotMatch(lizSummary.content, /mail friend|memory-?notes/i, 'surface summary should avoid weak meta-style facts');
    assert.match(lizSummary.content, /partner|community|lives/i, 'surface summary should prefer stable relationship/profile facts');

    const elisabeth = entities.find((entity) => entity.display_name.toLowerCase().includes('elisabeth'));
    assert.equal(Boolean(elisabeth), true, 'Elisabeth entity should exist');
    const elisabethDetail = getEntityDetail(db, elisabeth.entity_id);
    const elisabethSurfaceBeliefs = selectSurfaceBeliefsForEntity(elisabethDetail, elisabethDetail.beliefs, 3);
    assert.equal(elisabethSurfaceBeliefs.some((belief) => /agentmail|unread emails|heartbeat/i.test(belief.content)), false, 'surface beliefs should reject operational heartbeat snippets');
    assert.equal(elisabethSurfaceBeliefs.some((belief) => /relationship counseling|partner/i.test(belief.content)), true, 'surface beliefs should retain stable relationship/profile facts');

    const contradictions = listContradictions(db, { limit: 20 });
    assert.equal(contradictions.length, 0, 'auto-resolution should avoid contradiction rows when a stronger current location clearly wins');

    const syntheses = listSyntheses(db, { kind: 'session_brief', limit: 5 });
    assert.equal(syntheses.length >= 1, true, 'session brief synthesis should be present');
    assert.doesNotMatch(syntheses[0].content, /mail friend|memory-?notes/i, 'session brief should not surface weak meta-style facts');
    const currentState = listSyntheses(db, { kind: 'current_state', limit: 5 });
    assert.equal(currentState.length >= 1, true, 'current state synthesis should be present');
    assert.doesNotMatch(currentState[0].content, /telegram:\s*779443319|@legendary_gainz/i, 'current state should exclude contact-style Telegram facts');
    assert.doesNotMatch(currentState[0].content, /heartbeat|agentmail/i, 'current state should exclude operational heartbeat snippets');

    assert.equal(entities.some((entity) => entity.kind === 'topic'), false, 'strict topic mode should suppress weak topic entities from the surfaced entity list');
    assert.equal(entities.some((entity) => entity.entity_id === 'organization:austrian'), false, 'weak adjective-like organization aliases should not be promoted into world-model entities');
    assert.equal(entities.some((entity) => ['person:email', 'person:chrome', 'organization:neobank', 'project:setup', 'person:archive', 'person:contact', 'person:content', 'person:date', 'person:guest', 'person:link', 'person:name', 'person:notes', 'person:person', 'person:status'].includes(entity.entity_id)), false, 'operational nouns and descriptor labels should not surface as world-model entities');
    assert.equal(entities.some((entity) => ['person:freundin', 'person:sozialarbeiterin', 'person:zumstein'].includes(entity.entity_id)), false, 'role labels and redundant surname-only entities should stay out of the surfaced entity list');

    const warm = ensureWorldModelReady({ db, config, rebuildIfEmpty: true });
    assert.equal(warm.rebuilt, false, 'warm check should not rebuild once data exists');

    seedMemoryCurrent(db, [
      {
        memory_id: 'm-7',
        type: 'USER_FACT',
        content: 'Liz now works in Graz as a coach.',
        scope: 'nimbusmain',
        confidence: 0.84,
        updated_at: '2026-03-08T12:05:00.000Z',
        created_at: '2026-03-08T12:05:00.000Z',
      },
    ]);
    rebuildEntityMentions(db);
    const refreshed = ensureWorldModelReady({ db, config, rebuildIfEmpty: true });
    assert.equal(refreshed.rebuilt, true, 'world model should refresh when newer atomic memories exist');

    const bulkNow = '2026-03-08T12:10:00.000Z';
    const insertEntity = db.prepare(`
      INSERT INTO memory_entities (
        entity_id, kind, display_name, normalized_name, status, confidence, aliases, created_at, updated_at, payload
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (let i = 0; i < 6001; i += 1) {
      insertEntity.run(
        `person:bulk-${i}`,
        'person',
        `Bulk ${i}`,
        `bulk ${i}`,
        'active',
        0.8,
        '[]',
        bulkNow,
        new Date(Date.parse(bulkNow) + i).toISOString(),
        '{}',
      );
    }
    assert.equal(Boolean(getEntityDetail(db, 'person:bulk-6000')), true, 'entity detail should not fail just because more than 5000 entities exist');

    db.exec('DELETE FROM memory_current');
    const cleared = ensureWorldModelReady({ db, config, rebuildIfEmpty: true });
    assert.equal(cleared.cleared, true, 'world model should clear stale projections when the atomic layer becomes empty');
    assert.equal(listEntities(db, { limit: 20 }).length, 0, 'entity projection should be empty after clearing');
    assert.equal(listSyntheses(db, { limit: 20 }).length, 0, 'syntheses should be cleared alongside stale entities/beliefs');
  } finally {
    db.close();
  }
};

export { run };
