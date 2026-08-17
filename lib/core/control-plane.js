import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';

const CHECKPOINT_SCHEMA_VERSION = 'checkpoint.1';
const CLAIM_SCHEMA_VERSION = 'claim.1';
const RECEIPT_SCHEMA_VERSION = 'receipt.1';
const POLICY_VERSION = 'gigabrain-policy.1';

const CHECKPOINT_ITEM_KINDS = new Set([
  'decision',
  'open_loop',
  'touched_file',
  'durable_candidate',
  'evidence',
]);

const EVIDENCE_CLASSES = new Set([
  'owner_assertion',
  'project_decision',
  'operational_observation',
  'evaluation_result',
  'agent_inference',
  'external_reference',
]);

const CLAIM_EVENT_ACTIONS = new Set(['proposed', 'accepted', 'rejected', 'superseded']);

const normalizeText = (value = '') => String(value || '').replace(/\s+/g, ' ').trim();
const normalizeNullableText = (value = '') => normalizeText(value) || null;
const normalizeStringList = (value = []) => {
  const input = Array.isArray(value) ? value : [value];
  const seen = new Set();
  const out = [];
  for (const item of input) {
    const text = normalizeText(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
};

const toIso = (value = '', fallback = '') => {
  const ms = Date.parse(String(value || ''));
  if (Number.isFinite(ms)) return new Date(ms).toISOString();
  if (fallback) return toIso(fallback);
  return new Date().toISOString();
};

const parseJsonSafe = (value, fallback) => {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
};

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
};

const hashRecord = (value) => createHash('sha256')
  .update(JSON.stringify(canonicalize(value)))
  .digest('hex');

const prefixedId = (prefix) => `${prefix}_${randomUUID()}`;

const quoteSqlIdentifier = (value) => `"${String(value || '').replace(/"/g, '""')}"`;

const ensureImmutableTriggers = (db, tableName) => {
  const table = quoteSqlIdentifier(tableName);
  const updateTrigger = quoteSqlIdentifier(`${tableName}_immutable_update`);
  const deleteTrigger = quoteSqlIdentifier(`${tableName}_immutable_delete`);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS ${updateTrigger}
    BEFORE UPDATE ON ${table}
    BEGIN
      SELECT RAISE(ABORT, '${tableName} is append-only');
    END;
    CREATE TRIGGER IF NOT EXISTS ${deleteTrigger}
    BEFORE DELETE ON ${table}
    BEGIN
      SELECT RAISE(ABORT, '${tableName} is append-only');
    END;
  `);
};

const ensureControlPlaneStore = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS memory_checkpoints (
      checkpoint_id TEXT PRIMARY KEY,
      schema_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      session_id TEXT NOT NULL,
      parent_checkpoint_id TEXT,
      scope TEXT NOT NULL,
      source_agent TEXT NOT NULL,
      source_client TEXT NOT NULL,
      source_host TEXT NOT NULL,
      repo_root TEXT NOT NULL DEFAULT '',
      repo_branch TEXT NOT NULL DEFAULT '',
      repo_commit TEXT NOT NULL DEFAULT '',
      repo_dirty INTEGER NOT NULL DEFAULT 0 CHECK (repo_dirty IN (0, 1)),
      summary TEXT NOT NULL DEFAULT '',
      outcome_status TEXT NOT NULL DEFAULT 'completed',
      source_path TEXT NOT NULL DEFAULT '',
      source_line INTEGER,
      source_kind TEXT NOT NULL DEFAULT 'daily_note',
      legacy_untyped INTEGER NOT NULL DEFAULT 0 CHECK (legacy_untyped IN (0, 1)),
      payload TEXT NOT NULL DEFAULT '{}',
      record_hash TEXT NOT NULL UNIQUE,
      CHECK (length(trim(checkpoint_id)) > 0),
      CHECK (length(trim(session_id)) > 0),
      CHECK (length(trim(scope)) > 0),
      CHECK (length(trim(source_agent)) > 0),
      CHECK (length(trim(source_client)) > 0),
      CHECK (length(trim(source_host)) > 0)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_checkpoints_scope_time
      ON memory_checkpoints(scope, created_at DESC, checkpoint_id DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_checkpoints_agent_time
      ON memory_checkpoints(source_agent, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_checkpoints_session
      ON memory_checkpoints(session_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS memory_checkpoint_items (
      item_id TEXT PRIMARY KEY,
      checkpoint_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      position INTEGER NOT NULL,
      content TEXT NOT NULL,
      evidence_refs TEXT NOT NULL DEFAULT '[]',
      payload TEXT NOT NULL DEFAULT '{}',
      record_hash TEXT NOT NULL UNIQUE,
      FOREIGN KEY (checkpoint_id) REFERENCES memory_checkpoints(checkpoint_id),
      UNIQUE (checkpoint_id, kind, position),
      CHECK (length(trim(content)) > 0)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_checkpoint_items_checkpoint
      ON memory_checkpoint_items(checkpoint_id, kind, position);

    CREATE TABLE IF NOT EXISTS memory_claim_proposals (
      proposal_id TEXT PRIMARY KEY,
      schema_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      checkpoint_id TEXT,
      checkpoint_item_id TEXT,
      scope TEXT NOT NULL,
      claim_type TEXT NOT NULL,
      content TEXT NOT NULL,
      evidence_class TEXT NOT NULL,
      evidence_refs TEXT NOT NULL DEFAULT '[]',
      source_agent TEXT NOT NULL,
      source_host TEXT NOT NULL,
      ancestry_cluster TEXT NOT NULL,
      confidence REAL,
      valid_from TEXT,
      valid_until TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      record_hash TEXT NOT NULL UNIQUE,
      FOREIGN KEY (checkpoint_id) REFERENCES memory_checkpoints(checkpoint_id),
      FOREIGN KEY (checkpoint_item_id) REFERENCES memory_checkpoint_items(item_id),
      CHECK (length(trim(scope)) > 0),
      CHECK (length(trim(source_agent)) > 0),
      CHECK (length(trim(source_host)) > 0),
      CHECK (length(trim(content)) > 0)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_claim_proposals_scope_time
      ON memory_claim_proposals(scope, created_at DESC, proposal_id DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_claim_proposals_checkpoint
      ON memory_claim_proposals(checkpoint_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS memory_claim_proposal_events (
      event_id TEXT PRIMARY KEY,
      proposal_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      action TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_host TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      memory_id TEXT,
      receipt_id TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      record_hash TEXT NOT NULL UNIQUE,
      FOREIGN KEY (proposal_id) REFERENCES memory_claim_proposals(proposal_id),
      CHECK (length(trim(actor_id)) > 0),
      CHECK (length(trim(actor_host)) > 0)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_claim_events_proposal_time
      ON memory_claim_proposal_events(proposal_id, created_at ASC, event_id ASC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_claim_events_one_terminal
      ON memory_claim_proposal_events(proposal_id)
      WHERE action IN ('accepted', 'rejected', 'superseded');

    CREATE TABLE IF NOT EXISTS memory_receipts (
      receipt_id TEXT PRIMARY KEY,
      schema_version TEXT NOT NULL,
      created_at TEXT NOT NULL,
      receipt_type TEXT NOT NULL,
      status TEXT NOT NULL,
      scope TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      actor_host TEXT NOT NULL,
      session_id TEXT,
      policy_version TEXT NOT NULL,
      ledger_snapshot TEXT NOT NULL,
      input_refs TEXT NOT NULL DEFAULT '[]',
      output_refs TEXT NOT NULL DEFAULT '[]',
      evidence_refs TEXT NOT NULL DEFAULT '[]',
      summary TEXT NOT NULL DEFAULT '',
      payload TEXT NOT NULL DEFAULT '{}',
      receipt_hash TEXT NOT NULL UNIQUE,
      CHECK (length(trim(receipt_type)) > 0),
      CHECK (length(trim(status)) > 0),
      CHECK (length(trim(scope)) > 0),
      CHECK (length(trim(actor_id)) > 0),
      CHECK (length(trim(actor_host)) > 0)
    );
    CREATE INDEX IF NOT EXISTS idx_memory_receipts_scope_time
      ON memory_receipts(scope, created_at DESC, receipt_id DESC);
    CREATE INDEX IF NOT EXISTS idx_memory_receipts_session
      ON memory_receipts(session_id, created_at ASC);
  `);

  for (const table of [
    'memory_checkpoints',
    'memory_checkpoint_items',
    'memory_claim_proposals',
    'memory_claim_proposal_events',
    'memory_receipts',
  ]) {
    ensureImmutableTriggers(db, table);
  }
};

