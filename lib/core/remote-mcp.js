import { createHash, timingSafeEqual } from 'node:crypto';

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createMcpServer } from './codex-mcp.js';

const REMOTE_READ_TOOLS = Object.freeze([
  'gigabrain_recall',
  'gigabrain_provenance',
  'gigabrain_recent',
  'gigabrain_checkpoint_list',
  'gigabrain_checkpoint_get',
  'gigabrain_claim_review',
  'gigabrain_receipt_get',
]);

const REMOTE_WRITE_TOOL_SCOPES = Object.freeze({
  'gigabrain:checkpoint': 'gigabrain_checkpoint',
  'gigabrain:propose': 'gigabrain_claim_propose',
  'gigabrain:commit': 'gigabrain_claim_decide',
  'gigabrain:receipt': 'gigabrain_receipt_write',
});

const normalizeText = (value = '') => String(value || '').trim();

const normalizeList = (value = []) => {
  const input = Array.isArray(value) ? value : String(value || '').split(',');
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

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') return fallback;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return fallback;
};

const parseInteger = (value, fallback, min, max) => {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(number)));
};

const isLoopbackHost = (host) => ['127.0.0.1', 'localhost', '::1'].includes(String(host || '').toLowerCase());

const normalizeMcpPath = (value = '/mcp') => {
  const path = normalizeText(value) || '/mcp';
  if (!path.startsWith('/') || path.includes('?') || path.includes('#') || path.includes('..')) {
    throw new Error('remote MCP path must be an absolute path without query, fragment, or traversal');
  }
  return path.replace(/\/{2,}/g, '/').replace(/\/$/, '') || '/mcp';
};

const normalizeUrl = (value, field, options = {}) => {
  const text = normalizeText(value);
  if (!text) return '';
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error(`${field} must be an absolute URL`);
  }
  if (parsed.hash) throw new Error(`${field} must not contain a fragment`);
  const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(options.allowLoopbackHttp === true && local)) {
    throw new Error(`${field} must use HTTPS`);
  }
  // OAuth issuer and authorization-server identifiers are exact strings. In
  // particular, a root issuer with a trailing slash is not interchangeable
  // with the same URL without it when validating the `iss` claim.
  if (options.preserveExact === true) return text;
  return parsed.toString().replace(/\/$/, '');
};

