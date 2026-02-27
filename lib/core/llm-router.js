const DEFAULT_TIMEOUT_MS = 12000;

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

const normalizeProvider = (provider) => {
  const key = String(provider || '').trim().toLowerCase();
  if (['openclaw', 'openai_compatible', 'ollama', 'none'].includes(key)) return key;
  return 'none';
};

const buildReviewPrompt = ({ memory, deterministic }) => {
  const content = String(memory?.content || '').trim();
  const type = String(memory?.type || 'CONTEXT').trim().toUpperCase();
  const scope = String(memory?.scope || 'shared');
  const score = Number.isFinite(Number(deterministic?.value_score)) ? Number(deterministic.value_score).toFixed(4) : '0.5000';
  return [
    'You are reviewing one memory item for retention quality.',
    'Return ONLY compact JSON with this schema:',
    '{"decision":"keep|archive|reject|merge_candidate","confidence":0..1,"reason":"short string"}',
    'Rules:',
    '- Prefer keep/archive over reject unless clearly junk/system-wrapper.',
    '- Preserve user preference, relationship, and agent identity memories.',
    '- Reject only hard junk/system artifacts.',
    '',
    `type=${type}`,
    `scope=${scope}`,
    `deterministic_value_score=${score}`,
    `deterministic_action=${String(deterministic?.action || 'keep')}`,
    `content=${JSON.stringify(content)}`,
  ].join('\n');
};

const extractJsonObject = (value) => {
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // continue
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
};

const parseDecision = (value) => {
  const key = String(value || '').trim().toLowerCase();
  if (key === 'keep') return 'keep';
  if (key === 'archive') return 'archive';
  if (key === 'reject') return 'reject';
  if (key === 'merge_candidate' || key === 'merge-candidate' || key === 'merge candidate') return 'merge_candidate';
  return null;
};

const parseLlmReview = (payload) => {
  const parsed = payload && typeof payload === 'object'
    ? payload
    : extractJsonObject(payload);
  if (parsed && typeof parsed === 'object') {
    const decision = parseDecision(parsed.decision);
    if (decision) {
      return {
        decision,
        confidence: clamp01(parsed.confidence ?? parsed.score ?? 0.5),
        reason: String(parsed.reason || '').trim().slice(0, 240),
      };
    }
  }
  const text = String(payload || '').trim();
  if (!text) return null;
  const loose = text.match(/\b(keep|archive|reject|merge[_\-\s]?candidate)\b/i);
  if (!loose) return null;
  const decision = parseDecision(loose[1]);
  if (!decision) return null;
  return {
    decision,
    confidence: clamp01(0.5),
    reason: text.replace(/\s+/g, ' ').slice(0, 240),
  };
};

const fetchWithTimeout = async (url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.max(1000, timeoutMs));
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
};

const reviewViaOpenAiCompatible = async ({
  baseUrl,
  model,
  apiKey,
  prompt,
  timeoutMs,
}) => {
  const endpoint = `${String(baseUrl || '').replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const payload = {
    model: String(model || 'gpt-4o-mini'),
    messages: [
      { role: 'system', content: 'Return compact JSON only.' },
      { role: 'user', content: prompt },
    ],
    temperature: 0,
    max_tokens: 180,
  };
  const res = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  }, timeoutMs);
  if (!res.ok) {
    throw new Error(`openai_compatible http=${res.status}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? '';
  return parseLlmReview(content);
};

const reviewViaOllama = async ({
  baseUrl,
  model,
  prompt,
  timeoutMs,
}) => {
  const endpoint = `${String(baseUrl || '').replace(/\/+$/, '')}/api/generate`;
  const payload = {
    model: String(model || 'qwen2.5:14b'),
    prompt,
    stream: false,
    options: { temperature: 0 },
  };
  const res = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, timeoutMs);
  if (!res.ok) {
    throw new Error(`ollama http=${res.status}`);
  }
  const data = await res.json();
  return parseLlmReview(data?.response ?? '');
};

const reviewViaOpenclaw = async ({
  baseUrl,
  model,
  apiKey,
  prompt,
  timeoutMs,
}) => {
  return reviewViaOpenAiCompatible({
    baseUrl: baseUrl || '',
    model: model || 'kimi-k2-instruct',
    apiKey,
    prompt,
    timeoutMs,
  });
};

const reviewWithLlm = async ({
  provider,
  baseUrl,
  model,
  apiKey,
  timeoutMs,
  memory,
  deterministic,
}) => {
  const resolvedProvider = normalizeProvider(provider);
  if (resolvedProvider === 'none') {
    return {
      ok: false,
      provider: 'none',
      error: 'llm-provider-none',
      decision: null,
      confidence: null,
      reason: '',
    };
  }

  const prompt = buildReviewPrompt({ memory, deterministic });
  try {
    let parsed = null;
    if (resolvedProvider === 'openai_compatible') {
      parsed = await reviewViaOpenAiCompatible({
        baseUrl,
        model,
        apiKey,
        prompt,
        timeoutMs,
      });
    } else if (resolvedProvider === 'ollama') {
      parsed = await reviewViaOllama({
        baseUrl: baseUrl || 'http://127.0.0.1:11434',
        model: model || 'qwen2.5:14b',
        prompt,
        timeoutMs,
      });
    } else if (resolvedProvider === 'openclaw') {
      parsed = await reviewViaOpenclaw({
        baseUrl,
        model,
        apiKey,
        prompt,
        timeoutMs,
      });
    }

    if (!parsed) {
      return {
        ok: false,
        provider: resolvedProvider,
        error: 'llm-empty-or-unparseable',
        decision: null,
        confidence: null,
        reason: '',
      };
    }
    return {
      ok: true,
      provider: resolvedProvider,
      error: null,
      decision: parsed.decision,
      confidence: clamp01(parsed.confidence),
      reason: parsed.reason || '',
    };
  } catch (err) {
    return {
      ok: false,
      provider: resolvedProvider,
      error: err instanceof Error ? err.message : String(err),
      decision: null,
      confidence: null,
      reason: '',
    };
  }
};

export {
  normalizeProvider,
  buildReviewPrompt,
  parseLlmReview,
  reviewWithLlm,
};