const detectRepositoryState = (projectRoot = '') => {
  const root = normalizeText(projectRoot);
  const runGit = (args) => {
    if (!root) return '';
    try {
      return normalizeText(execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore'],
      }));
    } catch {
      return '';
    }
  };
  const repoRoot = runGit(['rev-parse', '--show-toplevel']);
  if (!repoRoot) {
    return {
      root: root || '',
      branch: '',
      commit: '',
      dirty: false,
    };
  }
  return {
    root: repoRoot,
    branch: runGit(['branch', '--show-current']),
    commit: runGit(['rev-parse', 'HEAD']),
    dirty: Boolean(runGit(['status', '--porcelain', '--untracked-files=no'])),
  };
};

const resolveHostLabel = (value = '') => {
  const explicit = normalizeText(value);
  if (explicit) return explicit;
  const machine = normalizeText(os.hostname()).toLowerCase();
  if (!machine) return 'local';
  return `host:${hashRecord(machine).slice(0, 12)}`;
};

const scopeSql = (allowedScopes = [], column = 'scope') => {
  const scopes = normalizeStringList(allowedScopes);
  if (scopes.length === 0) return { sql: '', params: [] };
  return {
    sql: ` AND ${column} IN (${scopes.map(() => '?').join(', ')})`,
    params: scopes,
  };
};

