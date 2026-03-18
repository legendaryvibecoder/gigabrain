import assert from 'node:assert/strict';

import { BM25Index, bm25Score, tokenize } from '../lib/core/bm25.js';

const run = async () => {
  assert.deepEqual(
    tokenize('The quick graph rollout and the nightly pipeline'),
    ['quick', 'graph', 'rollout', 'nightly', 'pipeline'],
    'tokenizer should drop common stopwords and punctuation',
  );
  assert.deepEqual(
    tokenize('Übermäßige, graph-basierte Prüfung! und/oder release...'),
    ['übermäßige', 'graph', 'basierte', 'prüfung', 'release'],
    'tokenizer should preserve umlauts, split punctuation, and keep bilingual signal terms',
  );
  assert.deepEqual(tokenize(''), [], 'tokenizer should return an empty array for empty strings');
  assert.deepEqual(
    tokenize('the und der and ist'),
    [],
    'tokenizer should drop all-stopword queries cleanly',
  );

  const directScore = bm25Score({
    queryTokens: ['graph', 'rollout'],
    docTokens: ['graph', 'rollout', 'rollout', 'pipeline'],
    avgDl: 4,
    docCount: 3,
    df: { graph: 2, rollout: 1 },
  });
  assert.equal(directScore > 0, true, 'direct BM25 scoring should reward term hits');
  assert.equal(bm25Score({
    queryTokens: ['graph'],
    docTokens: ['winter', 'coffee'],
    avgDl: 2,
    docCount: 3,
    df: { graph: 1 },
  }), 0, 'direct BM25 scoring should be zero for complete misses');
  const repeatedScore = bm25Score({
    queryTokens: ['graph'],
    docTokens: ['graph', 'graph', 'graph', 'pipeline'],
    avgDl: 4,
    docCount: 4,
    df: { graph: 2 },
  });
  const singleHitScore = bm25Score({
    queryTokens: ['graph'],
    docTokens: ['graph', 'pipeline', 'note', 'todo'],
    avgDl: 4,
    docCount: 4,
    df: { graph: 2 },
  });
  assert.equal(
    repeatedScore > singleHitScore,
    true,
    'repeated relevant terms should still improve BM25 score over a single hit',
  );

  const index = new BM25Index();
  index.buildIndex([
    { id: 'exact', text: 'graph rollout graph rollout checklist' },
    { id: 'partial', text: 'graph note for later' },
    { id: 'de', text: 'prüfung zum graph rollout in berlin' },
    { id: 'miss', text: 'winter coffee preference' },
  ]);

  const ranked = index.rank('graph rollout', 3);
  assert.equal(ranked[0]?.id, 'exact', 'BM25 index should rank denser lexical matches ahead of weaker rows');
  assert.equal(ranked[1]?.id, 'de', 'BM25 index should keep bilingual lexical matches ahead of weaker partial rows');
  assert.equal(ranked[2]?.id, 'partial', 'BM25 index should retain weaker partial hits after stronger matches');
  assert.equal(ranked.some((row) => row.id === 'miss'), false, 'BM25 index should exclude complete misses');

  const shortBiasIndex = new BM25Index({ k1: 1.1, b: 0.2 });
  shortBiasIndex.buildIndex([
    { id: 'exact', text: 'graph rollout graph rollout checklist' },
    { id: 'partial', text: 'graph rollout note' },
    { id: 'noisy', text: 'graph rollout note note note note note note note' },
  ]);
  const defaultOrder = new BM25Index({ k1: 1.5, b: 0.75 });
  defaultOrder.buildIndex([
    { id: 'exact', text: 'graph rollout graph rollout checklist' },
    { id: 'partial', text: 'graph rollout note' },
    { id: 'noisy', text: 'graph rollout note note note note note note note' },
  ]);
  assert.equal(
    defaultOrder.rank('graph rollout', 3)[0]?.id,
    'exact',
    'default BM25 parameters should keep the exact match first',
  );
  assert.equal(
    shortBiasIndex.rank('graph rollout', 3)[0]?.id,
    'exact',
    'alternate BM25 parameters should not invert the strongest lexical result',
  );
};

export { run };
