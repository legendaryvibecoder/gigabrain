import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { V3_CONFIG_SCHEMA, normalizeConfig } from './lib/core/config.js';
import { GIGABRAIN_HTTP_ROUTES, createMemoryHttpHandler } from './lib/core/http-routes.js';
import { ensureProjectionStore, materializeProjectionFromMemories } from './lib/core/projection-store.js';
import { ensureEventStore } from './lib/core/event-store.js';
import { captureFromEvent } from './lib/core/capture-service.js';
import { orchestrateRecall } from './lib/core/orchestrator.js';
import { ensureNativeStore, syncNativeMemory } from './lib/core/native-sync.js';
import { promoteNativeChunks } from './lib/core/native-promotion.js';
import { ensurePersonStore, rebuildEntityMentions } from './lib/core/person-service.js';
import { ensureWorldModelReady, ensureWorldModelStore, getSynthesis, rebuildWorldModel } from './lib/core/world-model.js';
import { openDatabase } from './lib/core/sqlite.js';
import { recordRecallLatency } from './lib/core/metrics.js';

type PluginApi = {
  config?: unknown;
  logger?: {
    info?: (msg: string) => void;
    warn?: (msg: string) => void;
    error?: (msg: string) => void;
  };
  on: (event: string, handler: (...args: any[]) => any) => void;
  registerHttpHandler?: (handler: (req: any, res: any) => Promise<boolean> | boolean) => void;
  registerHttpRoute?: (params: {
    path: string;
    auth?: 'gateway' | 'plugin';
    match?: 'exact' | 'prefix';
    handler: (req: any, res: any) => Promise<void> | void;
  }) => void;
};

type PluginConfig = ReturnType<typeof normalizeConfig>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const resolveRawPluginConfig = (raw: unknown): Record<string, unknown> => {
  if (!isObject(raw)) return {};
  const nested = (raw as any)?.plugins?.entries?.gigabrain?.config;
  if (isObject(nested)) return nested;
  return raw as Record<string, unknown>;
};

const resolveGatewayAuthToken = (raw: unknown): string => {
  if (!isObject(raw)) return '';
  const gateway = (raw as any)?.gateway;
  if (!isObject(gateway)) return '';
  const auth = gateway?.auth;
  if (!isObject(auth)) return '';
  return String(auth?.token || '').trim();
};

const parseAgentIdFromSessionKey = (sessionKey: string): string => {
  const parts = String(sessionKey || '').split(':');
  return String(parts[1] || 'shared').trim() || 'shared';
};

const slugifyScopeToken = (value: string): string => {
  const input = String(value || '').toLowerCase();
  let out = '';
  let lastWasDash = false;
  for (const char of input) {
    const code = char.charCodeAt(0);
    const isLower = code >= 97 && code <= 122;
    const isDigit = code >= 48 && code <= 57;
    if (isLower || isDigit) {
      out += char;
      lastWasDash = false;
      continue;
    }
    if (!lastWasDash && out) {
      out += '-';
      lastWasDash = true;
    }
  }
  if (out.endsWith('-')) out = out.slice(0, -1);
  return out.slice(0, 40);
};

const deriveScopeFromWorkspaceDir = (workspaceDir: string): string => {
  const resolved = String(workspaceDir || '').trim();
  if (!resolved) return '';
  const absolute = path.resolve(resolved);
  const slug = slugifyScopeToken(path.basename(absolute)) || 'workspace';
  const hash = createHash('sha1').update(absolute).digest('hex').slice(0, 8);
  return `project:${slug}:${hash}`;
};