const encodeCursor = (row = {}) => Buffer.from(JSON.stringify({
  created_at: String(row.created_at || ''),
  id: String(row.checkpoint_id || row.proposal_id || row.receipt_id || ''),
}), 'utf8').toString('base64url');

const decodeCursor = (cursor = '') => {
  if (!normalizeText(cursor)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString('utf8'));
    const createdAt = normalizeText(parsed?.created_at);
    const id = normalizeText(parsed?.id);
    if (!createdAt || !id) throw new Error('invalid cursor');
    return { createdAt, id };
  } catch {
    throw new Error('invalid pagination cursor');
  }
};

const checkpointItemRows = (db, checkpointId) => db.prepare(`
  SELECT item_id, checkpoint_id, kind, position, content, evidence_refs, payload, record_hash
  FROM memory_checkpoint_items
  WHERE checkpoint_id = ?
  ORDER BY kind ASC, position ASC, item_id ASC
`).all(checkpointId).map((row) => ({
  item_id: String(row.item_id),
  checkpoint_id: String(row.checkpoint_id),
  kind: String(row.kind),
  position: Number(row.position),
  content: String(row.content),
  evidence_refs: parseJsonSafe(row.evidence_refs, []),
  payload: parseJsonSafe(row.payload, {}),
  record_hash: String(row.record_hash),
}));

const proposalRowsForCheckpoint = (db, checkpointId) => db.prepare(`
  SELECT proposal_id
  FROM memory_claim_proposals
  WHERE checkpoint_id = ?
  ORDER BY created_at ASC, proposal_id ASC
`).all(checkpointId).map((row) => String(row.proposal_id));

const hydrateCheckpointRow = (db, row, options = {}) => {
  if (!row) return null;
  const includeLocalPaths = options.includeLocalPaths !== false;
  const items = checkpointItemRows(db, String(row.checkpoint_id));
  const grouped = {
    decisions: [],
    open_loops: [],
    touched_files: [],
    durable_candidates: [],
    evidence: [],
  };
  for (const item of items) {
    const key = item.kind === 'decision'
      ? 'decisions'
      : item.kind === 'open_loop'
        ? 'open_loops'
        : item.kind === 'touched_file'
          ? 'touched_files'
          : item.kind === 'durable_candidate'
            ? 'durable_candidates'
            : 'evidence';
    grouped[key].push(item);
  }
  return {
    schema_version: String(row.schema_version),
    checkpoint_id: String(row.checkpoint_id),
    session_id: String(row.session_id),
    parent_checkpoint_id: row.parent_checkpoint_id ? String(row.parent_checkpoint_id) : null,
    created_at: String(row.created_at),
    scope: String(row.scope),
    source: {
      agent: String(row.source_agent),
      client: String(row.source_client),
      host: String(row.source_host),
    },
    repo: {
      root: includeLocalPaths ? String(row.repo_root || '') : '',
      branch: String(row.repo_branch || ''),
      commit: String(row.repo_commit || ''),
      dirty: Number(row.repo_dirty || 0) === 1,
    },
    summary: String(row.summary || ''),
    outcome_status: String(row.outcome_status || 'completed'),
    source_ref: {
      path: includeLocalPaths ? String(row.source_path || '') : '',
      line: row.source_line === null || row.source_line === undefined
        ? null
        : (Number.isFinite(Number(row.source_line)) ? Number(row.source_line) : null),
      kind: String(row.source_kind || ''),
    },
    legacy_untyped: Number(row.legacy_untyped || 0) === 1,
    ...grouped,
    proposal_ids: proposalRowsForCheckpoint(db, String(row.checkpoint_id)),
    payload: parseJsonSafe(row.payload, {}),
    record_hash: String(row.record_hash),
  };
};

const selectCheckpointRow = (db, checkpointId, allowedScopes = []) => {
  const auth = scopeSql(allowedScopes);
  return db.prepare(`
    SELECT * FROM memory_checkpoints
    WHERE checkpoint_id = ?${auth.sql}
    LIMIT 1
  `).get(String(checkpointId || ''), ...auth.params);
};

const getCheckpointEpisode = (db, checkpointId, options = {}) => {
  ensureControlPlaneStore(db);
  const row = selectCheckpointRow(db, checkpointId, options.allowedScopes || []);
  return hydrateCheckpointRow(db, row, options);
};

