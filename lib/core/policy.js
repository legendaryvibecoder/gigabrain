import crypto from 'node:crypto';

const DEFAULT_JUNK_PATTERNS_BASE = Object.freeze([
  '<memory_clusters>',
  '<working_memory>',
  '<recalled_memories>',
  '<agent_profile>',
  '<user_profile>',
  '<gigabrain-context>',
  '<context>',
  '<system>',
  '<tool_output>',
  'Read HEARTBEAT',
  'A new session was started',
  'System:',
  'API_KEY=',
  '_API_KEY=',
  'SECRET=',
  'PASSWORD=',
  'Template placeholder',
  'benchmark',
  'mb:',
  'smoke test',
  '^\\(none\\)$',
  'Post-Compaction Audit',
  '\\[Subagent Context\\]',
  'Exec completed \(',
  'Conversation info \(untrusted metadata\)',
  '\[System Message\] \[sessionId:',
  'compaction audit',
  'subagent.*depth \d+/\d+',
]);

const DEFAULT_HIGH_VALUE_SHORT_PATTERNS_BASE = Object.freeze([
  '\\b(?:user|owner)\\s+(?:likes?|loves?|prefers?|dislikes?|hates?)\\b',
  '\\b(?:i|ich)\\s+(?:like|love|prefer|mag|liebe|bevorzuge)\\b',
  '\\b(?:pronouns?|pronomen)\\b',
  '\\b(?:partner(?:in)?|wife|husband|girlfriend|boyfriend|friend|mentor|sibling)\\b',
  '\\b(?:proud of|stolz auf|grateful|dankbar|appreciates?|sch[aä]tzt|supports?|unterst[uü]tzt|trusts?|vertraut)\\b',
]);

const DEFAULT_DURABLE_PATTERNS_BASE = Object.freeze([
  '\\b(?:user|owner)\\s+(?:likes?|loves?|prefers?|dislikes?|hates?)\\b',
  '\\b(?:proud of|stolz auf|grateful|dankbar|appreciates?|sch[aä]tzt|supports?|unterst[uü]tzt|trusts?|vertraut)\\b',
  '\\b(?:partner(?:in)?|wife|husband|girlfriend|boyfriend|best friend|mentor|sibling)\\b',
  '\\b(?:pronouns?|pronomen)\\b',
  '\\b(?:identity|personality|continuity|evolution)\\b',
]);

const DEFAULT_VALUE_THRESHOLDS = Object.freeze({
  keep: 0.75,
  archive: 0.45,
  reject: 0.45,
});

const PERSONAL_PREF_RE = /\b(?:user|owner)\s+(?:likes?|loves?|prefers?|dislikes?|hates?)\b/i;
const RELATIONSHIP_RE = /\b(?:partner(?:in)?|wife|husband|girlfriend|boyfriend|friend|mentor|sibling|proud of|stolz auf|grateful|dankbar)\b/i;
const AGENT_IDENTITY_RE = /\b(?:agent identity|agent profile|my personality|agent continuity|agent evolution)\b/i;
const OPS_NOISE_RE = /\b(?:run:|script|cron|pipeline|phase\s+\d+|openclaw\s+update|todo:|implement(?:ed|ation)?|patch-round|worker\.sh)\b/i;
const SPECIFICITY_LOW_RE = /\b(?:something|anything|stuff|things|general update|status update)\b/i;
const WRAPPER_RE = /<\/?(?:memory_clusters|working_memory|recalled_memories|agent_profile|user_profile|gigabrain-context|context|system|tool_output)\b/i;

const clamp01 = (value) => Math.max(0, Math.min(1, Number(value) || 0));

const normalizeStringArray = (value) => (
  Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : []
);