const GIGABRAIN_CONTEXT_RE = /<gigabrain-context>([\s\S]*?)<\/gigabrain-context>/gi;
const QUERY_META_LINE_RE = /^(?:fallback|memories|instruction|entity_mode|conversation info|to send an image back)\s*:/i;
const BOOTSTRAP_INJECTION_RE = /\b(?:you are running a boot check|boot\.md|reply with only:\s*no_reply|a new session was started via \/new or \/reset|session startup sequence|follow boot\.md instructions exactly)\b/i;
const NO_REPLY_ONLY_RE = /^no_reply[.!]?$/i;
const FOLLOWUP_PRONOUN_RE = /\b(?:sie|er|ihn|ihr|her|him|them|diese(?:r|n|m)?|jene(?:r|n|m)?|that person|diese person|jene person)\b/i;
const FOLLOWUP_INTENT_RE = /\b(?:was|what|sag|tell|erz[aä]hl|noch|mehr|else|weiter|weiteres)\b/i;
const ENTITY_FROM_QUERY_RE = /\b(?:wer\s+ist|who\s+is|who\s+was|what\s+do\s+you\s+know\s+about|tell\s+me\s+about|was\s+wei(?:ss|ß)t\s+du\s+über|was\s+weisst\s+du\s+ueber|über|ueber|about)\s+([a-zA-ZÀ-ÖØ-öø-ÿ][a-zA-ZÀ-ÖØ-öø-ÿ0-9'’._-]*(?:\s+[a-zA-ZÀ-ÖØ-öø-ÿ][a-zA-ZÀ-ÖØ-öø-ÿ0-9'’._-]*){0,2})/i;
const ENTITY_STOPWORDS = new Set([
  'sie', 'er', 'ihr', 'ihn', 'her', 'him', 'them', 'diese', 'dieser', 'diesem',
  'jener', 'jene', 'jenem', 'person', 'about', 'ueber', 'über', 'who', 'what',
]);
const MAX_QUERY_SCAN_MESSAGES = 200;
const MAX_QUERY_MESSAGE_CHARS = 12000;

const messageToText = (msg: any): string => {
  if (typeof msg?.content === 'string') return msg.content;
  if (Array.isArray(msg?.content)) {
    return msg.content
      .map((part: any) => (typeof part?.text === 'string' ? part.text : ''))
      .join('\n');
  }
  return '';
};

const getScannableMessages = (event: any): any[] => {
  const messages = Array.isArray(event?.messages) ? event.messages : [];
  if (messages.length <= MAX_QUERY_SCAN_MESSAGES) return messages;
  return messages.slice(-MAX_QUERY_SCAN_MESSAGES);
};

const messageToScannableText = (msg: any): string => messageToText(msg).slice(0, MAX_QUERY_MESSAGE_CHARS);

const extractContextQuery = (input: string): string => {
  const text = String(input || '');
  const candidates: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = GIGABRAIN_CONTEXT_RE.exec(text)) !== null) {
    const block = String(match[1] || '');
    const lines = block.split(/\r?\n/);
    for (const rawLine of lines) {
      const line = String(rawLine || '').trim();
      if (!line) continue;
      if (!line.toLowerCase().startsWith('query:')) continue;
      const value = line.slice('query:'.length).trim();
      if (value) candidates.push(value);
    }
  }
  return candidates.length > 0 ? candidates[candidates.length - 1] : '';
};

const sanitizeCandidateQuery = (input: string): string => {
  let text = String(input || '').trim();
  if (!text) return '';

  for (let i = 0; i < 3; i += 1) {
    const contextQuery = extractContextQuery(text);
    if (!contextQuery) break;
    if (contextQuery === text) break;
    text = contextQuery;
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => String(line || '').trim())
    .filter(Boolean);
  const cleaned: string[] = [];
  for (const line of lines) {
    if (line.startsWith('```')) continue;
    if (/^[-*]\s*\[.+\]\s*\(.+\)\s*/.test(line)) continue;
    if (QUERY_META_LINE_RE.test(line)) continue;
    if (/^\{.*\}$/.test(line)) continue;
    if (/^\[[^\]]+\]\s*$/.test(line)) continue;
    cleaned.push(line);
  }

  text = cleaned.length > 0 ? cleaned.join(' ') : text;
  text = text.replace(/^\[[^\]]+\]\s*/, '').trim();
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length > 600) text = text.slice(0, 600).trim();

  if (!text) return '';
  if (NO_REPLY_ONLY_RE.test(text)) return '';
  if (BOOTSTRAP_INJECTION_RE.test(text)) return '';
  return text;
};

const resolveScopeForEvent = (event: any): string => {
  const explicit = String(event?.scope || event?.agentId || '').trim();
  if (explicit) return explicit;

  const sessionKey = String(event?.sessionKey || event?.meta?.sessionKey || '').trim();
  if (sessionKey) {
    const parsedAgentId = parseAgentIdFromSessionKey(sessionKey);
    if (parsedAgentId && parsedAgentId !== 'shared') return parsedAgentId;
  }

  const workspaceScope = deriveScopeFromWorkspaceDir(String(event?.workspaceDir || '').trim());
  if (workspaceScope) return workspaceScope;
  if (!sessionKey) return 'shared';
  return parseAgentIdFromSessionKey(sessionKey);
};

