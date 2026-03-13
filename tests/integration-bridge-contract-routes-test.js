import assert from 'node:assert/strict';
import http from 'node:http';

import { normalizeConfig } from '../lib/core/config.js';
import { createMemoryHttpHandler } from '../lib/core/http-routes.js';
import { makeTempWorkspace, makeConfigObject, writeConfigFile, openDb, seedMemoryCurrent } from './helpers.js';

const startServer = async (handler) => {
  const server = http.createServer(async (req, res) => {
    const handled = await handler(req, res);
    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not handled');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind server');
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
};

const run = async () => {
  const ws = makeTempWorkspace('gb-v3-bridge-api-');
  const configObject = makeConfigObject(ws.workspace);
  writeConfigFile(ws.configPath, configObject);

  const db = openDb(ws.dbPath);
  try {
    seedMemoryCurrent(db, [
      {
        memory_id: '11111111-2222-3333-4444-555555555555',
        type: 'USER_FACT',
        content: 'Sam ist dein Partner und Lebens- und Sozialberater.',
        normalized: 'sam ist dein partner und lebens und sozialberater',
        scope: 'shared',
        confidence: 0.92,
        value_score: 0.95,
      },
    ]);
  } finally {
    db.close();
  }

  const handler = createMemoryHttpHandler({
    dbPath: ws.dbPath,
    config: normalizeConfig(configObject.plugins.entries.gigabrain.config),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    token: 'gb-token',
  });

  const { server, baseUrl } = await startServer(handler);
  try {
    const unauthorized = await fetch(`${baseUrl}/gb/recall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'Wer ist Sam?' }),
    });
    assert.equal(unauthorized.status, 401, 'recall endpoint must require token when configured');

    const recallRes = await fetch(`${baseUrl}/gb/recall`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-gb-token': 'gb-token',
      },
      body: JSON.stringify({ query: 'Wer ist Sam?', topK: 3 }),
    });
    assert.equal(recallRes.ok, true, '/gb/recall should return 200');
    const recallJson = await recallRes.json();
    assert.equal(recallJson.ok, true);
    assert.equal(recallJson.schema_version, '1.0');
    assert.equal(Array.isArray(recallJson.results), true);
    assert.equal(recallJson.results.length >= 1, true, 'recall should return at least one memory');

    const top = recallJson.results[0];
    assert.equal(Number.isFinite(Number(top.score)), true, 'score must be numeric');
    assert.equal(Number(top.score) > 0, true, 'score must map from internal _score and be positive here');
    assert.equal(['vector', 'hybrid'].includes(String(top.rank_source)), true, 'rank_source must be present and valid');

    const longBearerPadding = '  '.repeat(2048);
    const bearerRecallRes = await fetch(`${baseUrl}/gb/recall`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${longBearerPadding}gb-token`,
      },
      body: JSON.stringify({ query: 'Wer ist Sam?', topK: 3 }),
    });
    assert.equal(bearerRecallRes.ok, true, 'bearer token auth should stay valid with long whitespace padding');

    const malformedBearerRes = await fetch(`${baseUrl}/gb/recall`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${longBearerPadding}`,
      },
      body: JSON.stringify({ query: 'Wer ist Sam?', topK: 3 }),
    });
    assert.equal(malformedBearerRes.status, 401, 'malformed long bearer headers must fail closed');

    const badSuggestions = await fetch(`${baseUrl}/gb/suggestions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-gb-token': 'gb-token',
      },
      body: JSON.stringify({}),
    });
    assert.equal(badSuggestions.status, 400, 'suggestions endpoint validates payload shape');

    const suggestionsRes = await fetch(`${baseUrl}/gb/suggestions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-gb-token': 'gb-token',
      },
      body: JSON.stringify({
        schema_version: '1.0',
        trace_id: 'trace-test-1',
        suggestions: [
          {
            content: 'Sam ist dein Partner und arbeitet als Lebens- und Sozialberater.',
            type: 'USER_FACT',
            confidence: 0.88,
          },
        ],
      }),
    });
    assert.equal(suggestionsRes.ok, true, '/gb/suggestions should accept valid structured suggestions');
    const suggestionsJson = await suggestionsRes.json();
    assert.equal(suggestionsJson.ok, true);
    assert.equal(suggestionsJson.schema_version, '1.0');
    assert.equal(Number(suggestionsJson.received) >= 1, true);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve(undefined))));
  }
};

export { run };