const listCheckpointEpisodes = (db, options = {}) => {
  ensureControlPlaneStore(db);
  const limit = Math.max(1, Math.min(100, Number(options.limit || 25) || 25));
  const clauses = [];
  const params = [];
  const addEqual = (column, value) => {
    const text = normalizeText(value);
    if (!text) return;
    clauses.push(`${column} = ?`);
    params.push(text);
  };
  addEqual('scope', options.scope);
  addEqual('source_agent', options.sourceAgent || options.source_agent);
  addEqual('session_id', options.sessionId || options.session_id);
  addEqual('repo_commit', options.repoCommit || options.repo_commit);
  if (normalizeText(options.since)) {
    clauses.push('created_at >= ?');
    params.push(toIso(options.since));
  }
  if (normalizeText(options.until)) {
    clauses.push('created_at <= ?');
    params.push(toIso(options.until));
  }
  const allowed = normalizeStringList(options.allowedScopes || []);
  if (allowed.length > 0) {
    clauses.push(`scope IN (${allowed.map(() => '?').join(', ')})`);
    params.push(...allowed);
  }
  const cursor = decodeCursor(options.cursor || '');
  if (cursor) {
    clauses.push('(created_at < ? OR (created_at = ? AND checkpoint_id < ?))');
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT * FROM memory_checkpoints
    ${where}
    ORDER BY created_at DESC, checkpoint_id DESC
    LIMIT ?
  `).all(...params, limit + 1);
  const hasMore = rows.length > limit;
  const selected = rows.slice(0, limit);
  const results = selected.map((row) => {
    const full = hydrateCheckpointRow(db, row, options);
    return {
      ...full,
      decisions: full.decisions.map(({ content }) => content),
      open_loops: full.open_loops.map(({ content }) => content),
      touched_files: full.touched_files.map(({ content }) => content),
      durable_candidates: full.durable_candidates.map(({ content }) => content),
      evidence: full.evidence.map(({ content }) => content),
    };
  });
  return {
    schema_version: CHECKPOINT_SCHEMA_VERSION,
    results,
    next_cursor: hasMore && selected.length > 0 ? encodeCursor(selected[selected.length - 1]) : null,
  };
};

const ledgerSnapshot = (db) => {
  ensureControlPlaneStore(db);
  const tables = [
    ['memory_checkpoints', 'record_hash'],
    ['memory_claim_proposals', 'record_hash'],
    ['memory_claim_proposal_events', 'record_hash'],
    ['memory_receipts', 'receipt_hash'],
  ];
  const state = {};
  for (const [table, hashColumn] of tables) {
    const row = db.prepare(`
      SELECT COUNT(*) AS count, MAX(rowid) AS max_rowid
      FROM ${quoteSqlIdentifier(table)}
    `).get();
    const last = Number(row?.max_rowid || 0) > 0
      ? db.prepare(`SELECT ${quoteSqlIdentifier(hashColumn)} AS hash FROM ${quoteSqlIdentifier(table)} WHERE rowid = ?`).get(row.max_rowid)
      : null;
    state[table] = {
      count: Number(row?.count || 0),
      last_hash: String(last?.hash || ''),
    };
  }
  return `sha256:${hashRecord(state)}`;
};

const insertReceipt = (db, input = {}) => {
  const createdAt = toIso(input.createdAt || input.created_at);
  const row = {
    receipt_id: normalizeText(input.receiptId || input.receipt_id) || prefixedId('rcpt'),
    schema_version: RECEIPT_SCHEMA_VERSION,
    created_at: createdAt,
    receipt_type: normalizeText(input.receiptType || input.receipt_type) || 'operation',
    status: normalizeText(input.status) || 'recorded',
    scope: normalizeText(input.scope) || 'shared',
    actor_id: normalizeText(input.actorId || input.actor_id) || 'unknown',
    actor_host: resolveHostLabel(input.actorHost || input.actor_host),
    session_id: normalizeNullableText(input.sessionId || input.session_id),
    policy_version: normalizeText(input.policyVersion || input.policy_version) || POLICY_VERSION,
    ledger_snapshot: normalizeText(input.ledgerSnapshot || input.ledger_snapshot) || ledgerSnapshot(db),
    input_refs: normalizeStringList(input.inputRefs || input.input_refs),
    output_refs: normalizeStringList(input.outputRefs || input.output_refs),
    evidence_refs: normalizeStringList(input.evidenceRefs || input.evidence_refs),
    summary: normalizeText(input.summary),
    payload: input.payload && typeof input.payload === 'object' ? input.payload : {},
  };
  row.receipt_hash = hashRecord(row);
  db.prepare(`
    INSERT INTO memory_receipts (
      receipt_id, schema_version, created_at, receipt_type, status, scope,
      actor_id, actor_host, session_id, policy_version, ledger_snapshot,
      input_refs, output_refs, evidence_refs, summary, payload, receipt_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.receipt_id,
    row.schema_version,
    row.created_at,
    row.receipt_type,
    row.status,
    row.scope,
    row.actor_id,
    row.actor_host,
    row.session_id,
    row.policy_version,
    row.ledger_snapshot,
    JSON.stringify(row.input_refs),
    JSON.stringify(row.output_refs),
    JSON.stringify(row.evidence_refs),
    row.summary,
    JSON.stringify(row.payload),
    row.receipt_hash,
  );
  return row;
};

const appendMemoryReceipt = (db, input = {}) => {
  ensureControlPlaneStore(db);
  db.exec('BEGIN');
  try {
    const row = insertReceipt(db, input);
    db.exec('COMMIT');
    return hydrateReceiptRow(row);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw error;
  }
};

const hydrateReceiptRow = (row) => row ? ({
  schema_version: String(row.schema_version),
  receipt_id: String(row.receipt_id),
  created_at: String(row.created_at),
  receipt_type: String(row.receipt_type),
  status: String(row.status),
  scope: String(row.scope),
  actor: {
    id: String(row.actor_id),
    host: String(row.actor_host),
  },
  session_id: row.session_id ? String(row.session_id) : null,
  policy_version: String(row.policy_version),
  ledger_snapshot: String(row.ledger_snapshot),
  input_refs: parseJsonSafe(row.input_refs, []),
  output_refs: parseJsonSafe(row.output_refs, []),
  evidence_refs: parseJsonSafe(row.evidence_refs, []),
  summary: String(row.summary || ''),
  payload: parseJsonSafe(row.payload, {}),
  receipt_hash: String(row.receipt_hash),
}) : null;

const getMemoryReceipt = (db, receiptId, options = {}) => {
  ensureControlPlaneStore(db);
  const auth = scopeSql(options.allowedScopes || []);
  const row = db.prepare(`
    SELECT * FROM memory_receipts
    WHERE receipt_id = ?${auth.sql}
    LIMIT 1
  `).get(String(receiptId || ''), ...auth.params);
  return hydrateReceiptRow(row);
};

const insertClaimProposal = (db, input = {}) => {
  const evidenceClass = normalizeText(input.evidenceClass || input.evidence_class) || 'agent_inference';
  if (!EVIDENCE_CLASSES.has(evidenceClass)) throw new Error(`unsupported evidence_class: ${evidenceClass}`);
  const content = normalizeText(input.content);
  if (!content) throw new Error('claim proposal content is required');
  const createdAt = toIso(input.createdAt || input.created_at);
  const scope = normalizeText(input.scope) || 'shared';
  const checkpointId = normalizeNullableText(input.checkpointId || input.checkpoint_id);
  const checkpointItemId = normalizeNullableText(input.checkpointItemId || input.checkpoint_item_id);
  if (checkpointId && !selectCheckpointRow(db, checkpointId, [scope])) {
    throw new Error('checkpoint not found or not authorized');
  }
  if (checkpointItemId) {
    if (!checkpointId) throw new Error('checkpoint_item_id requires checkpoint_id');
    const checkpointItem = db.prepare(`
      SELECT item_id FROM memory_checkpoint_items
      WHERE item_id = ? AND checkpoint_id = ?
      LIMIT 1
    `).get(checkpointItemId, checkpointId);
    if (!checkpointItem) throw new Error('checkpoint item not found or not authorized');
  }
  const sourceAgent = normalizeText(input.sourceAgent || input.source_agent) || 'unknown';
  const sourceHost = resolveHostLabel(input.sourceHost || input.source_host);
  const ancestryCluster = normalizeText(input.ancestryCluster || input.ancestry_cluster)
    || `ancestry:${hashRecord({ checkpointId, checkpointItemId, content }).slice(0, 24)}`;
  const confidence = input.confidence === null || input.confidence === undefined || input.confidence === ''
    ? null
    : Math.max(0, Math.min(1, Number(input.confidence)));
  const row = {
    proposal_id: normalizeText(input.proposalId || input.proposal_id) || prefixedId('clm'),
    schema_version: CLAIM_SCHEMA_VERSION,
    created_at: createdAt,
    checkpoint_id: checkpointId,
    checkpoint_item_id: checkpointItemId,
    scope,
    claim_type: normalizeText(input.claimType || input.claim_type).toUpperCase() || 'CONTEXT',
    content,
    evidence_class: evidenceClass,
    evidence_refs: normalizeStringList(input.evidenceRefs || input.evidence_refs),
    source_agent: sourceAgent,
    source_host: sourceHost,
    ancestry_cluster: ancestryCluster,
    confidence: Number.isFinite(confidence) ? confidence : null,
    valid_from: normalizeNullableText(input.validFrom || input.valid_from),
    valid_until: normalizeNullableText(input.validUntil || input.valid_until),
    payload: input.payload && typeof input.payload === 'object' ? input.payload : {},
  };
  row.record_hash = hashRecord(row);
  db.prepare(`
    INSERT INTO memory_claim_proposals (
      proposal_id, schema_version, created_at, checkpoint_id, checkpoint_item_id,
      scope, claim_type, content, evidence_class, evidence_refs, source_agent,
      source_host, ancestry_cluster, confidence, valid_from, valid_until, payload, record_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.proposal_id,
    row.schema_version,
    row.created_at,
    row.checkpoint_id,
    row.checkpoint_item_id,
    row.scope,
    row.claim_type,
    row.content,
    row.evidence_class,
    JSON.stringify(row.evidence_refs),
    row.source_agent,
    row.source_host,
    row.ancestry_cluster,
    row.confidence,
    row.valid_from,
    row.valid_until,
    JSON.stringify(row.payload),
    row.record_hash,
  );
  const event = {
    event_id: prefixedId('clmevt'),
    proposal_id: row.proposal_id,
    created_at: createdAt,
    action: 'proposed',
    actor_id: sourceAgent,
    actor_host: sourceHost,
    reason: '',
    memory_id: null,
    receipt_id: null,
    payload: {},
  };
  event.record_hash = hashRecord(event);
  db.prepare(`
    INSERT INTO memory_claim_proposal_events (
      event_id, proposal_id, created_at, action, actor_id, actor_host,
      reason, memory_id, receipt_id, payload, record_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.event_id,
    event.proposal_id,
    event.created_at,
    event.action,
    event.actor_id,
    event.actor_host,
    event.reason,
    event.memory_id,
    event.receipt_id,
    JSON.stringify(event.payload),
    event.record_hash,
  );
  return row;
};

const appendClaimProposal = (db, input = {}) => {
  ensureControlPlaneStore(db);
  db.exec('BEGIN');
  try {
    const proposal = insertClaimProposal(db, input);
    const receipt = insertReceipt(db, {
      receiptType: 'claim_proposal',
      status: 'proposed',
      scope: proposal.scope,
      actorId: proposal.source_agent,
      actorHost: proposal.source_host,
      inputRefs: proposal.checkpoint_id ? [proposal.checkpoint_id] : [],
      outputRefs: [proposal.proposal_id],
      evidenceRefs: proposal.evidence_refs,
      summary: 'Recorded a claim proposal without promoting it to memory.',
    });
    db.exec('COMMIT');
    return { ...getClaimProposal(db, proposal.proposal_id), receipt_id: receipt.receipt_id };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw error;
  }
};

const hydrateClaimProposalRow = (db, row) => {
  if (!row) return null;
  const events = db.prepare(`
    SELECT event_id, proposal_id, created_at, action, actor_id, actor_host,
           reason, memory_id, receipt_id, payload, record_hash
    FROM memory_claim_proposal_events
    WHERE proposal_id = ?
    ORDER BY created_at ASC, rowid ASC
  `).all(String(row.proposal_id)).map((event) => ({
    event_id: String(event.event_id),
    created_at: String(event.created_at),
    action: String(event.action),
    actor: { id: String(event.actor_id), host: String(event.actor_host) },
    reason: String(event.reason || ''),
    memory_id: event.memory_id ? String(event.memory_id) : null,
    receipt_id: event.receipt_id ? String(event.receipt_id) : null,
    payload: parseJsonSafe(event.payload, {}),
    record_hash: String(event.record_hash),
  }));
  const latest = events[events.length - 1];
  return {
    schema_version: String(row.schema_version),
    proposal_id: String(row.proposal_id),
    created_at: String(row.created_at),
    checkpoint_id: row.checkpoint_id ? String(row.checkpoint_id) : null,
    checkpoint_item_id: row.checkpoint_item_id ? String(row.checkpoint_item_id) : null,
    scope: String(row.scope),
    claim_type: String(row.claim_type),
    content: String(row.content),
    evidence_class: String(row.evidence_class),
    evidence_refs: parseJsonSafe(row.evidence_refs, []),
    source: { agent: String(row.source_agent), host: String(row.source_host) },
    ancestry_cluster: String(row.ancestry_cluster),
    confidence: Number.isFinite(Number(row.confidence)) ? Number(row.confidence) : null,
    valid_window: {
      from: row.valid_from ? String(row.valid_from) : null,
      until: row.valid_until ? String(row.valid_until) : null,
    },
    status: latest?.action || 'proposed',
    memory_id: latest?.memory_id || null,
    events,
    payload: parseJsonSafe(row.payload, {}),
    record_hash: String(row.record_hash),
  };
};

const getClaimProposal = (db, proposalId, options = {}) => {
  ensureControlPlaneStore(db);
  const auth = scopeSql(options.allowedScopes || []);
  const row = db.prepare(`
    SELECT * FROM memory_claim_proposals
    WHERE proposal_id = ?${auth.sql}
    LIMIT 1
  `).get(String(proposalId || ''), ...auth.params);
  return hydrateClaimProposalRow(db, row);
};

const listClaimProposals = (db, options = {}) => {
  ensureControlPlaneStore(db);
  const limit = Math.max(1, Math.min(100, Number(options.limit || 25) || 25));
  const clauses = [];
  const params = [];
  if (normalizeText(options.scope)) {
    clauses.push('p.scope = ?');
    params.push(normalizeText(options.scope));
  }
  const allowed = normalizeStringList(options.allowedScopes || []);
  if (allowed.length > 0) {
    clauses.push(`p.scope IN (${allowed.map(() => '?').join(', ')})`);
    params.push(...allowed);
  }
  const statuses = normalizeStringList(options.statuses || options.status);
  if (statuses.length > 0) {
    clauses.push(`(
      SELECT action FROM memory_claim_proposal_events e
      WHERE e.proposal_id = p.proposal_id
      ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1
    ) IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`
    SELECT p.* FROM memory_claim_proposals p
    ${where}
    ORDER BY p.created_at DESC, p.proposal_id DESC
    LIMIT ?
  `).all(...params, limit);
  return rows.map((row) => hydrateClaimProposalRow(db, row));
};

const appendClaimDecision = (db, input = {}) => {
  ensureControlPlaneStore(db);
  const action = normalizeText(input.action).toLowerCase();
  if (!CLAIM_EVENT_ACTIONS.has(action) || action === 'proposed') {
    throw new Error('claim decision action must be accepted, rejected, or superseded');
  }
  const proposal = getClaimProposal(db, input.proposalId || input.proposal_id, {
    allowedScopes: input.allowedScopes || [],
  });
  if (!proposal) throw new Error('claim proposal not found or not authorized');
  if (proposal.status !== 'proposed') throw new Error(`claim proposal is already ${proposal.status}`);
  if (action === 'accepted' && !normalizeText(input.memoryId || input.memory_id)) {
    throw new Error('accepted claim decisions require memory_id from the committed memory write');
  }
  const actorId = normalizeText(input.actorId || input.actor_id) || 'unknown';
  const actorHost = resolveHostLabel(input.actorHost || input.actor_host);
  const createdAt = toIso(input.createdAt || input.created_at);
  db.exec('BEGIN');
  try {
    const receipt = insertReceipt(db, {
      receiptType: 'claim_decision',
      status: action,
      scope: proposal.scope,
      actorId,
      actorHost,
      inputRefs: [proposal.proposal_id],
      outputRefs: normalizeText(input.memoryId || input.memory_id) ? [normalizeText(input.memoryId || input.memory_id)] : [],
      evidenceRefs: proposal.evidence_refs,
      summary: normalizeText(input.reason) || `Claim proposal ${action}.`,
    });
    const event = {
      event_id: prefixedId('clmevt'),
      proposal_id: proposal.proposal_id,
      created_at: createdAt,
      action,
      actor_id: actorId,
      actor_host: actorHost,
      reason: normalizeText(input.reason),
      memory_id: normalizeNullableText(input.memoryId || input.memory_id),
      receipt_id: receipt.receipt_id,
      payload: input.payload && typeof input.payload === 'object' ? input.payload : {},
    };
    event.record_hash = hashRecord(event);
    db.prepare(`
      INSERT INTO memory_claim_proposal_events (
        event_id, proposal_id, created_at, action, actor_id, actor_host,
        reason, memory_id, receipt_id, payload, record_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.event_id,
      event.proposal_id,
      event.created_at,
      event.action,
      event.actor_id,
      event.actor_host,
      event.reason,
      event.memory_id,
      event.receipt_id,
      JSON.stringify(event.payload),
      event.record_hash,
    );
    db.exec('COMMIT');
    return {
      proposal_id: proposal.proposal_id,
      action,
      memory_id: event.memory_id,
      receipt_id: receipt.receipt_id,
      event_id: event.event_id,
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw error;
  }
};

const appendCheckpointEpisode = (db, input = {}) => {
  ensureControlPlaneStore(db);
  const createdAt = toIso(input.createdAt || input.created_at || input.timestamp);
  const checkpointId = normalizeText(input.checkpointId || input.checkpoint_id) || prefixedId('cp');
  const sessionId = normalizeText(input.sessionId || input.session_id) || prefixedId('ses');
  const parentCheckpointId = normalizeNullableText(input.parentCheckpointId || input.parent_checkpoint_id);
  const scope = normalizeText(input.scope) || 'project:workspace';
  const sourceAgent = normalizeText(input.sourceAgent || input.source_agent) || 'unknown';
  const sourceClient = normalizeText(input.sourceClient || input.source_client) || sourceAgent;
  const sourceHost = resolveHostLabel(input.sourceHost || input.source_host);
  const repo = input.repo && typeof input.repo === 'object'
    ? input.repo
    : detectRepositoryState(input.projectRoot || input.project_root || '');
  if (parentCheckpointId) {
    const parent = selectCheckpointRow(db, parentCheckpointId, [scope]);
    if (!parent) throw new Error('parent checkpoint not found or not authorized');
  }
  const summary = normalizeText(input.summary);
  const decisions = normalizeStringList(input.decisions);
  const openLoops = normalizeStringList(input.openLoops || input.open_loops);
  const touchedFiles = normalizeStringList(input.touchedFiles || input.touched_files);
  const durableCandidates = normalizeStringList(input.durableCandidates || input.durable_candidates);
  const evidence = normalizeStringList(input.evidence || input.evidenceRefs || input.evidence_refs);
  if (!summary && decisions.length === 0 && openLoops.length === 0 && touchedFiles.length === 0 && durableCandidates.length === 0 && evidence.length === 0) {
    throw new Error('checkpoint episode requires summary or at least one item');
  }
  const row = {
    checkpoint_id: checkpointId,
    schema_version: CHECKPOINT_SCHEMA_VERSION,
    created_at: createdAt,
    session_id: sessionId,
    parent_checkpoint_id: parentCheckpointId,
    scope,
    source_agent: sourceAgent,
    source_client: sourceClient,
    source_host: sourceHost,
    repo_root: normalizeText(repo.root),
    repo_branch: normalizeText(repo.branch),
    repo_commit: normalizeText(repo.commit),
    repo_dirty: repo.dirty === true ? 1 : 0,
    summary,
    outcome_status: normalizeText(input.outcomeStatus || input.outcome_status) || 'completed',
    source_path: normalizeText(input.sourcePath || input.source_path),
    source_line: Number.isFinite(Number(input.sourceLine || input.source_line)) ? Number(input.sourceLine || input.source_line) : null,
    source_kind: normalizeText(input.sourceKind || input.source_kind) || 'daily_note',
    legacy_untyped: input.legacyUntyped === true || input.legacy_untyped === true ? 1 : 0,
    payload: input.payload && typeof input.payload === 'object' ? input.payload : {},
  };
  const createProposals = input.createProposals !== false && row.legacy_untyped !== 1;
  row.record_hash = hashRecord(row);

  const itemGroups = [
    ['decision', decisions],
    ['open_loop', openLoops],
    ['touched_file', touchedFiles],
    ['durable_candidate', durableCandidates],
    ['evidence', evidence],
  ];
  db.exec('BEGIN');
  try {
    db.prepare(`
      INSERT INTO memory_checkpoints (
        checkpoint_id, schema_version, created_at, session_id, parent_checkpoint_id,
        scope, source_agent, source_client, source_host, repo_root, repo_branch,
        repo_commit, repo_dirty, summary, outcome_status, source_path, source_line,
        source_kind, legacy_untyped, payload, record_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.checkpoint_id,
      row.schema_version,
      row.created_at,
      row.session_id,
      row.parent_checkpoint_id,
      row.scope,
      row.source_agent,
      row.source_client,
      row.source_host,
      row.repo_root,
      row.repo_branch,
      row.repo_commit,
      row.repo_dirty,
      row.summary,
      row.outcome_status,
      row.source_path,
      row.source_line,
      row.source_kind,
      row.legacy_untyped,
      JSON.stringify(row.payload),
      row.record_hash,
    );

    const proposalIds = [];
    for (const [kind, values] of itemGroups) {
      if (!CHECKPOINT_ITEM_KINDS.has(kind)) throw new Error(`unsupported checkpoint item kind: ${kind}`);
      for (let position = 0; position < values.length; position += 1) {
        const item = {
          item_id: prefixedId('cpitem'),
          checkpoint_id: checkpointId,
          kind,
          position,
          content: values[position],
          evidence_refs: kind === 'durable_candidate' ? evidence : [],
          payload: {},
        };
        item.record_hash = hashRecord(item);
        db.prepare(`
          INSERT INTO memory_checkpoint_items (
            item_id, checkpoint_id, kind, position, content, evidence_refs, payload, record_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          item.item_id,
          item.checkpoint_id,
          item.kind,
          item.position,
          item.content,
          JSON.stringify(item.evidence_refs),
          JSON.stringify(item.payload),
          item.record_hash,
        );
        if (kind === 'durable_candidate' && createProposals) {
          const proposal = insertClaimProposal(db, {
            checkpointId,
            checkpointItemId: item.item_id,
            scope,
            claimType: 'CONTEXT',
            content: item.content,
            evidenceClass: 'agent_inference',
            evidenceRefs: item.evidence_refs,
            sourceAgent,
            sourceHost,
            payload: { promotion: 'manual_review_required' },
          });
          proposalIds.push(proposal.proposal_id);
        }
      }
    }

    const receipt = insertReceipt(db, {
      receiptType: 'checkpoint',
      status: 'recorded',
      scope,
      actorId: sourceAgent,
      actorHost: sourceHost,
      sessionId,
      inputRefs: parentCheckpointId ? [parentCheckpointId] : [],
      outputRefs: [checkpointId, ...proposalIds],
      evidenceRefs: evidence,
      summary: 'Recorded an immutable checkpoint episode; durable candidates remain proposals.',
      payload: { schema_version: CHECKPOINT_SCHEMA_VERSION },
    });
    db.exec('COMMIT');
    return {
      checkpoint: getCheckpointEpisode(db, checkpointId),
      receipt_id: receipt.receipt_id,
    };
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw error;
  }
};

export {
  CHECKPOINT_SCHEMA_VERSION,
  CLAIM_SCHEMA_VERSION,
  RECEIPT_SCHEMA_VERSION,
  POLICY_VERSION,
  EVIDENCE_CLASSES,
  ensureControlPlaneStore,
  detectRepositoryState,
  hashRecord,
  ledgerSnapshot,
  appendCheckpointEpisode,
  listCheckpointEpisodes,
  getCheckpointEpisode,
  appendClaimProposal,
  listClaimProposals,
  getClaimProposal,
  appendClaimDecision,
  appendMemoryReceipt,
  getMemoryReceipt,
};
