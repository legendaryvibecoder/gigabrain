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
  '\\b(?:care|caring|appreciation|valued|important to|matters? to|means? a lot to)\\b',
  '\\b(?:goal|target|birthday|poly|polyamorous|relationship|dating|reads?|reading|bookmarks?)\\b',
]);

const DEFAULT_DURABLE_PATTERNS_BASE = Object.freeze([
  '\\b(?:user|owner)\\s+(?:likes?|loves?|prefers?|dislikes?|hates?)\\b',
  '\\b(?:proud of|stolz auf|grateful|dankbar|appreciates?|sch[aä]tzt|supports?|unterst[uü]tzt|trusts?|vertraut)\\b',
  '\\b(?:partner(?:in)?|wife|husband|girlfriend|boyfriend|best friend|mentor|sibling)\\b',
  '\\b(?:pronouns?|pronomen)\\b',
  '\\b(?:identity|personality|continuity|evolution)\\b',
  '\\b(?:care|caring|appreciation|valued|important to|matters? to|means? a lot to|self-sufficient|helpful)\\b',
  '\\b(?:goal|target|birthday|poly|polyamorous|relationship|dating|reads?|reading|weight goal|lose weight)\\b',
]);

const DEFAULT_VALUE_THRESHOLDS = Object.freeze({
  keep: 0.78,
  archive: 0.3,
  reject: 0.18,
});

const DEFAULT_BROKEN_PHRASE_PATTERNS_BASE = Object.freeze([
  '\\bjabber\\b',
  '\\bbegan\\s+a\\s+\\d+\\b',
  '\\bstarted\\s+a\\s+\\d+\\b',
  '\\b\\d+\\s+jabber\\b',
]);

const DEFAULT_SEMANTIC_ANCHORS_BASE = Object.freeze([
  'started',
  'began',
  'journey',
  'weight',
  'loss',
  'target',
  'current',
  'kg',
  'goal',
  'newsletter',
  'launched',
  'founded',
  'joined',
  'birthday',
  'relationship',
  'partner',
  'poly',
  'telegram',
  'email',
  'read',
  'reading',
  'care',
  'appreciation',
]);

const PERSONAL_PREF_RE = /\b(?:user|owner)\s+(?:likes?|loves?|prefers?|dislikes?|hates?)\b/i;
const PERSONAL_FACT_RE = /\b(?:likes?|loves?|prefers?|dislikes?|hates?|mag|liebt|bevorzugt|reads?|reading|birthday|partner|relationship|poly|polyamorous|dating|investor|goal|target|lose weight|weight goal|telegram|email|username)\b/i;
const RELATIONSHIP_RE = /\b(?:partner(?:in)?|wife|husband|girlfriend|boyfriend|friend|mentor|sibling|proud of|stolz auf|grateful|dankbar|care|caring|appreciation|valued|matters? to|important to)\b/i;
const RELATIONAL_CONTINUITY_RE = /\b(?:treats?\s+\w+\s+as\s+(?:someone|a person|person|a friend)|relationship and process|genuine care|this matters to|means a lot to|self-sufficient|helpful)\b/i;
const AGENT_IDENTITY_RE = /\b(?:agent identity|agent profile|my personality|agent continuity|agent evolution)\b/i;
const OPS_NOISE_RE = /\b(?:run:|script|cron|pipeline|phase\s+\d+|openclaw\s+update|todo:|implement(?:ed|ation)?|patch-round|worker\.sh|api key|endpoint|webhook|token|chat id|message id|sender id|port\b|protocol\b|device id|syntax|permissions granted|folder\b|region\b|config(?:uration)?|twilio|elevenlabs|twitterapi|xai api|ollama|model:|ip address|192\.168\.)\b/i;
const SPECIFICITY_LOW_RE = /\b(?:something|anything|stuff|things|general update|status update)\b/i;
const GENERIC_EXTRACTION_RE = /\b(?:user|owner|assistant|agent)\s+(?:is|was|has|had|wants?|prefers?|uses?|likes?|loves?|asked|said|mentioned|sent|provided|receives?|is considering|is looking|is trying|is investigating|is checking|is inquiring)\b/i;
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

const extractNumericTokens = (value) => {
  const matches = normalizeContent(value).match(/\b\d+(?:kg|st|nd|rd|th)?\b/g);
  return matches ? matches.filter(Boolean) : [];
};

