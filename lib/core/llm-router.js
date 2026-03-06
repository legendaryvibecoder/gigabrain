const DEFAULT_TIMEOUT_MS = 12000;
const DEFAULT_MODEL = 'qwen3.5:9b';
const DEFAULT_TASK_PROFILES = Object.freeze({
  memory_review: Object.freeze({
    model: DEFAULT_MODEL,
    temperature: 0.15,
    top_p: 0.8,
    top_k: 20,
    max_tokens: 180,
    reasoning: 'off',
  }),
  extraction_json: Object.freeze({
    model: DEFAULT_MODEL,
    temperature: 0.1,
    top_p: 0.75,
    top_k: 20,
    max_tokens: 220,
    reasoning: 'off',
  }),
  memory_canonicalize: Object.freeze({
    model: DEFAULT_MODEL,
    temperature: 0.2,
    top_p: 0.85,
    top_k: 30,
    max_tokens: 220,
    reasoning: 'off',
  }),
  chat_general: Object.freeze({
    model: 'qwen3.5:latest',
    temperature: 1,
    top_p: 0.95,
    top_k: 40,
    max_tokens: 1200,
    reasoning: 'default',
  }),
});

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));
const clampInt = (value, min, max, fallback) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
};

const normalizeProvider = (provider) => {
  const key = String(provider || '').trim().toLowerCase();
  if (['openclaw', 'openai_compatible', 'ollama', 'none'].includes(key)) return key;
  return 'none';
};

const normalizeReasoningMode = (value, fallback = 'off') => {
  const key = String(value || fallback).trim().toLowerCase();
  if (['off', 'default'].includes(key)) return key;
  return fallback;
};

const normalizeTaskProfiles = (rawProfiles = {}) => {
  const out = {};
  for (const [key, defaults] of Object.entries(DEFAULT_TASK_PROFILES)) {
    const raw = rawProfiles && typeof rawProfiles === 'object' ? rawProfiles[key] : null;
    out[key] = {
      model: String(raw?.model || defaults.model || DEFAULT_MODEL),
      temperature: clamp01(raw?.temperature ?? defaults.temperature),
      top_p: clamp01(raw?.top_p ?? defaults.top_p),
      top_k: clampInt(raw?.top_k ?? defaults.top_k, 1, 200, defaults.top_k),
      max_tokens: clampInt(raw?.max_tokens ?? defaults.max_tokens, 32, 8192, defaults.max_tokens),
      reasoning: normalizeReasoningMode(raw?.reasoning ?? defaults.reasoning, defaults.reasoning),
    };
  }
  return out;
};

const resolveTaskProfile = ({ taskProfiles, profile, model } = {}) => {
  const normalizedProfiles = normalizeTaskProfiles(taskProfiles);
  const key = String(profile || 'memory_review').trim();
  const resolved = normalizedProfiles[key] || normalizedProfiles.memory_review || DEFAULT_TASK_PROFILES.memory_review;
  return {
    ...resolved,
    model: String(model || resolved.model || DEFAULT_MODEL),
  };
};

const buildReviewPrompt = ({ memory, deterministic }) => {
  const content = String(memory?.content || '').trim();
  const type = String(memory?.type || 'CONTEXT').trim().toUpperCase();
  const scope = String(memory?.scope || 'shared');
  const score = Number.isFinite(Number(deterministic?.value_score)) ? Number(deterministic.value_score).toFixed(4) : '0.5000';
  return [
    'You are reviewing one memory item for retention quality.',
    'Return ONLY compact JSON with this schema:',
    '{"decision":"keep|archive|reject|merge_candidate","confidence":0..1,"reason":"short string","canonical_hint":"optional short rewrite"}',
    'Rules:',
    '- Prefer keep/archive over reject unless clearly junk/system-wrapper.',
    '- Preserve user preference, durable user facts, ongoing goals, communication preferences, relationship memories, and agent identity memories.',
    '- Do not archive a memory only because it is emotional, relational, identity-shaping, or important to continuity between user and agent.',
    '- Reject only hard junk/system artifacts.',
    '- Prefer archive for malformed wording, broken noun phrases, or corrupted paraphrases.',
    '- Use canonical_hint only when the content looks corrupted but the core fact is still inferable.',
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
        canonical_hint: String(parsed.canonical_hint || '').trim().slice(0, 240),
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
    canonical_hint: '',
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
  profile,
}) => {
  const endpoint = `${String(baseUrl || '').replace(/\/+$/, '')}/chat/completions`;
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const payload = {
    model: String(model || profile.model || 'gpt-4o-mini'),
    messages: [
      { role: 'system', content: 'Return compact JSON only.' },
      { role: 'user', content: prompt },
    ],
    temperature: profile.temperature,
    top_p: profile.top_p,
    max_tokens: profile.max_tokens,
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
  profile,
}) => {
  const endpoint = `${String(baseUrl || '').replace(/\/+$/, '')}/api/generate`;
  const payload = {
    model: String(model || profile.model || DEFAULT_MODEL),
    prompt,
    format: 'json',
    stream: false,
    options: {
      temperature: profile.temperature,
      top_p: profile.top_p,
      top_k: profile.top_k,
      num_predict: profile.max_tokens,
    },
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
  return parseLlmReview(data?.response || data?.thinking || data?.message?.content || '');
};

const reviewViaOpenclaw = async ({
  baseUrl,
  model,
  apiKey,
  prompt,
  timeoutMs,
  profile,
}) => {
  return reviewViaOpenAiCompatible({
    baseUrl: baseUrl || '',
    model: model || 'kimi-k2-instruct',
    apiKey,
    prompt,
    timeoutMs,
    profile,
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
  taskProfiles,
  profile,
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
  const resolvedProfile = resolveTaskProfile({
    taskProfiles,
    profile,
    model,
  });
  try {
    let parsed = null;
    if (resolvedProvider === 'openai_compatible') {
      parsed = await reviewViaOpenAiCompatible({
        baseUrl,
        model,
        apiKey,
        prompt,
        timeoutMs,
        profile: resolvedProfile,
      });
    } else if (resolvedProvider === 'ollama') {
      parsed = await reviewViaOllama({
        baseUrl: baseUrl || 'http://127.0.0.1:11434',
        model: model || resolvedProfile.model || DEFAULT_MODEL,
        prompt,
        timeoutMs,
        profile: resolvedProfile,
      });
    } else if (resolvedProvider === 'openclaw') {
      parsed = await reviewViaOpenclaw({
        baseUrl,
        model,
        apiKey,
        prompt,
        timeoutMs,
        profile: resolvedProfile,
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
      canonical_hint: parsed.canonical_hint || '',
    };
  } catch (err) {
    return {
      ok: false,
      provider: resolvedProvider,
      error: err instanceof Error ? err.message : String(err),
      decision: null,
      confidence: null,
      reason: '',
      canonical_hint: '',
    };
  }
};

export {
  DEFAULT_TASK_PROFILES,
  normalizeProvider,
  normalizeTaskProfiles,
  resolveTaskProfile,
  buildReviewPrompt,
  parseLlmReview,
  reviewWithLlm,
};
