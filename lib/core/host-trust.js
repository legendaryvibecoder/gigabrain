// Per-host trust model for ingested / cross-host memories.
//
// Closes the auto-trust hole (MINJA / AgentPoison attack class): a writable
// native file (e.g. a .cursor/.windsurf rules file dropped by a cloned repo) or
// a manual cloud paste must NOT be stamped with the same confidence as the
// agent's own first-party memory. Trust flows into the confidence assigned at
// ingest, and the world model already weights that (`beliefPriorityScore` uses
// confidence), so a low-trust source can no longer win a claim slot on recency
// alone and supersede a correct, high-trust belief.
//
// Tiers are decided by host family, not a giant enum, so a new/unknown host
// inherits a conservative floor instead of silently defaulting to "trusted".

// The agent's own first-party memory surfaces.
const OWN_AGENT = new Set([
  'codex', 'claude_code', 'openclaw', 'hermes', 'nimbus',
  'gigabrain', 'gigabrain_native', 'registry', 'host_sync', 'native',
  'host_memory', 'codex_app', 'codex_cli', 'claude_desktop', 'openclaw_native',
]);

// Repo/workspace rule files: legitimate, but user/repo-editable and therefore a
// realistic injection vector when a repo is cloned, so trusted below own memory.
const WORKSPACE = new Set(['cursor', 'windsurf']);

// Cloud products that only arrive via explicit manual paste/import.
const CLOUD = new Set([
  'chatgpt', 'chatgpt_manual', 'gemini', 'gemini_manual', 'copilot',
  'copilot_manual', 'claude_ai', 'claude_manual', 'openai', 'gpt',
]);

const TRUST = Object.freeze({
  own_agent: 0.74, // preserves prior default for first-party native memory
  workspace: 0.6,
  manual_import: 0.5,
  unknown: 0.4, // was silently 0.74 before — the actual poisoning hole
});

const norm = (host) => String(host || '').trim().toLowerCase();

const classifyHostTier = (host) => {
  const h = norm(host);
  if (!h) return 'unknown';
  // Manual/cloud first, so e.g. `cursor_manual` is treated as a manual import.
  if (h.includes('manual') || CLOUD.has(h)) return 'manual_import';
  if (WORKSPACE.has(h)) return 'workspace';
  if (OWN_AGENT.has(h)) return 'own_agent';
  // Runtime/legacy variants of a first-party host keep first-party trust.
  for (const base of OWN_AGENT) {
    if (h === base || h.startsWith(`${base}_`)) return 'own_agent';
  }
  return 'unknown';
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));

// Trust score in [0,1]. `config.hostTrust[host]` overrides the tiered default,
// so an operator can pin a specific host without code changes.
const hostTrustScore = (host, config = {}) => {
  const h = norm(host);
  const overrides = config && typeof config === 'object' && config.hostTrust
    && typeof config.hostTrust === 'object' ? config.hostTrust : {};
  if (h && Object.prototype.hasOwnProperty.call(overrides, h)) {
    const v = Number(overrides[h]);
    if (Number.isFinite(v)) return clamp01(v);
  }
  return TRUST[classifyHostTier(h)];
};

// Confidence stamped at ingest. `source_kind` nudges within the host band:
// a manual_import is the least trustworthy kind regardless of which host it
// claims to come from. Floored/capped to keep the value a sane confidence.
const ingestConfidence = (sourceHost, sourceKind, config = {}) => {
  let conf = hostTrustScore(sourceHost, config);
  if (norm(sourceKind) === 'manual_import') conf = Math.min(conf, TRUST.manual_import);
  return Math.max(0.3, Math.min(0.85, conf));
};

export {
  classifyHostTier,
  hostTrustScore,
  ingestConfidence,
  TRUST,
  OWN_AGENT,
  WORKSPACE,
  CLOUD,
};