const overlapScore = (a = [], b = []) => {
  const setA = new Set(a.filter(Boolean));
  const setB = new Set(b.filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return null;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
};

const charNgrams = (value, size = 3) => {
  const text = normalizeContent(value).replace(/\s+/g, ' ');
  if (text.length < size) return [];
  const out = [];
  for (let i = 0; i <= text.length - size; i += 1) out.push(text.slice(i, i + size));
  return out;
};

const detectPlausibility = (memory, policy = {}) => {
  const content = String(memory?.content || '').trim();
  const type = String(memory?.type || '').trim().toUpperCase();
  const confidence = clamp01(memory?.confidence ?? 0.6);
  const brokenPattern = (policy.brokenPhrasePatterns || []).find((pattern) => pattern.test(content));
  const numericTokens = extractNumericTokens(content);
  const anchorHits = (policy.semanticAnchors || []).filter((anchor) => anchor.test(content));
  const hasNumbers = numericTokens.length > 0;
  const stablePersonalAnchor = PERSONAL_FACT_RE.test(content) || RELATIONSHIP_RE.test(content) || RELATIONAL_CONTINUITY_RE.test(content);
  const lowConfidenceUserFact = type === 'USER_FACT' && confidence < 0.7 && GENERIC_EXTRACTION_RE.test(content) && !stablePersonalAnchor;
  const tokenAnomaly = Boolean(brokenPattern);
  const entitylessNumericFact = type === 'USER_FACT' && hasNumbers && anchorHits.length === 0 && !stablePersonalAnchor;
  const brokenPhrasePattern = Boolean(brokenPattern);
  const flags = {
    low_confidence_user_fact: lowConfidenceUserFact,
    token_anomaly: tokenAnomaly,
    entityless_numeric_fact: entitylessNumericFact,
    broken_phrase_pattern: brokenPhrasePattern,
  };
  return {
    flags,
    actionableCount: Object.values(flags).filter(Boolean).length,
    matchedPattern: brokenPattern?.source || null,
  };
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
  const scope = String(memory?.scope || '').trim().toLowerCase();
  const confidence = clamp01(memory?.confidence ?? 0.6);
  const personal = PERSONAL_PREF_RE.test(content)
    || PERSONAL_FACT_RE.test(content)
    || isHighValueShort(content, {
      enabled: policy.highValueShortEnabled,
      patterns: policy.highValueShortPatterns,
    });
  const relationship = RELATIONSHIP_RE.test(content) || RELATIONAL_CONTINUITY_RE.test(content);
  const identity = type === 'AGENT_IDENTITY' || AGENT_IDENTITY_RE.test(content);
  const personalMemoryClass = ['USER_FACT', 'PREFERENCE', 'EPISODE'].includes(type);
  const personalScopeContinuity = personalMemoryClass && scope && scope !== 'shared' && (personal || relationship || identity);
  const durable = isDurable(content, {
    enabled: policy.durableEnabled,
    patterns: policy.durablePatterns,
  }) || identity || relationship || personalScopeContinuity;
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
    personal_relevance_score: personal ? 1 : (personalScopeContinuity ? 0.7 : 0),
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
  const type = String(memory?.type || '').trim().toUpperCase();
  const junk = detectJunk(memory?.content || '', {
    minChars: policy.minContentChars,
    junkPatterns: policy.junkPatterns,
    highValueShortEnabled: policy.highValueShortEnabled,
    highValueShortPatterns: policy.highValueShortPatterns,
  });
  const features = computeFeatures(memory, policy);
  const score = computeValueScore(features);
  const plausibility = detectPlausibility(memory, policy);
  const structuralPlausibilityFlag = Boolean(
    plausibility.flags.token_anomaly
    || plausibility.flags.broken_phrase_pattern
    || plausibility.flags.entityless_numeric_fact
  );
  const personalMemoryClass = ['USER_FACT', 'PREFERENCE', 'EPISODE'].includes(type);
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
      plausibility,
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
      plausibility,
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
      plausibility,
    };
  }

  if (score >= thresholds.keep) {
    if (structuralPlausibilityFlag && type === 'USER_FACT') {
      reasons.push('archive_candidate');
      reasons.push('plausibility_flag');
      return {
        action: 'archive',
        value_label: 'archive_candidate',
        value_score: score,
        reason_codes: reasons,
        features,
        junk,
        plausibility,
      };
    }
    reasons.push('recent_high_utility');
    return {
      action: 'keep',
      value_label: 'core',
      value_score: score,
      reason_codes: reasons,
      features,
      junk,
      plausibility,
    };
  }

  if (score >= thresholds.archive) {
    if (
      (features.operational_noise_score || 0) < 0.55
      && clamp01(memory?.confidence ?? features.confidence_score ?? 0.6) >= 0.7
      && !structuralPlausibilityFlag
    ) {
      reasons.push('uncertain_keep_bias');
      return {
        action: 'keep',
        value_label: 'situational',
        value_score: score,
        reason_codes: reasons,
        features,
        junk,
        plausibility,
      };
    }
    if (
      personalMemoryClass
      && (features.retrieval_utility_score || 0) >= 0.78
      && (features.specificity_score || 0) >= 0.38
      && (features.operational_noise_score || 0) < 0.35
      && !structuralPlausibilityFlag
    ) {
      reasons.push('personal_soft_keep_bias');
      if (plausibility.flags.low_confidence_user_fact) reasons.push('low_confidence_tolerated');
      return {
        action: 'keep',
        value_label: 'situational',
        value_score: score,
        reason_codes: reasons,
        features,
        junk,
        plausibility,
      };
    }
    reasons.push('archive_candidate');
    if (plausibility.actionableCount > 0) reasons.push('plausibility_flag');
    return {
      action: 'archive',
      value_label: 'archive_candidate',
      value_score: score,
      reason_codes: reasons,
      features,
      junk,
      plausibility,
    };
  }

  reasons.push('archive_candidate');
  if ((features.operational_noise_score || 0) > 0.65) reasons.push('ops_transient');
  if ((features.specificity_score || 0) < 0.25) reasons.push('low_specificity');
  if (plausibility.actionableCount > 0) reasons.push('plausibility_flag');
  return {
    action: 'archive',
    value_label: 'archive_candidate',
    value_score: score,
    reason_codes: reasons,
    features,
    junk,
    plausibility,
  };
};