const dedupeStrings = (values = []) => {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const key = String(value || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
};

const compilePatterns = (patterns = []) => {
  const compiled = [];
  for (const raw of patterns) {
    if (raw instanceof RegExp) {
      compiled.push(raw);
      continue;
    }
    const text = String(raw || '').trim();
    if (!text) continue;
    try {
      compiled.push(new RegExp(text, 'i'));
    } catch {
      const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      compiled.push(new RegExp(escaped, 'i'));
    }
  }
  return compiled;
};

const composePatterns = ({
  base = [],
  append = [],
  replace = false,
}) => {
  if (replace) {
    const replacement = dedupeStrings(append);
    return replacement.length > 0 ? replacement : dedupeStrings(base);
  }
  return dedupeStrings([...base, ...append]);
};

const normalizeContent = (value) => {
  const text = String(value || '').trim();
  if (!text) return '';
  return text
    .toLowerCase()
    .replace(/\[m:[0-9a-f-]{8,}\]/gi, '')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
};

const tokenizeWords = (value) => normalizeContent(value).split(/\s+/).filter(Boolean);

const countDistinctTokens = (value) => new Set(tokenizeWords(value)).size;

const hashNormalized = (value) => {
  const normalized = normalizeContent(value);
  if (!normalized) return '';
  return crypto.createHash('sha1').update(normalized).digest('hex');
};

const isHighValueShort = (content, options = {}) => {
  if (options.enabled === false) return false;
  const text = String(content || '').trim();
  if (!text) return false;
  if (text.length < 8) return false;
  return (options.patterns || []).some((regex) => regex.test(text));
};

const isDurable = (content, options = {}) => {
  if (options.enabled === false) return false;
  const text = String(content || '').trim();
  if (!text) return false;
  return (options.patterns || []).some((regex) => regex.test(text));
};

const detectMetadataNoise = (text) => {
  const trimmed = String(text || '').trim();
  if (!trimmed) return true;
  if (/^\[[^\]]+\]$/.test(trimmed)) return true;
  if (/^m:[0-9a-f-]{8,}$/i.test(trimmed)) return true;
  if (/^[A-Z_]+=$/.test(trimmed)) return true;
  const letters = (trimmed.match(/[a-z]/gi) || []).length;
  const digits = (trimmed.match(/[0-9]/g) || []).length;
  const punctuation = (trimmed.match(/[^a-z0-9\s]/gi) || []).length;
  if (letters <= 3 && (digits + punctuation) >= Math.max(6, trimmed.length * 0.6)) return true;
  if (/^(todo|tbd|n\/a|none)$/i.test(trimmed)) return true;
  return false;
};

const detectJunk = (content, options = {}) => {
  const text = String(content || '').trim();
  const minChars = Math.max(1, Number(options.minChars || 25));
  const highValueShort = isHighValueShort(text, {
    enabled: options.highValueShortEnabled,
    patterns: options.highValueShortPatterns,
  });

  if (!text) return { junk: true, reason: 'empty', matchedPattern: null };
  if (WRAPPER_RE.test(text)) return { junk: true, reason: 'junk_wrapper', matchedPattern: WRAPPER_RE.source };
  if (text.length < minChars && !highValueShort) return { junk: true, reason: 'too_short', matchedPattern: null };
  for (const pattern of options.junkPatterns || []) {
    if (pattern.test(text)) {
      return {
        junk: true,
        reason: 'junk_pattern',
        matchedPattern: pattern.source,
      };
    }
  }
  if (detectMetadataNoise(text)) return { junk: true, reason: 'metadata_noise', matchedPattern: null };
  return { junk: false, reason: null, matchedPattern: null };
};

const baseTypeUtilityScore = (type) => {
  const normalized = String(type || '').trim().toUpperCase();
  switch (normalized) {
    case 'USER_FACT':
      return 0.9;
    case 'PREFERENCE':
      return 0.92;
    case 'ENTITY':
      return 0.85;
    case 'AGENT_IDENTITY':
      return 1;
    case 'DECISION':
      return 0.75;
    case 'EPISODE':
      return 0.68;
    case 'CONTEXT':
      return 0.5;
    default:
      return 0.55;
  }
};

const parseIsoMs = (value) => {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? ms : null;
};

const recencyScore = (value, nowMs = Date.now()) => {
  const ts = parseIsoMs(value);
  if (ts == null) return 0.4;
  const days = Math.max(0, (nowMs - ts) / (24 * 60 * 60 * 1000));
  if (days <= 1) return 1;
  if (days <= 7) return 0.9;
  if (days <= 30) return 0.75;
  if (days <= 90) return 0.55;
  return 0.25;
};

