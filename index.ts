import fs from 'node:fs';
import path from 'node:path';

import { V3_CONFIG_SCHEMA, normalizeConfig } from './lib/core/config.js';
import { DatabaseSync, openDatabase } from './lib/core/sqlite.js';
import { createMemoryHttpHandler } from './lib/core/http-routes.js';
import { ensureProjectionStore, materializeProjectionFromMemories } from './lib/core/projection-store.js';
import { ensureEventStore } from './lib/core/event-store.js';
import { captureFromEvent } from './lib/core/capture-service.js';
import { recallForQuery } from './lib/core/recall-service.js';
import { ensureNativeStore, syncNativeMemory } from './lib/core/native-sync.js';
import { ensurePersonStore, rebuildEntityMentions } from './lib/core/person-service.js';

type PluginApi = {
  config?: unknown;
  logger?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
  on: (event: string, handler: (...args: any[]) => any) => void;
  registerHttpHandler?: (handler: (req: any, res: any) => Promise<boolean> | boolean) => void;
};

type PluginConfig = ReturnType<typeof normalizeConfig>;

/** Shape of the context object passed as the second argument to hook handlers. */
type HookContext = {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  messageProvider?: unknown;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const resolveRawPluginConfig = (raw: unknown): Record<string, unknown> => {
  if (!isObject(raw)) return {};
  const nested = (raw as any)?.plugins?.entries?.gigabrain?.config;
  if (isObject(nested)) return nested;
  return raw as Record<string, unknown>;
};

const parseAgentIdFromSessionKey = (sessionKey: string): string => {
  const parts = String(sessionKey || '').split(':');
  return String(parts[1] || 'shared').trim() || 'shared';
};

/**
 * Resolve scope from the hook context (second argument) and fall back to event fields.
 * The gateway passes agentId and sessionKey in ctx, not in event.
 */
const resolveScopeFromCtx = (event: any, ctx?: HookContext): string => {
  // Prefer ctx fields (where the gateway actually puts them)
  const ctxAgent = String(ctx?.agentId || '').trim();
  if (ctxAgent) return ctxAgent;
  const ctxSessionKey = String(ctx?.sessionKey || '').trim();
  if (ctxSessionKey) return parseAgentIdFromSessionKey(ctxSessionKey);
  // Legacy fallback: check event fields (for older gateway versions)
  const explicit = String(event?.agentId || event?.scope || '').trim();
  if (explicit) return explicit;
  const sessionKey = String(event?.sessionKey || event?.meta?.sessionKey || '');
  if (!sessionKey) return 'shared';
  return parseAgentIdFromSessionKey(sessionKey);
};

const extractUserQuery = (event: any): string => {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    const role = String(msg?.role || '').toLowerCase();
    if (role !== 'user') continue;
    const content = typeof msg?.content === 'string'
      ? msg.content
      : Array.isArray(msg?.content)
        ? msg.content.map((part: any) => (typeof part?.text === 'string' ? part.text : '')).join('\n')
        : '';
    const trimmed = String(content || '').trim();
    if (trimmed) return trimmed;
  }
  const prompt = String(event?.prompt || '').trim();
  return prompt;
};

const stringifyCaptureValue = (value: any, depth = 0): string => {
  if (depth > 5 || value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => stringifyCaptureValue(item, depth + 1))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, any>;
    const preferredKeys = ['text', 'content', 'output_text', 'message', 'response', 'output', 'result', 'final'];
    const parts: string[] = [];
    for (const key of preferredKeys) {
      if (!(key in record)) continue;
      const piece = stringifyCaptureValue(record[key], depth + 1).trim();
      if (piece) parts.push(piece);
    }
    if (parts.length > 0) return parts.join('\n');
    try {
      return JSON.stringify(record);
    } catch {
      return String(record);
    }
  }
  return '';
};

const extractCapturePayload = (event: any, ctx?: HookContext) => {
  const outputRaw = event?.output ?? event?.result ?? event?.response ?? event?.final ?? '';
  const promptRaw = event?.prompt ?? '';
  const sessionKey = String(ctx?.sessionKey || event?.sessionKey || '');
  const agentId = String(ctx?.agentId || event?.agentId || parseAgentIdFromSessionKey(sessionKey));
  return {
    scope: resolveScopeFromCtx(event, ctx),
    agentId,
    sessionKey,
    text: stringifyCaptureValue(outputRaw),
    output: outputRaw,
    response: event?.response,
    result: event?.result,
    final: event?.final,
    prompt: stringifyCaptureValue(promptRaw),
    messages: Array.isArray(event?.messages) ? event.messages : [],
    meta: event?.meta ?? event?.metadata ?? {},
    metadata: event?.metadata ?? event?.meta ?? {},
    llmUnavailable: Boolean(
      event?.llmUnavailable === true
      || event?.modelUnavailable === true
      || event?.meta?.llmUnavailable === true
      || event?.metadata?.llmUnavailable === true,
    ),
  };
};