const mergeEventWithCtx = (event: any, ctx: any) => {
  const merged = {
    ...(isObject(event) ? event : {}),
  } as any;
  const context = isObject(ctx) ? ctx : {};

  const sessionKey = String(
    merged?.sessionKey
    || merged?.meta?.sessionKey
    || merged?.metadata?.sessionKey
    || context?.sessionKey
    || '',
  ).trim();
  const agentId = String(merged?.agentId || context?.agentId || '').trim();

  if (agentId && !String(merged.agentId || '').trim()) merged.agentId = agentId;
  if (sessionKey && !String(merged.sessionKey || '').trim()) merged.sessionKey = sessionKey;
  if (sessionKey) {
    const meta = isObject(merged.meta) ? merged.meta : {};
    if (!String(meta.sessionKey || '').trim()) {
      merged.meta = {
        ...meta,
        sessionKey,
      };
    }
  }
  if (!String(merged.workspaceDir || '').trim() && String(context?.workspaceDir || '').trim()) {
    merged.workspaceDir = String(context.workspaceDir).trim();
  }
  if (!String(merged.trigger || '').trim() && String(context?.trigger || '').trim()) {
    merged.trigger = String(context.trigger).trim();
  }
  if (!String(merged.channelId || '').trim() && String(context?.channelId || '').trim()) {
    merged.channelId = String(context.channelId).trim();
  }
  return merged;
};

const extractUserQuery = (event: any): string => {
  const messages = getScannableMessages(event);
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    const role = String(msg?.role || '').toLowerCase();
    if (role !== 'user') continue;
    const content = messageToScannableText(msg);
    const sanitized = sanitizeCandidateQuery(content);
    if (sanitized) return sanitized;
  }
  return sanitizeCandidateQuery(String(event?.prompt || ''));
};

const extractEntityHintFromQuery = (query: string): string => {
  const text = String(query || '').trim();
  if (!text) return '';
  const match = text.match(ENTITY_FROM_QUERY_RE);
  if (!match?.[1]) return '';
  const candidate = String(match[1] || '')
    .trim()
    .replace(/[?!.,;:]+$/g, '')
    .replace(/\s+/g, ' ');
  if (!candidate) return '';
  const normalized = candidate.toLowerCase();
  if (ENTITY_STOPWORDS.has(normalized)) return '';
  return candidate;
};

const isLikelyEntityFollowup = (query: string): boolean => {
  const text = String(query || '').trim();
  if (!text) return false;
  return FOLLOWUP_PRONOUN_RE.test(text) && FOLLOWUP_INTENT_RE.test(text);
};

const normalizedQueryKey = (value: string): string =>
  String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();

const findPreviousEntityHint = (messages: any[], currentQuery: string): string => {
  const list = Array.isArray(messages) ? messages.slice(-MAX_QUERY_SCAN_MESSAGES) : [];
  let skippedCurrent = false;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const msg = list[i];
    if (String(msg?.role || '').toLowerCase() !== 'user') continue;
    const candidate = sanitizeCandidateQuery(messageToScannableText(msg));
    if (!candidate) continue;
    if (!skippedCurrent && normalizedQueryKey(candidate) === normalizedQueryKey(currentQuery)) {
      skippedCurrent = true;
      continue;
    }
    const hint = extractEntityHintFromQuery(candidate);
    if (hint) return hint;
  }
  return '';
};

const enrichQueryWithEntityContext = (query: string, messages: any[]): string => {
  const base = String(query || '').trim();
  if (!base) return '';
  if (extractEntityHintFromQuery(base)) return base;
  if (!isLikelyEntityFollowup(base)) return base;
  const hint = findPreviousEntityHint(messages, base);
  if (!hint) return base;
  const lowered = base.toLowerCase();
  if (lowered.includes(hint.toLowerCase())) return base;
  return `${base} ${hint}`.trim();
};

const extractCapturePayload = (event: any) => {
  const output = String(
    event?.output
      || event?.result
      || event?.response
      || event?.final
      || '',
  );
  return {
    scope: resolveScopeForEvent(event),
    agentId: String(event?.agentId || parseAgentIdFromSessionKey(String(event?.sessionKey || ''))),
    sessionKey: String(event?.sessionKey || ''),
    text: output,
    prompt: String(event?.prompt || ''),
    messages: Array.isArray(event?.messages) ? event.messages : [],
  };
};