const computeFeatures = (memory, policy = {}) => {
  const content = String(memory?.content || '').trim();
  const type = String(memory?.type || '').trim().toUpperCase();
  const confidence = clamp01(memory?.confidence ?? 0.6);
  const personal = PERSONAL_PREF_RE.test(content)
    || isHighValueShort(content, {
      enabled: policy.highValueShortEnabled,
      patterns: policy.highValueShortPatterns,
    });
  const relationship = RELATIONSHIP_RE.test(content);
  const identity = type === 'AGENT_IDENTITY' || AGENT_IDENTITY_RE.test(content);
  const durable = isDurable(content, {
    enabled: policy.durableEnabled,
    patterns: policy.durablePatterns,
  }) || identity;
  const recency = recencyScore(memory?.updated_at || memory?.created_at);
  const distinctTokens = countDistinctTokens(content);
  const specificity = clamp01(
    (Math.min(distinctTokens, 24) / 24)
      - (SPECIFICITY_LOW_RE.test(content) ? 0.2 : 0)
      + (/[0-9]/.test(content) ? 0.1 : 0),
  );
  const operationalNoise = clamp01(
    (OPS_NOISE_RE.test(content) ? 0.75 : 0)
      + (type === 'CONTEXT' ? 0.15 : 0)
      + (content.length > 0 && content.length < 40 ? 0.1 : 0),
  );

  return {
    personal_relevance_score: personal ? 1 : 0,
    relationship_signal_score: relationship ? 1 : 0,
    agent_identity_signal_score: identity ? 1 : 0,
    durable_signal_score: durable ? 1 : 0,
    recency_temporal_score: recency,
    retrieval_utility_score: clamp01((baseTypeUtilityScore(type) * 0.65) + (confidence * 0.35)),
    specificity_score: specificity,
    operational_noise_score: operationalNoise,
    confidence_score: confidence,
  };
};

const computeValueScore = (features = {}) => {
  const raw = (
    (features.personal_relevance_score || 0) * 0.19
    + (features.relationship_signal_score || 0) * 0.15
    + (features.agent_identity_signal_score || 0) * 0.18
    + (features.durable_signal_score || 0) * 0.12
    + (features.retrieval_utility_score || 0) * 0.2
    + (features.recency_temporal_score || 0) * 0.08
    + (features.specificity_score || 0) * 0.08
    - (features.operational_noise_score || 0) * 0.15
  );
  return clamp01(raw);
};

const classifyValue = (memory, policy = {}) => {
  const thresholds = {
    ...DEFAULT_VALUE_THRESHOLDS,
    ...(policy.valueThresholds || {}),
  };
  const junk = detectJunk(memory?.content || '', {
    minChars: policy.minContentChars,
    junkPatterns: policy.junkPatterns,
    highValueShortEnabled: policy.highValueShortEnabled,
    highValueShortPatterns: policy.highValueShortPatterns,
  });
  const features = computeFeatures(memory, policy);
  const score = computeValueScore(features);
  const reasons = [];

  if (junk.junk) {
    reasons.push(junk.reason === 'junk_wrapper' ? 'junk_wrapper' : 'junk_system_prompt');
    return {
      action: 'reject',
      value_label: 'junk',
      value_score: 0,
      reason_codes: reasons,
      features,
      junk,
    };
  }

  if (features.agent_identity_signal_score > 0.5) {
    reasons.push('agent_identity');
    return {
      action: 'keep',
      value_label: 'core',
      value_score: Math.max(score, 0.9),
      reason_codes: reasons,
      features,
      junk,
    };
  }

  if (features.relationship_signal_score > 0.5 || features.personal_relevance_score > 0.5 || features.durable_signal_score > 0.5) {
    reasons.push(features.relationship_signal_score > 0.5 ? 'durable_relationship' : 'durable_personal');
    return {
      action: 'keep',
      value_label: 'core',
      value_score: Math.max(score, 0.82),
      reason_codes: reasons,
      features,
      junk,
    };
  }

  if (score >= thresholds.keep) {
    reasons.push('recent_high_utility');
    return {
      action: 'keep',
      value_label: 'core',
      value_score: score,
      reason_codes: reasons,
      features,
      junk,
    };
  }

  if (score >= thresholds.archive) {
    if ((features.operational_noise_score || 0) < 0.55) {
      reasons.push('uncertain_keep_bias');
      return {
        action: 'keep',
        value_label: 'situational',
        value_score: score,
        reason_codes: reasons,
        features,
        junk,
      };
    }
    reasons.push('archive_candidate');
    return {
      action: 'archive',
      value_label: 'archive_candidate',
      value_score: score,
      reason_codes: reasons,
      features,
      junk,
    };
  }

  reasons.push('archive_candidate');
  if ((features.operational_noise_score || 0) > 0.65) reasons.push('ops_transient');
  if ((features.specificity_score || 0) < 0.25) reasons.push('low_specificity');
  return {
    action: 'archive',
    value_label: 'archive_candidate',
    value_score: score,
    reason_codes: reasons,
    features,
    junk,
  };
};

