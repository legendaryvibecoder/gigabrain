# Privacy model

Gigabrain is local-first, not magically private. It keeps the default data path on the operator's machine and makes every optional boundary expansion explicit. The local store can still contain sensitive information and must be protected like any other personal database.

## Default boundary

The standalone setup creates a local configuration, event store, projections, and generated memory files under the configured Gigabrain root. The default LLM provider is `none`; lexical recall, scope checks, provenance, expiration, and deterministic policy do not require a model service.

Supported host-memory adapters read local source files and import normalized records into Gigabrain. They do not write changes back into Codex, Claude Code, Hermes, Cursor, or Windsurf memory stores. Account-level memory in hosted products is not scraped.

## Data flows

| Feature | Default | Data that can cross a process or host boundary |
| --- | --- | --- |
| SQLite + FTS5 recall | On | None; runs in the Gigabrain process |
| Ollama embeddings | Optional, loopback only | Query and memory text to the configured loopback Ollama process |
| Local transcript extraction | Optional | Raw transcript text to the local extractor |
| Cloud review provider | Off | Audit review skips credential-shaped rows entirely, locally masks common credential/email/IP/home-user-path shapes, and removes the original scope before sending one candidate fact; raw transcript extraction is skipped |
| Host-memory import | On during setup/maintenance when sources are enabled | Reads supported local memory files into the local store |
| Cloud-inbox import | Off | Reads only files the operator places in the local inbox |
| Remote bridge | Off | Recall query, scope, and returned context to/from the configured authenticated endpoint |
| Remote MCP connector | Off | OAuth bearer metadata, recall query, one exact selected memory scope, and the authorized response between a client and the operator's self-hosted endpoint; returned local paths are redacted |
| Obsidian findings inbox | Off | A bounded contradiction digest and bearer token to a verified loopback HTTPS Local REST API; a custom CA file can be configured |
| Handoff/export bundle | Manual | Only the generated artifact the operator chooses to move |
| Python URL import | Off | Bounded HTTP(S) request to an explicitly allowlisted host; the public address is validated once and pinned for the connection |
| Python web console UI | Optional | Same-origin API calls only; browser assets are local and no third-party CDN is contacted. The single-file console CSP permits its own inline script and style blocks but no external origin. |

Remote MCP is an access profile, not database synchronization. It binds to loopback by default. A shared deployment requires TLS ingress and an OAuth authorization server chosen by the operator. Token scopes are intersected with a server-side memory-scope allowlist before tool discovery or reads. Broad `gigabrain_remember` is never exposed remotely, and all remote writes remain disabled unless the operator enables them and grants the corresponding narrow OAuth scope.

The code does not provide a hosted Gigabrain service, OAuth authorization server, TLS ingress, telemetry collector, or hidden account-memory scraper.

## What is stored

Depending on enabled features, the local store can contain:

- remembered facts, preferences, decisions, and project context
- source host, path, line, agent, session, and timestamp metadata
- confidence, scope, status, validity, and supersession records
- embeddings derived from memory text
- contradiction/adjudication records and review-queue entries
- optional document imports, raw source files, audits, Handoff Records, and wiki projections

Source paths and memory content can themselves be sensitive. Do not publish a live store, generated audit, debug bundle, or host configuration.

## Two-machine behavior

A MacBook and a Mac Studio have separate state unless the operator deliberately connects them. Matching Git commits or package versions do not imply matching configs or memory databases.

Supported deliberate transfer paths are integrity-checked export/import bundles and the optional authenticated remote bridge. Remote MCP lets another authorized client query one operator-hosted store; it does not replicate that store. File synchronization can also be operated externally, but the database must not be concurrently written by two hosts. Gigabrain does not silently enable cross-host sync.

## Secret handling

Credential-shaped candidate facts are rejected before optional cloud model review. For other cloud audit candidates, Gigabrain locally masks supported credential, email, IP, and home-user-path shapes and replaces the original scope with `redacted`. Recall and Handoff Record paths omit secret-risk rows. Public-release checks scan the Git inventory and actual npm package inventory, redact matched values from logs, and fail closed on unreviewed binary files.

These controls are defense in depth. They cannot detect every secret or PII format, and a sentence can be sensitive without matching any supported shape. Treat any enabled cloud review provider as a separate data processor and review its policy before use. Human review remains required before sharing memory-derived output.

## Public source boundary

The public repository is built from an explicit allowlist into a new single-commit Git history. Runtime databases, transcripts, local paths, internal plans, raw benchmark artifacts, private issue history, and the engineering repository's other refs are not copied.

The release gate checks:

1. exact repository and npm inventories
2. PII, home paths, non-documentation IPv4 literals, and credential signatures
3. unknown binaries and reviewed binary digests
4. Git author/committer metadata and single-root history
5. GitHub issues, comments, reviews, releases, branches, tags, variables, and other visible metadata

## Operator responsibilities

- enable full-disk encryption and protect the local user account
- keep config files, tokens, stores, exports, and backups out of source control
- bind local HTTP services only to interfaces you intend to expose
- put TLS and a real OAuth authorization server in front of any network-facing remote MCP deployment; keep exact issuer, audience/resource, JWKS, Host, Origin, and memory-scope allowlists
- never use remote MCP's `--allow-no-auth` development mode outside a loopback-only, disposable test
- use separate scoped tokens where different clients should see different projects
- never use the Node-only `GB_ALLOW_NO_AUTH=1` development bypass on a network-facing or persistent process
- review provider settings before enabling any cloud or remote feature
- inspect and minimize Handoff Records and bundles before sharing them
- delete or archive stale stores using your normal encrypted-backup policy

## Out of scope

Gigabrain does not guarantee that a remembered claim is true, that every contradiction is detectable, that every PII shape will be recognized, or that a compromised local account cannot read the store. It is a control and audit layer, not an identity provider, OAuth provider, TLS gateway, secrets manager, encrypted vault, or compliance certification.