const resolveSessionKey = (event: any): string => String(
  event?.sessionKey
  || event?.meta?.sessionKey
  || event?.metadata?.sessionKey
  || '',
).trim();

const buildSessionPreludeInjection = (content: string): string => {
  const lines = ['<gigabrain-session-brief>'];
  lines.push('instruction: This is the latest Gigabrain session prelude. Use it silently as grounding at the start of the session.');
  lines.push('instruction: Prefer this briefing and later Gigabrain recall context over ad-hoc verification unless the user explicitly asks for exact provenance.');
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = String(rawLine || '').trim();
    if (!line) continue;
    lines.push(line);
  }
  lines.push('</gigabrain-session-brief>');
  return `${lines.join('\n')}\n`;
};

const BRIEFED_SESSION_LIMIT = 2048;
const BRIEFED_SESSION_RETAIN = 1536;

const hasSessionPrelude = (cache: Map<string, number>, sessionKey: string): boolean => {
  const key = String(sessionKey || '').trim();
  if (!key) return false;
  const existing = cache.get(key);
  if (!Number.isFinite(existing)) return false;
  cache.set(key, Date.now());
  return true;
};

const markSessionBriefed = (cache: Map<string, number>, sessionKey: string) => {
  const key = String(sessionKey || '').trim();
  if (!key) return;
  cache.set(key, Date.now());
  if (cache.size <= BRIEFED_SESSION_LIMIT) return;
  const survivors = Array.from(cache.entries())
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, BRIEFED_SESSION_RETAIN);
  cache.clear();
  for (const [survivorKey, timestamp] of survivors) {
    cache.set(survivorKey, timestamp);
  }
};