const jaccardSimilarity = (a, b) => {
  const setA = new Set(tokenizeWords(a));
  const setB = new Set(tokenizeWords(b));
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
};

const classifySemanticDecision = (similarity, thresholds = {}) => {
  const auto = clamp01(thresholds.auto ?? 0.92);
  const review = clamp01(thresholds.review ?? 0.85);
  const safeAuto = Math.max(auto, review);
  const safeReview = Math.min(review, safeAuto);
  const score = clamp01(similarity);
  if (score >= safeAuto) return 'auto_drop';
  if (score >= safeReview) return 'review_queue';
  return 'accept';
};

const resolvePolicy = (config = {}) => {
  const junkBase = normalizeStringArray(config?.quality?.junkPatternsBase || DEFAULT_JUNK_PATTERNS_BASE);
  const junkAppend = normalizeStringArray(config?.quality?.junkPatternsAppend || []);
  const junkReplace = config?.quality?.junkPatternsReplace === true;
  const highBase = normalizeStringArray(config?.quality?.highValueShortPatternsBase || DEFAULT_HIGH_VALUE_SHORT_PATTERNS_BASE);
  const highAppend = normalizeStringArray(config?.quality?.highValueShortPatternsAppend || []);
  const durableBase = normalizeStringArray(config?.quality?.durablePatternsBase || DEFAULT_DURABLE_PATTERNS_BASE);
  const durableAppend = normalizeStringArray(config?.quality?.durablePatternsAppend || []);
  return {
    minContentChars: Math.max(1, Number(config?.quality?.minContentChars ?? 25)),
    highValueShortEnabled: config?.quality?.highValueShortEnabled !== false,
    durableEnabled: config?.quality?.durableEnabled !== false,
    junkPatterns: compilePatterns(composePatterns({
      base: junkBase,
      append: junkAppend,
      replace: junkReplace,
    })),
    highValueShortPatterns: compilePatterns(composePatterns({
      base: highBase,
      append: highAppend,
      replace: false,
    })),
    durablePatterns: compilePatterns(composePatterns({
      base: durableBase,
      append: durableAppend,
      replace: false,
    })),
    valueThresholds: {
      ...DEFAULT_VALUE_THRESHOLDS,
      ...(config?.quality?.valueThresholds || {}),
    },
  };
};

export {
  DEFAULT_JUNK_PATTERNS_BASE,
  DEFAULT_HIGH_VALUE_SHORT_PATTERNS_BASE,
  DEFAULT_DURABLE_PATTERNS_BASE,
  DEFAULT_VALUE_THRESHOLDS,
  normalizeContent,
  tokenizeWords,
  hashNormalized,
  composePatterns,
  compilePatterns,
  resolvePolicy,
  detectJunk,
  classifyValue,
  computeFeatures,
  computeValueScore,
  isHighValueShort,
  isDurable,
  jaccardSimilarity,
  classifySemanticDecision,
};