const resolveRemoteMcpOptions = (options = {}) => {
  const host = normalizeText(options.host || process.env.GIGABRAIN_MCP_HOST) || '127.0.0.1';
  const port = parseInteger(options.port ?? process.env.GIGABRAIN_MCP_PORT, 8788, 0, 65535);
  const mcpPath = normalizeMcpPath(options.mcpPath || options.mcp_path || process.env.GIGABRAIN_MCP_PATH || '/mcp');
  const allowLoopbackHttp = isLoopbackHost(host);
  const defaultResource = `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
  const configuredResourceUrl = normalizeText(
    options.resourceUrl || options.resource_url || process.env.GIGABRAIN_MCP_RESOURCE_URL,
  );
  const resourceUrl = normalizeUrl(
    configuredResourceUrl || defaultResource,
    'resource URL',
    { allowLoopbackHttp },
  );
  const authorizationServer = normalizeUrl(
    options.authorizationServer || options.authorization_server || process.env.GIGABRAIN_MCP_AUTHORIZATION_SERVER,
    'authorization server',
    { allowLoopbackHttp: true, preserveExact: true },
  );
  const issuer = normalizeUrl(
    options.issuer || process.env.GIGABRAIN_MCP_AUTH_ISSUER || authorizationServer,
    'token issuer',
    { allowLoopbackHttp: true, preserveExact: true },
  );
  const jwksUrl = normalizeUrl(
    options.jwksUrl || options.jwks_url || process.env.GIGABRAIN_MCP_JWKS_URL,
    'JWKS URL',
    { allowLoopbackHttp: true },
  );
  const allowNoAuth = parseBoolean(options.allowNoAuth ?? options.allow_no_auth ?? process.env.GIGABRAIN_MCP_ALLOW_NO_AUTH, false);
  const staticToken = normalizeText(options.staticToken || process.env.GIGABRAIN_MCP_BEARER_TOKEN);
  const allowedScopes = normalizeList(options.allowedScopes || options.allowed_scopes || process.env.GIGABRAIN_MCP_ALLOWED_SCOPES);
  const allowedHosts = normalizeList(options.allowedHosts || options.allowed_hosts || process.env.GIGABRAIN_MCP_ALLOWED_HOSTS);
  const allowedOrigins = normalizeList(options.allowedOrigins || options.allowed_origins || process.env.GIGABRAIN_MCP_ALLOWED_ORIGINS);
  const enableWrites = parseBoolean(options.enableWrites ?? options.enable_writes ?? process.env.GIGABRAIN_MCP_ENABLE_WRITES, false);
  const maxRequestsPerMinute = parseInteger(
    options.maxRequestsPerMinute || options.max_requests_per_minute || process.env.GIGABRAIN_MCP_RATE_LIMIT,
    120,
    10,
    10000,
  );

  if (allowNoAuth && !isLoopbackHost(host)) {
    throw new Error('--allow-no-auth is permitted only on a loopback host');
  }
  const oauthConfigured = Boolean(authorizationServer || issuer || jwksUrl);
  if (!allowNoAuth && !staticToken && !oauthConfigured) {
    throw new Error('remote MCP requires OAuth JWT verification, a private static bearer token, or explicit loopback --allow-no-auth');
  }
  if (oauthConfigured && (!authorizationServer || !issuer || !jwksUrl)) {
    throw new Error('OAuth remote MCP requires authorization server, token issuer, and JWKS URL');
  }
  if (allowedScopes.length === 0) {
    throw new Error('remote MCP requires at least one exact allowed memory scope');
  }
  if (allowedScopes.some((scope) => scope.includes('*'))) {
    throw new Error('remote MCP memory scopes must be exact; wildcards are not allowed');
  }
  if (!isLoopbackHost(host) && allowedHosts.length === 0) {
    throw new Error('non-loopback remote MCP binding requires an explicit allowed-host list');
  }
  return {
    host,
    port,
    mcpPath,
    resourceUrl,
    resourceUrlExplicit: Boolean(configuredResourceUrl),
    resourceMetadataUrl: `${resourceUrl}/.well-known/oauth-protected-resource`,
    resourceDocumentation: normalizeText(options.resourceDocumentation || options.resource_documentation || process.env.GIGABRAIN_MCP_RESOURCE_DOCUMENTATION),
    authorizationServer,
    issuer,
    jwksUrl,
    allowNoAuth,
    staticToken,
    allowedScopes,
    allowedHosts,
    allowedOrigins,
    enableWrites,
    maxRequestsPerMinute,
    logger: options.logger || null,
  };
};

const hashText = (value) => createHash('sha256').update(String(value || '')).digest('hex');

const safeTokenEqual = (left, right) => {
  const leftHash = Buffer.from(hashText(left), 'hex');
  const rightHash = Buffer.from(hashText(right), 'hex');
  return timingSafeEqual(leftHash, rightHash);
};

const parseBearerToken = (header = '') => {
  const match = String(header || '').match(/^Bearer\s+([^\s]+)$/i);
  return match ? match[1] : '';
};

const parseOAuthScopes = (payload = {}) => {
  const values = [];
  if (typeof payload.scope === 'string') values.push(...payload.scope.split(/\s+/));
  if (Array.isArray(payload.scp)) values.push(...payload.scp);
  if (typeof payload.scp === 'string') values.push(...payload.scp.split(/\s+/));
  return normalizeList(values);
};

const parseMemoryScopes = (payload = {}, oauthScopes = []) => {
  const direct = payload.gigabrain_scopes ?? payload.memory_scopes ?? payload.gb_scopes;
  const fromClaims = normalizeList(Array.isArray(direct) ? direct : (typeof direct === 'string' ? direct.split(/[\s,]+/) : []));
  const fromOauth = oauthScopes
    .filter((scope) => scope.startsWith('gigabrain:scope:'))
    .map((scope) => scope.slice('gigabrain:scope:'.length));
  return normalizeList([...fromClaims, ...fromOauth]);
};

const intersectExactScopes = (tokenScopes = [], configuredScopes = []) => {
  const token = normalizeList(tokenScopes);
  const configured = normalizeList(configuredScopes);
  if (token.some((scope) => scope.includes('*')) || configured.some((scope) => scope.includes('*'))) {
    throw new Error('wildcard memory scopes are not accepted');
  }
  if (configured.length === 0) return token;
  if (token.length === 0) return [];
  const allowed = new Set(configured);
  return token.filter((scope) => allowed.has(scope));
};

const audienceMatches = (payload = {}, resourceUrl = '') => {
  const audience = Array.isArray(payload.aud) ? payload.aud : (payload.aud ? [payload.aud] : []);
  const resource = payload.resource ? [payload.resource] : [];
  return [...audience, ...resource].some((value) => String(value) === String(resourceUrl));
};

const createAccessTokenVerifier = (resolved) => {
  const jwks = resolved.jwksUrl ? createRemoteJWKSet(new URL(resolved.jwksUrl)) : null;
  return async (token) => {
    if (resolved.staticToken && safeTokenEqual(token, resolved.staticToken)) {
      return {
        subject: `static:${hashText(token).slice(0, 12)}`,
        clientId: 'private-bearer',
        oauthScopes: [
          'gigabrain:read',
          ...(resolved.enableWrites ? Object.keys(REMOTE_WRITE_TOOL_SCOPES) : []),
        ],
        memoryScopes: resolved.allowedScopes,
        authority: 'owner',
        expiresAt: null,
        tokenKind: 'static',
      };
    }
    if (!jwks || !resolved.issuer) throw new Error('unknown bearer token');
    const verified = await jwtVerify(token, jwks, {
      issuer: resolved.issuer,
      clockTolerance: 5,
    });
    const payload = verified.payload || {};
    if (!audienceMatches(payload, resolved.resourceUrl)) throw new Error('token audience does not match the Gigabrain resource');
    if (!Number.isFinite(Number(payload.exp))) throw new Error('access token must include exp');
    if (Number(payload.exp) <= Math.floor(Date.now() / 1000)) throw new Error('access token expired');
    const subject = normalizeText(payload.sub);
    if (!subject) throw new Error('access token must include sub');
    const oauthScopes = parseOAuthScopes(payload);
    const claimedMemoryScopes = parseMemoryScopes(payload, oauthScopes);
    const memoryScopes = intersectExactScopes(claimedMemoryScopes, resolved.allowedScopes);
    return {
      subject,
      clientId: normalizeText(payload.client_id || payload.azp) || 'oauth-client',
      oauthScopes,
      memoryScopes,
      authority: normalizeText(payload.gigabrain_authority),
      expiresAt: Number(payload.exp),
      tokenKind: 'jwt',
    };
  };
};

const resolveEnabledRemoteTools = (auth, options = {}) => {
  const tools = new Set(REMOTE_READ_TOOLS);
  if (options.enableWrites === true) {
    for (const [scope, tool] of Object.entries(REMOTE_WRITE_TOOL_SCOPES)) {
      if (auth.oauthScopes.includes(scope)) tools.add(tool);
    }
  }
  return Array.from(tools);
};

const createRateLimiter = (maxRequestsPerMinute) => {
  const buckets = new Map();
  const windowMs = 60_000;
  return (key) => {
    const now = Date.now();
    const bucketKey = normalizeText(key) || 'anonymous';
    const current = buckets.get(bucketKey) || [];
    const recent = current.filter((timestamp) => timestamp > now - windowMs);
    if (recent.length >= maxRequestsPerMinute) {
      buckets.set(bucketKey, recent);
      return false;
    }
    recent.push(now);
    buckets.set(bucketKey, recent);
    if (buckets.size > 5000) {
      for (const [candidate, timestamps] of buckets.entries()) {
        if (timestamps.every((timestamp) => timestamp <= now - windowMs)) buckets.delete(candidate);
      }
    }
    return true;
  };
};

const sendJsonRpcError = (res, status, code, message, headers = {}) => {
  res.status(status);
  for (const [name, value] of Object.entries(headers)) res.set(name, value);
  res.json({
    jsonrpc: '2.0',
    error: { code, message },
    id: null,
  });
};

const challengeHeader = (resolved, error = 'invalid_token', description = 'Authentication is required') => {
  const clean = String(description || '').replace(/["\r\n]/g, ' ').slice(0, 160);
  return `Bearer resource_metadata="${resolved.resourceMetadataUrl}", scope="gigabrain:read", error="${error}", error_description="${clean}"`;
};

const createRemoteMcpApp = (defaults = {}, options = {}) => {
  const resolved = resolveRemoteMcpOptions(options);
  const app = createMcpExpressApp({
    host: resolved.host,
    allowedHosts: resolved.allowedHosts.length > 0 ? resolved.allowedHosts : undefined,
  });
  const verifyToken = createAccessTokenVerifier(resolved);
  const allowRequest = createRateLimiter(resolved.maxRequestsPerMinute);

  if (resolved.allowedOrigins.length > 0) {
    app.use((req, res, next) => {
      const origin = normalizeText(req.headers.origin);
      if (origin && !resolved.allowedOrigins.includes(origin)) {
        sendJsonRpcError(res, 403, -32000, 'Origin is not allowed');
        return;
      }
      next();
    });
  }

  const metadata = {
    resource: resolved.resourceUrl,
    ...(resolved.authorizationServer ? { authorization_servers: [resolved.authorizationServer] } : {}),
    scopes_supported: [
      'gigabrain:read',
      ...(resolved.enableWrites
        ? ['gigabrain:checkpoint', 'gigabrain:propose', 'gigabrain:commit', 'gigabrain:receipt']
        : []),
    ],
    ...(resolved.resourceDocumentation ? { resource_documentation: resolved.resourceDocumentation } : {}),
  };
  app.get('/.well-known/oauth-protected-resource', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json(metadata);
  });
  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'gigabrain-mcp', transport: 'streamable-http' });
  });

  const authenticate = async (req, res) => {
    if (!allowRequest(`ip:${normalizeText(req.ip || req.socket?.remoteAddress)}`)) {
      sendJsonRpcError(res, 429, -32002, 'Rate limit exceeded', { 'Retry-After': '60' });
      return null;
    }
    let auth;
    if (resolved.allowNoAuth) {
      auth = {
        subject: 'loopback-development',
        clientId: 'loopback',
        oauthScopes: ['gigabrain:read'],
        memoryScopes: resolved.allowedScopes,
        authority: '',
        expiresAt: null,
        tokenKind: 'noauth',
      };
    } else {
      const token = parseBearerToken(req.headers.authorization);
      if (!token) {
        sendJsonRpcError(res, 401, -32001, 'Authentication required', {
          'WWW-Authenticate': challengeHeader(resolved, 'invalid_token', 'No bearer token was provided'),
        });
        return null;
      }
      try {
        auth = await verifyToken(token);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Token verification failed';
        resolved.logger?.warn?.({ event: 'gigabrain_mcp_auth_failed', reason: message });
        sendJsonRpcError(res, 401, -32001, 'Authentication failed', {
          'WWW-Authenticate': challengeHeader(resolved, 'invalid_token', message),
        });
        return null;
      }
    }
    try {
      if (!auth.oauthScopes.includes('gigabrain:read')) {
        sendJsonRpcError(res, 403, -32003, 'The token does not grant gigabrain:read', {
          'WWW-Authenticate': challengeHeader(resolved, 'insufficient_scope', 'The connector requires gigabrain:read'),
        });
        return null;
      }
      if (auth.memoryScopes.length === 0) {
        sendJsonRpcError(res, 403, -32003, 'No authorized Gigabrain memory scope');
        return null;
      }
      if (!allowRequest(`subject:${hashText(auth.subject)}`)) {
        sendJsonRpcError(res, 429, -32002, 'Rate limit exceeded', { 'Retry-After': '60' });
        return null;
      }
      return auth;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Authorization failed';
      resolved.logger?.warn?.({ event: 'gigabrain_mcp_authorization_failed', reason: message });
      sendJsonRpcError(res, 403, -32003, 'Authorization failed');
      return null;
    }
  };

  app.post(resolved.mcpPath, async (req, res) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    const enabledTools = resolveEnabledRemoteTools(auth, resolved);
    const server = createMcpServer({
      ...defaults,
      transportProfile: 'remote',
      enabledTools,
      allowedScopes: auth.memoryScopes,
      includeLocalPaths: false,
      recordReceipts: true,
      actorId: auth.subject,
      actorHost: `oauth:${auth.clientId}`,
      sourceAgent: auth.subject,
      sourceHost: `oauth:${auth.clientId}`,
      authorization: {
        subject: auth.subject,
        clientId: auth.clientId,
        permissions: auth.oauthScopes,
        memoryScopes: auth.memoryScopes,
        authority: auth.authority,
        expiresAt: auth.expiresAt,
      },
    });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      resolved.logger?.error?.({
        event: 'gigabrain_mcp_request_failed',
        message: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) sendJsonRpcError(res, 500, -32603, 'Internal MCP error');
    } finally {
      try { await transport.close(); } catch { /* best effort */ }
      try { await server.close(); } catch { /* best effort */ }
    }
  });

  for (const method of ['get', 'delete', 'put', 'patch']) {
    app[method](resolved.mcpPath, (_req, res) => {
      res.set('Allow', 'POST');
      sendJsonRpcError(res, 405, -32000, 'Method not allowed');
    });
  }

  return { app, options: resolved, metadata };
};

const startRemoteMcpServer = async (defaults = {}, options = {}) => {
  const created = createRemoteMcpApp(defaults, options);
  const httpServer = await new Promise((resolve, reject) => {
    const listener = created.app.listen(created.options.port, created.options.host, () => resolve(listener));
    listener.once('error', reject);
  });
  const address = httpServer.address();
  if (!created.options.resourceUrlExplicit && created.options.port === 0 && address && typeof address === 'object') {
    const actualHost = created.options.host.includes(':') ? `[${created.options.host}]` : created.options.host;
    created.options.resourceUrl = `http://${actualHost}:${address.port}`;
    created.options.resourceMetadataUrl = `${created.options.resourceUrl}/.well-known/oauth-protected-resource`;
    created.metadata.resource = created.options.resourceUrl;
  }
  return {
    ...created,
    httpServer,
    address,
    close: () => new Promise((resolve, reject) => {
      httpServer.close((error) => (error ? reject(error) : resolve()));
    }),
  };
};

export {
  REMOTE_READ_TOOLS,
  REMOTE_WRITE_TOOL_SCOPES,
  resolveRemoteMcpOptions,
  resolveEnabledRemoteTools,
  createAccessTokenVerifier,
  createRemoteMcpApp,
  startRemoteMcpServer,
};