const withDb = <T,>(dbPath: string, fn: (db: DatabaseSync) => T): T => {
  const db = openDatabase(dbPath);
  try {
    ensureProjectionStore(db);
    ensureEventStore(db);
    ensureNativeStore(db);
    ensurePersonStore(db);
    const count = db.prepare('SELECT COUNT(*) AS c FROM memory_current').get()?.c || 0;
    if (Number(count) === 0) {
      materializeProjectionFromMemories(db);
    }
    return fn(db);
  } finally {
    db.close();
  }
};

const shouldSkipRecall = (query: string): boolean => {
  const text = String(query || '').trim().toLowerCase();
  if (!text) return true;
  if (text.startsWith('automation:')) return true;
  if (text.includes('<memory_note')) return true;
  return false;
};

/* ── Session tracking helpers ─────────────────────────────────────────── */

/** Ensure the sessions table exists (idempotent). */
const ensureSessionsTable = (db: DatabaseSync): void => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_id TEXT,
      channel TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      ended_at TEXT,
      message_count INTEGER DEFAULT 0,
      summary TEXT,
      next_steps TEXT,
      status TEXT DEFAULT 'active'
    )
  `);
};

/**
 * Derive a stable session id from the gateway session key.
 * Format: "agent:<agentId>:<channel>" -> "agent:<agentId>:<channel>"
 * If sessionId is provided by gateway, prefer that (it is a UUID per run).
 */
const deriveSessionId = (ctx?: HookContext): string => {
  // Use the gateway-assigned sessionId if available (UUID, unique per conversation)
  const gwSessionId = String(ctx?.sessionId || '').trim();
  if (gwSessionId && gwSessionId !== 'undefined') return gwSessionId;
  // Fall back to sessionKey
  const key = String(ctx?.sessionKey || '').trim();
  if (key) return key;
  return `session-${Date.now()}`;
};

/** Derive channel from sessionKey (e.g. "agent:default:telegram:..." -> "telegram") */
const deriveChannel = (ctx?: HookContext): string => {
  const key = String(ctx?.sessionKey || '').trim();
  if (!key) return 'unknown';
  const parts = key.split(':');
  // Format: agent:<agentId>:<channel>:... or agent:<agentId>:main
  if (parts.length >= 3) return parts[2] || 'main';
  return 'main';
};

/**
 * Start or resume a session. If a session with the same sessionKey already exists
 * and is active, increment message_count. Otherwise create a new one.
 */
const startOrResumeSession = (db: DatabaseSync, ctx?: HookContext, logger?: any): void => {
  ensureSessionsTable(db);
  const sessionId = deriveSessionId(ctx);
  const agentId = String(ctx?.agentId || '').trim() || 'shared';
  const channel = deriveChannel(ctx);

  // Check if session already exists
  const existing = db.prepare('SELECT id, status FROM sessions WHERE id = ?').get(sessionId) as any;
  if (existing) {
    // Resume: increment message count
    db.prepare(`
      UPDATE sessions
      SET message_count = message_count + 1,
          status = 'active'
      WHERE id = ?
    `).run(sessionId);
    logger?.info?.(`[gigabrain] session resumed id=${sessionId} agent=${agentId}`);
  } else {
    // Create new session
    db.prepare(`
      INSERT INTO sessions (id, agent_id, channel, started_at, message_count, status)
      VALUES (?, ?, ?, datetime('now'), 1, 'active')
    `).run(sessionId, agentId, channel);
    logger?.info?.(`[gigabrain] session started id=${sessionId} agent=${agentId} channel=${channel}`);
  }
};

/**
 * Close a session (set ended_at and status).
 */
const endSession = (db: DatabaseSync, ctx?: HookContext, logger?: any): void => {
  ensureSessionsTable(db);
  const sessionId = deriveSessionId(ctx);

  const existing = db.prepare('SELECT id FROM sessions WHERE id = ?').get(sessionId) as any;
  if (!existing) {
    // Session was never started (e.g. hook ordering issue) -- create a minimal record
    const agentId = String(ctx?.agentId || '').trim() || 'shared';
    const channel = deriveChannel(ctx);
    db.prepare(`
      INSERT INTO sessions (id, agent_id, channel, started_at, ended_at, message_count, status)
      VALUES (?, ?, ?, datetime('now'), datetime('now'), 1, 'ended')
    `).run(sessionId, agentId, channel);
    logger?.info?.(`[gigabrain] session retroactively created+ended id=${sessionId}`);
    return;
  }

  db.prepare(`
    UPDATE sessions
    SET ended_at = datetime('now'),
        status = 'ended'
    WHERE id = ?
  `).run(sessionId);
  logger?.info?.(`[gigabrain] session ended id=${sessionId}`);
};

/* ── Plugin ───────────────────────────────────────────────────────────── */

const gigabrainPlugin = {
  id: 'gigabrain',
  name: 'Gigabrain',
  description: 'Gigabrain v3 lean memory engine (event timeline + current projection)',
  kind: 'utility' as const,
  configSchema: V3_CONFIG_SCHEMA,

  register(api: PluginApi) {
    const logger = api.logger || {};
    const rawConfig = resolveRawPluginConfig(api.config);

    let config: PluginConfig;
    try {
      config = normalizeConfig(rawConfig, {
        workspaceRoot: process.cwd(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error?.(`[gigabrain] invalid v3 config: ${message}`);
      throw err;
    }

    if (config.enabled === false) {
      logger.info?.('[gigabrain] disabled by config');
      return;
    }

    const dbPath = path.resolve(config.runtime.paths.registryPath);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    logger.info?.(`[gigabrain] v3 startup db=${dbPath}`);

    withDb(dbPath, () => undefined);
    withDb(dbPath, (db) => {
      // Ensure sessions table exists on startup
      ensureSessionsTable(db);
      if (config.native.enabled === false) return;
      const nativeSync = syncNativeMemory({
        db,
        config,
        dryRun: false,
      });
      rebuildEntityMentions(db);
      logger.info?.(`[gigabrain] native sync changed=${nativeSync.changed_files} inserted=${nativeSync.inserted_chunks}`);
    });

    if (api.registerHttpHandler) {
      const token = String((rawConfig as any)?.runtime?.apiToken || process.env.GB_UI_TOKEN || '').trim();
      const handler = createMemoryHttpHandler({
        dbPath,
        config,
        logger,
        token,
      });
      api.registerHttpHandler(handler);
      logger.info?.('[gigabrain] /gb routes registered (including timeline endpoint)');
    }

    api.on('before_agent_start', async (event: any, ctx?: HookContext) => {
      // ── Session tracking ──
      try {
        withDb(dbPath, (db) => startOrResumeSession(db, ctx, logger));
      } catch (sessErr) {
        logger.warn?.(`[gigabrain] session start error: ${sessErr instanceof Error ? sessErr.message : String(sessErr)}`);
      }

      // ── Memory recall ──
      try {
        const query = extractUserQuery(event);
        if (shouldSkipRecall(query)) return;
        const scope = resolveScopeFromCtx(event, ctx);
        const recall = withDb(dbPath, (db) => recallForQuery({
          db,
          config,
          query,
          scope,
        }));
        if (!recall?.injection) return;

        logger.info?.(`[gigabrain] recall injected ${recall.injection.length} chars for scope=${scope}`);
        return {
          prependContext: recall.injection,
        };
      } catch (err) {
        logger.warn?.(`[gigabrain] recall hook error: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    });

    api.on('agent_end', async (event: any, ctx?: HookContext) => {
      // ── Session tracking ──
      try {
        withDb(dbPath, (db) => endSession(db, ctx, logger));
      } catch (sessErr) {
        logger.warn?.(`[gigabrain] session end error: ${sessErr instanceof Error ? sessErr.message : String(sessErr)}`);
      }

      // ── Memory capture ──
      if (config.capture.enabled === false) return;
      try {
        const payload = extractCapturePayload(event, ctx);
        const result = withDb(dbPath, (db) => captureFromEvent({
          db,
          config,
          event: payload,
          logger,
          runId: `capture-${new Date().toISOString().replace(/[:.]/g, '-')}`,
          reviewVersion: '',
        }));
        logger.info?.(`[gigabrain] capture inserted=${result.inserted} queued=${result.queued_review}`);
      } catch (err) {
        logger.warn?.(`[gigabrain] capture hook error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  },
};

export default gigabrainPlugin;