const withDb = <T,>(dbPath: string, config: PluginConfig, fn: (db: any) => T): T => {
  // Reuse the shared SQLite opener so transient writer contention waits instead of failing fast.
  const db = openDatabase(dbPath);
  try {
    ensureProjectionStore(db);
    ensureEventStore(db);
    ensureNativeStore(db);
    ensurePersonStore(db);
    ensureWorldModelStore(db);
    const count = db.prepare('SELECT COUNT(*) AS c FROM memory_current').get()?.c || 0;
    if (Number(count) === 0) {
      materializeProjectionFromMemories(db);
    }
    ensureWorldModelReady({ db, config });
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
  if (NO_REPLY_ONLY_RE.test(text)) return true;
  if (BOOTSTRAP_INJECTION_RE.test(text)) return true;
  return false;
};

const gigabrainPlugin = {
  id: 'gigabrain',
  name: 'Gigabrain',
  description: 'Gigabrain v3 lean memory engine (event timeline + current projection)',
  kind: 'memory' as const,
  configSchema: V3_CONFIG_SCHEMA,

  register(api: PluginApi) {
    const logger = api.logger || {};
    const rawConfig = resolveRawPluginConfig(api.config);
    const briefedSessions = new Map<string, number>();

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

    withDb(dbPath, config, () => undefined);
    withDb(dbPath, config, (db) => {
      if (config.native.enabled === false) return;
      const nativeSync = syncNativeMemory({
        db,
        config,
        dryRun: false,
      });
      const nativePromotion = promoteNativeChunks({
        db,
        config,
        sourcePaths: nativeSync.changed_sources || [],
        dryRun: false,
      });
      rebuildEntityMentions(db);
      if (config.worldModel?.enabled !== false) {
        const worldModel = rebuildWorldModel({ db, config });
        logger.info?.(`[gigabrain] world model entities=${worldModel.counts.entities} beliefs=${worldModel.counts.beliefs} syntheses=${worldModel.counts.syntheses}`);
      }
      logger.info?.(`[gigabrain] native sync changed=${nativeSync.changed_files} inserted=${nativeSync.inserted_chunks} promoted=${nativePromotion.promoted_inserted} linked=${nativePromotion.linked_existing}`);
    });

    if (api.registerHttpHandler || api.registerHttpRoute) {
      const token = String(
        (rawConfig as any)?.runtime?.apiToken
        || resolveGatewayAuthToken(api.config)
        || process.env.GB_UI_TOKEN
        || '',
      ).trim();
      const allowNoAuth = ['1', 'true', 'yes'].includes(String(process.env.GB_ALLOW_NO_AUTH || '').trim().toLowerCase());
      if (!token && !allowNoAuth) {
        logger.warn?.('[gigabrain] HTTP routes disabled: no GB_UI_TOKEN or gateway.auth.token available');
      } else {
        const handler = createMemoryHttpHandler({
          dbPath,
          config,
          logger,
          token,
          allowNoAuth,
        });
        if (api.registerHttpRoute) {
          for (const route of GIGABRAIN_HTTP_ROUTES) {
            api.registerHttpRoute({
              path: route.path,
              auth: 'gateway',
              match: route.match,
              handler: async (req: any, res: any) => {
                const handled = await handler(req, res);
                if (!handled && !res.headersSent) {
                  res.statusCode = 404;
                  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
                  res.end('Not Found');
                }
              },
            });
          }
          logger.info?.(`[gigabrain] /gb routes registered via registerHttpRoute (${GIGABRAIN_HTTP_ROUTES.length})`);
        } else if (api.registerHttpHandler) {
          api.registerHttpHandler(handler);
          logger.info?.('[gigabrain] /gb routes registered via registerHttpHandler');
        }
      }
    }

    api.on('before_agent_start', async (event: any, ctx: any) => {
      try {
        const resolvedEvent = mergeEventWithCtx(event, ctx);
        const baseQuery = extractUserQuery(resolvedEvent);
        const messages = Array.isArray(resolvedEvent?.messages) ? resolvedEvent.messages : [];
        const query = enrichQueryWithEntityContext(baseQuery, messages);
        if (shouldSkipRecall(query)) return;
        const scope = resolveScopeForEvent(resolvedEvent);
        const sessionKey = resolveSessionKey(resolvedEvent);
        const { recall, sessionPrelude } = withDb(dbPath, config, (db) => {
          const recallStartMs = performance.now();
          const orchestrated = orchestrateRecall({
            db,
            config,
            query,
            scope,
          });
          const recallElapsedMs = Math.round(performance.now() - recallStartMs);
          const recallChars = String(orchestrated?.injection || '').length;
          recordRecallLatency({
            ms: recallElapsedMs,
            strategy: orchestrated?.strategy || '',
            chars: recallChars,
            resultCount: Array.isArray(orchestrated?.results) ? orchestrated.results.length : 0,
          });
          logger.info?.(`[gigabrain] recall injected ${recallChars} chars in ${recallElapsedMs}ms strategy=${orchestrated?.strategy || 'unknown'}`);
          const shouldInjectPrelude = Boolean(
            config?.synthesis?.enabled !== false
            && config?.synthesis?.briefing?.enabled !== false
            && config?.synthesis?.briefing?.includeSessionPrelude !== false
            && sessionKey
            && !hasSessionPrelude(briefedSessions, sessionKey),
          );
          if (!shouldInjectPrelude) {
            return {
              recall: orchestrated,
              sessionPrelude: '',
            };
          }
          const synthesis = getSynthesis(db, {
            kind: 'session_brief',
            subjectType: 'global',
            subjectId: 'global',
          });
          return {
            recall: orchestrated,
            sessionPrelude: synthesis?.content ? buildSessionPreludeInjection(synthesis.content) : '',
          };
        });
        if (!recall?.injection) return;

        const combinedInjection = [sessionPrelude, recall.injection]
          .filter((part) => String(part || '').trim().length > 0)
          .join('\n\n');
        if (!combinedInjection) return;
        if (sessionKey && sessionPrelude) {
          markSessionBriefed(briefedSessions, sessionKey);
        }
        logger.info?.(`[gigabrain] recall injected ${recall.injection.length} chars strategy=${recall.strategy || 'unknown'}`);
        return {
          appendSystemContext: combinedInjection,
        };
      } catch (err) {
        logger.warn?.(`[gigabrain] recall hook error: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    });

    api.on('agent_end', async (event: any, ctx: any) => {
      if (config.capture.enabled === false) return;
      try {
        const resolvedEvent = mergeEventWithCtx(event, ctx);
        const payload = extractCapturePayload(resolvedEvent);
        const result = withDb(dbPath, config, (db) => captureFromEvent({
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
export {
  deriveScopeFromWorkspaceDir,
  hasSessionPrelude,
  markSessionBriefed,
};
