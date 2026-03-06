import assert from 'node:assert/strict';
import http from 'node:http';

import { reviewWithLlm } from '../lib/core/llm-router.js';

const startMockServer = async () => {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/chat/completions' && req.method === 'POST') {
      const body = [];
      for await (const chunk of req) body.push(chunk);
      const parsed = JSON.parse(Buffer.concat(body).toString('utf8'));
      if (Number(parsed.temperature) !== 0.15) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('unexpected temperature');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({ decision: 'keep', confidence: 0.91, reason: 'mock-openai-compatible' }),
            },
          },
        ],
      }));
      return;
    }
    if (url.pathname === '/api/generate' && req.method === 'POST') {
      const body = [];
      for await (const chunk of req) body.push(chunk);
      const parsed = JSON.parse(Buffer.concat(body).toString('utf8'));
      if (
        Number(parsed?.options?.temperature) !== 0.15
        || Number(parsed?.options?.top_k) !== 20
        || parsed?.format !== 'json'
      ) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('unexpected ollama profile');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        response: '',
        thinking: JSON.stringify({ decision: 'archive', confidence: 0.83, reason: 'mock-ollama', canonical_hint: 'Chris started his weight loss journey on January 11, 2026 at 90kg.' }),
      }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('not found');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Failed to bind mock server');
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
};

const run = async () => {
  const { server, baseUrl } = await startMockServer();
  try {
    const memory = {
      type: 'PREFERENCE',
      scope: 'shared',
      content: 'User likes Mozzarella',
    };
    const deterministic = {
      action: 'archive',
      value_score: 0.5,
    };

    const none = await reviewWithLlm({
      provider: 'none',
      memory,
      deterministic,
    });
    assert.equal(none.ok, false);

    const openaiCompat = await reviewWithLlm({
      provider: 'openai_compatible',
      baseUrl,
      model: 'mock-model',
      timeoutMs: 5000,
      memory,
      deterministic,
      profile: 'memory_review',
    });
    assert.equal(openaiCompat.ok, true);
    assert.equal(openaiCompat.decision, 'keep');

    const openclaw = await reviewWithLlm({
      provider: 'openclaw',
      baseUrl,
      model: 'mock-model',
      timeoutMs: 5000,
      memory,
      deterministic,
      profile: 'memory_review',
    });
    assert.equal(openclaw.ok, true);
    assert.equal(openclaw.decision, 'keep');

    const ollama = await reviewWithLlm({
      provider: 'ollama',
      baseUrl,
      model: 'mock-model',
      timeoutMs: 5000,
      memory,
      deterministic,
      profile: 'memory_review',
    });
    assert.equal(ollama.ok, true);
    assert.equal(ollama.decision, 'archive');
    assert.equal(ollama.canonical_hint.includes('weight loss journey'), true);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve(undefined))));
  }
};

export { run };
