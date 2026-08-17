# Remote MCP for Claude and ChatGPT

Gigabrain ships a Streamable HTTP MCP endpoint at `/mcp`. It is designed for a
private self-hosted connector and exposes the same policy layer used by the
local STDIO integration.

Remote mode is read-only by default. It authenticates before tool discovery or
retrieval, intersects token memory scopes with an exact server-side allowlist,
and removes local filesystem paths from every response.

## What is and is not included

Included:

- Streamable HTTP MCP with stateless JSON responses;
- OAuth protected-resource metadata;
- JWT verification against a trusted JWKS;
- issuer, resource/audience, expiry, subject, OAuth-scope, and exact
  memory-scope checks;
- Host and optional Origin allowlists;
- per-IP and per-subject rate limits;
- read-only tool allowlisting and narrow opt-in write scopes;
- privacy-safe recall receipts.

Not included:

- an OAuth authorization server or hosted identity UI;
- TLS termination, DNS, tenant provisioning, billing, or account recovery;
- a guarantee that every OAuth provider supports the current registration flow
  used by every Claude or ChatGPT plan;
- a completed public multitenant service.

Use a maintained OAuth 2.1 provider that supports the target client's current
authorization flow. The provider must issue signed JWT access tokens with the
claims described below. Put Gigabrain behind a reverse proxy or managed ingress
that terminates TLS. Re-check the current Claude and ChatGPT connector
requirements before a public deployment.

## Token contract

A production access token must contain:

- `iss` matching `--auth-issuer`;
- `aud` or `resource` equal to the configured public resource URL;
- `exp` and `sub`;
- OAuth scope `gigabrain:read`;
- one or more exact memory scopes in `gigabrain_scopes`, `memory_scopes`,
  `gb_scopes`, or OAuth entries prefixed with `gigabrain:scope:`.

Example logical claims:

```json
{
  "iss": "https://identity.example.com/",
  "aud": "https://memory.example.com",
  "sub": "user_123",
  "exp": 1786908000,
  "scope": "gigabrain:read gigabrain:checkpoint",
  "gigabrain_scopes": ["project:alpha:7ea9d4"]
}
```

Wildcard memory scopes are rejected. The server also requires the same exact
scope in its own `--allowed-scope` list, so an overly broad token cannot widen
the deployment. An exact remote project scope does not inherit the convenient
local `profile:*` or `shared` overlays and does not open the user store. If a
token carries several allowed memory scopes, recall, recent, and provenance
requests must name one exact `scope` rather than searching them all implicitly.

For acceptance of an `owner_assertion`, or an unevidenced `agent_inference`,
the authenticated token must additionally carry
`gigabrain_authority: "owner"` (or `delegated_owner`). A tool argument cannot
spoof this claim.

## Private loopback smoke test

This verifies transport and policy locally. It is not the configuration to
paste into Claude web or ChatGPT web.

```bash
export GIGABRAIN_MCP_BEARER_TOKEN='generate-a-long-random-secret'

npx gigabrain-mcp \
  --transport http \
  --config ~/.gigabrain/config.json \
  --host 127.0.0.1 \
  --port 8788 \
  --allowed-scope 'project:alpha:7ea9d4'
```

The endpoint is `http://127.0.0.1:8788/mcp`. Do not put a bearer token on a
command line; use `GIGABRAIN_MCP_BEARER_TOKEN` only for private testing.

A no-auth development mode exists only on loopback and remains read-only:

```bash
npx gigabrain-mcp \
  --transport http \
  --config ~/.gigabrain/config.json \
  --host 127.0.0.1 \
  --port 8788 \
  --allowed-scope 'project:alpha:7ea9d4' \
  --allow-no-auth
```

## Production launch

Assume the public connector URL is `https://memory.example.com/mcp`, the OAuth
issuer is `https://identity.example.com/`, and a reverse proxy forwards only to
the loopback process:

```bash
npx gigabrain-mcp \
  --transport http \
  --config ~/.gigabrain/config.json \
  --host 127.0.0.1 \
  --port 8788 \
  --resource-url 'https://memory.example.com' \
  --authorization-server 'https://identity.example.com' \
  --auth-issuer 'https://identity.example.com/' \
  --jwks-url 'https://identity.example.com/.well-known/jwks.json' \
  --allowed-scope 'project:alpha:7ea9d4' \
  --allowed-host 'memory.example.com' \
  --allowed-origin 'https://chatgpt.com' \
  --allowed-origin 'https://claude.ai'
```

Keep the process bound to loopback when a local reverse proxy handles public
traffic. If you bind Gigabrain directly to a non-loopback address, it requires
an explicit allowed-host list and the public resource URL must use HTTPS.

The connector publishes:

- `POST /mcp` - MCP requests;
- `GET /.well-known/oauth-protected-resource` - resource metadata;
- `GET /health` - non-sensitive liveness.

Other methods on `/mcp` return 405. This release deliberately uses stateless
JSON responses and has been exercised with the official MCP SDK transport; a
hosted client that requires a stateful GET/SSE session needs a separate
compatibility gate before deployment.

## Read and write exposure

Every authenticated remote connector can discover only the remote-safe read
allowlist:

- recall, provenance, and recent memories;
- checkpoint list/get;
- claim review;
- receipt get.

`gigabrain_remember` is never remotely exposed.

To expose narrow writes, start the server with `--enable-writes` and grant only
the required OAuth scopes:

| OAuth scope | Tool |
| --- | --- |
| `gigabrain:checkpoint` | `gigabrain_checkpoint` |
| `gigabrain:propose` | `gigabrain_claim_propose` |
| `gigabrain:commit` | `gigabrain_claim_decide` |
| `gigabrain:receipt` | `gigabrain_receipt_write` |

The server advertises write scopes only when writes are enabled. Start with a
read-only connector, validate its receipts and isolation, then create a separate
write-enabled deployment or client registration if needed.

Boolean flags accept explicit values. For example,
`--enable-writes=false` and `--allow-no-auth=false` override an environment
variable that was set to `true`; this is useful in supervised deployments where
the process environment is shared.

## Add to Claude

For Claude's current custom-connector flow, add the remote URL:

```text
https://memory.example.com/mcp
```

Complete the OAuth flow presented by the configured authorization server. Test
with a query constrained to one known project, then try a guessed checkpoint or
memory ID from a different fixture account; it must return no object or content.
Claude Desktop local configuration can continue to use Gigabrain STDIO and is a
separate trust boundary from Claude web.

## Add to ChatGPT

Create a custom MCP app/connector in ChatGPT developer mode and use:

```text
https://memory.example.com/mcp
```

Complete OAuth, inspect the discovered tools, and keep write actions disabled
for the first deployment. Availability and admin controls vary by ChatGPT plan
and can change; follow the current OpenAI workspace instructions rather than
assuming a local STDIO server is reachable from ChatGPT web.

## Conformance checklist

Before sharing a connector URL:

1. TLS is valid and the public resource URL exactly matches token audience.
2. OAuth metadata, PKCE, client registration, consent, token refresh, and logout
   have been exercised with the actual target client.
3. Only intended tools appear, and write tools are absent by default.
4. Search, recent, list, direct get, cursor reuse, parent links, checkpoint
   items, and receipt replay all deny cross-scope access, including local
   profile/shared overlays, without content or metadata leaks.
5. Responses contain no local paths, tokens, raw prompts, or hidden store
   locations.
6. Rate limits, audit retention, revocation, deletion, backup, and incident
   response are documented for the deployment.
7. `node tests/run-all.js`, `npm audit`, the remote-MCP integration tests, and a
   real-client smoke pass on the exact release commit.

Passing the repository integration tests is necessary but does not certify the
external OAuth provider or a hosted deployment.