const jaccardSimilarity = (a, b) => {
  const exactNormA = normalizeContent(a);
  const exactNormB = normalizeContent(b);
  if (!exactNormA || !exactNormB) return 0;
  if (exactNormA === exactNormB) return 1;

  const scores = [];
  const weights = [];
  const pushWeighted = (score, weight) => {
    if (!Number.isFinite(score)) return;
    scores.push(score * weight);
    weights.push(weight);
  };

  pushWeighted(overlapScore(tokenizeWords(a), tokenizeWords(b)) ?? 0, 0.35);
  pushWeighted(overlapScore(charNgrams(a, 3), charNgrams(b, 3)) ?? 0, 0.25);
  const numericScore = overlapScore(extractNumericTokens(a), extractNumericTokens(b));
  if (numericScore != null) pushWeighted(numericScore, 0.2);
  const anchorScore = overlapScore(
    DEFAULT_SEMANTIC_ANCHORS_BASE.filter((item) => new RegExp(`\\b${item}\\b`, 'i').test(String(a || ''))),
    DEFAULT_SEMANTIC_ANCHORS_BASE.filter((item) => new RegExp(`\\b${item}\\b`, 'i').test(String(b || ''))),
  );
  if (anchorScore != null) pushWeighted(anchorScore, 0.2);
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);
  return totalWeight > 0 ? scores.reduce((sum, value) => sum + value, 0) / totalWeight : 0;
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

const resolveSemanticThresholds = (type, config = {}) => {
  const normalizedType = String(type || '').trim().toUpperCase();
  const configured = config?.dedupe?.thresholdsByType?.[normalizedType] || config?.dedupe?.thresholdsByType?.default || {};
  const defaults = ['USER_FACT', 'PREFERENCE'].includes(normalizedType)
    ? { auto: 0.78, review: 0.62 }
    : normalizedType === 'CONTEXT'
      ? { auto: 0.84, review: 0.7 }
      : { auto: 0.82, review: 0.66 };
  return {
    auto: clamp01(configured.auto ?? defaults.auto),
    review: clamp01(configured.review ?? defaults.review),
  };
};

const resolvePolicy = (config = {}) => {
  const junkBase = normalizeStringArray(config?.quality?.junkPatternsBase || DEFAULT_JUNK_PATTERNS_BASE);
  const junkAppend = normalizeStringArray(config?.quality?.junkPatternsAppend || []);
  const junkReplace = config?.quality?.junkPatternsReplace === true;
  const highBase = normalizeStringArray(config?.quality?.highValueShortPatternsBase || DEFAULT_HIGH_VALUE_SHORT_PATTERNS_BASE);
  const highAppend = normalizeStringArray(config?.quality?.highValueShortPatternsAppend || []);
  const durableBase = normalizeStringArray(config?.quality?.durablePatternsBase || DEFAULT_DURABLE_PATTERNS_BASE);
  const durableAppend = normalizeStringArray(config?.quality?.durablePatternsAppend || []);
  const plausibility = config?.quality?.plausibility || {};
  const brokenPhraseBase = normalizeStringArray(plausibility?.brokenPhrasePatternsBase || DEFAULT_BROKEN_PHRASE_PATTERNS_BASE);
  const brokenPhraseAppend = normalizeStringArray(plausibility?.brokenPhrasePatternsAppend || []);
  const semanticAnchorBase = normalizeStringArray(plausibility?.semanticAnchorsBase || DEFAULT_SEMANTIC_ANCHORS_BASE);
  const semanticAnchorAppend = normalizeStringArray(plausibility?.semanticAnchorsAppend || []);
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
    brokenPhrasePatterns: compilePatterns(composePatterns({
      base: brokenPhraseBase,
      append: brokenPhraseAppend,
      replace: false,
    })),
    semanticAnchors: compilePatterns(composePatterns({
      base: semanticAnchorBase,
      append: semanticAnchorAppend,
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
  DEFAULT_BROKEN_PHRASE_PATTERNS_BASE,
  DEFAULT_SEMANTIC_ANCHORS_BASE,
  normalizeContent,
  tokenizeWords,
  hashNormalized,
  composePatterns,
  compilePatterns,
  resolvePolicy,
  detectJunk,
  detectPlausibility,
  classifyValue,
  computeFeatures,
  computeValueScore,
  isHighValueShort,
  isDurable,
  jaccardSimilarity,
  classifySemanticDecision,
  resolveSemanticThresholds,
};
