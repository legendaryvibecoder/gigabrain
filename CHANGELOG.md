# Changelog

All notable changes to Gigabrain are documented in this file.

## [0.11.0] - 2026-08-21

### Added
- One canonical on-demand memory policy shared by generated Codex and Claude project instructions.
- Regression coverage for cross-store rank fusion, exact scope isolation, read-only recall, bounded checkpoints, private-profile filtering, and MCP shutdown on stdin EOF.

### Changed
- Automatic recall injection and session preludes are off by default.
- Claude SessionEnd and PreCompact checkpoint hooks are opt-in through `--session-hook`.
- Checkpoints are grouped into one contiguous native block and deduplicated by stable `session_id`.
- Recall queries with at least four informative tokens require two token matches unless dense cosine is at least 0.65; shorter queries require one.

### Fixed
- Cross-store results now use reciprocal-rank fusion instead of comparing pool-relative raw scores.
- Explicit project scopes no longer query the personal store or expose profile rows from the project database.
- Recall no longer syncs native files, rebuilds the world model, or runs maintenance as a read side effect.
- Stdio MCP processes shut down when their client closes stdin or their parent process exits.
- Opt-in Claude lifecycle hooks now consume bounded host hook input, preserve the stable session id, and write a valid structured checkpoint.

### Security
- Technical project recall no longer admits unrelated profile/private rows by default.
- Plugin and HTTP recall exclude profile rows; explicit `project:*` scopes also exclude shared rows, and omitted HTTP scope defaults to shared-only recall.
- Generated agent policy requires provenance checks before consequential reliance and prohibits profile memory in public artifacts.

## [0.10.1] — 2026-08-17

### Added
- Append-only `checkpoint.1`, `claim.1`, and `receipt.1` control-plane records with stable IDs, session lineage, repository state, evidence references, policy versions, and database-level immutability triggers.
- Exact MCP checkpoint list/get, claim propose/review/decide, and receipt write/get tools. Checkpoint durable candidates remain non-recallable proposals until an explicit terminal decision.
- Deterministic `migrate legacy-checkpoints` dry-run/apply flow that rejects unsafe files, detects source drift, creates `legacy_untyped` episodes, and never promotes historical text.
- Read-only-by-default Streamable HTTP MCP at `/mcp` for self-hosted Claude and ChatGPT connectors, with OAuth protected-resource metadata, JWT/JWKS verification, exact memory-scope intersection, path redaction, Host/Origin controls, and rate limiting.
- Sealed 12-case control-plane engineering evaluation covering 13 property groups: authorized recall, cross-project and profile/user/shared overlay isolation, exact recent/direct-ID reads, checkpoint isolation, non-promotion, authority spoofing, query hashing, and local-path redaction.

### Changed
- Remote writes are disabled by default and separated into checkpoint, propose, commit, and receipt OAuth scopes; broad `gigabrain_remember` is never remotely exposed.
- Recall, provenance, recent, remember, checkpoint, claim, receipt, and export paths now share explicit allowed-scope enforcement. Remote reads disable the local profile/shared overlays, skip unauthorized stores, and require an explicit scope when a token carries several.
- Updated Hono, Node server, URL parsing, IP parsing, body parsing, and MCP transport dependencies; current `npm audit` reports zero known vulnerabilities.

### Fixed
- Recall hydration now preserves `source_agent` for selected non-native rows even when `source_host` is already present.
- Authenticated authority cannot be overridden by a claim-decision tool argument.
- Cross-scope checkpoint parents, checkpoint-item references, direct memory IDs, and receipts fail closed without returning protected content.
- Deduplicated promotion binds the terminal decision to the existing committed memory ID.
- Authenticated recall and control-plane reads no longer sync native files or rebuild the world model; exact-scope native twins retain the authorized scope label; SQLite connections and test helpers enforce foreign keys; legacy checkpoint IDs validate against the published schema; and only the namespaced `gigabrain_authority` JWT claim can grant decision authority.
- Native search and direct-ID provenance now share one effective-scope rule: linked registry scope wins, source-kind defaults remain explicit, and unscoped rows never inherit the caller's authorization.
- Explicit `--enable-writes=false` and `--allow-no-auth=false` values now override environment defaults instead of being treated as absent CLI flags.

### Security

- Remote MCP is read-only by default. Optional writes use separate OAuth scopes, and broad `gigabrain_remember` is not exposed remotely.
- Authenticated reads use exact scope intersection, redact local paths, and fail closed on ambiguous or unauthorized access.

### Evaluation note
- The control-plane fixture is engineering verification only, not a human-memory or state-of-the-art benchmark.
- The existing nightly performance test exceeded its 20-second local ceiling at 27-29 seconds on this branch and approximately 27.5 seconds on the untouched baseline in the same environment; the threshold was not weakened.

## [0.9.0] — 2026-08-07

### Added
- **Cross-store arbitration ledger** — belief arbitration (trust > corroboration > recency) decoupled from the world model, with semantic position clustering, sock-puppet/clock-skew defenses, bi-temporal validity, and a provenance-stamped verdict ledger inspectable by agent or human.
- **Arbitrated context injection** — recall returns the de-conflicted, source-stamped view with superseded facts suppressed; plus `gigabrain watch`, opt-in counters, and a read-only review-queue surface.
- **Hybrid recall** — FTS5 BM25 + `bge-m3` dense retrieval, RRF-fused.
- **Automatic host ingest** — host-memory sync now runs on setup and in the nightly pipeline (previously a manual-only command), with belief arbitration **at ingest time** (cross-store contradiction latency: hours → seconds).
- **Cloud-inbox** — ingest official ChatGPT/Gemini/Copilot exports from a local drop-folder, parsed locally at a manual-import trust floor. No scraping, no upload.
- **Transcript harvester** — recover facts from raw session rollouts (`~/.codex/sessions`, `~/.claude/projects`) via the local extractor, at a low `transcript` trust tier (never outranks a deliberate memory).
- **Lifecycle hooks** — `watch --install-hook --kind=session` auto-installs SessionEnd/PreCompact hooks so capture fires automatically; installed opt-out during setup.
- **Git-versioned memory wiki** — project the arbitrated belief set into a human-readable, version-controlled markdown tree; human edits round-trip back as the highest-trust source.
- **Obsidian vault reference** — read-only vault corpus surfaced in recall (`vault sync`/`status`), never treated as a belief.
- **Containment-gated legacy-drop tooling** — `migrate legacy-drop` with snapshot + dry-run.
- New MCP tools: `gigabrain_adjudications`, `gigabrain_beliefs_as_of`, `gigabrain_review_queue`.
- Answer-shaped recall for duration, completion, and certification queries, with bounded fallback to sourced working-reference evidence.
- A fail-closed public-release builder that copies only allowlisted files into a new single-commit repository.
- Runtime security tests for the optional Python console and regression tests for the PII/secret scanner.
- A packaged-runtime smoke test retained in the npm tarball, separate from the repository-only test inventory.

### Changed
- Renamed "Memory Passport" → **Handoff Record** across CLI, modules, and docs (`passport` kept as a deprecated alias).
- Owner-specific slot vocabulary moved out of the engine into `config.worldModel.customSlotRules`; the default config ships **zero** personal tokens.
- Publish is gated on full Git/npm inventory scans, GitHub metadata checks, secret scanning, dependency audits, and a clean public-mirror inventory.

### Fixed
- Path-traversal, command-injection, and prototype-pollution hardening across input handling.
- Ingest-time arbitration serialized via the append-only event log with bounded `SQLITE_BUSY` retry (cross-process safe).
- Git-wiki human-edit reconciliation: author+marker commit detection (parse-fail treated as human), 1:1 replacement pairing, and deletion tombstones — closing human-edit clobber, supersession corruption, and reconcile-deadlock paths.
- Recall provenance hydration now includes `source_agent`, preventing a projected source row from being silently skipped.
- UTC parsing now enforces TTL and `valid_until` values consistently for naive, `Z`, and legacy `+00:00Z` timestamps.
- Web-console uploads are bounded while reading; URL imports are disabled by default and require explicit enablement plus an exact host allowlist.
- Web-console list/profile pagination is bounded, invalid-token rotation shares a peer rate bucket, inaccessible memory ids return `404`, SQLite handles close on denied reads, and upload extensions are normalized to an allowlist.
- OpenClaw route registration now includes the per-memory timeline prefix; the public-mirror workflow invokes its retained test runner directly.
- Public fixtures now use only explicit fictional identities, documentation IP ranges, and synthetic device data; the private release gate injects exact blocked-identifier hashes while the public scanner ships only generic detectors and synthetic mechanism tests, keeping guessable identity hashes out of the package.
- The entity-detail query alias resolves the requested entity instead of treating `detail` as an id, repeated Node HTTP authentication failures are rate limited across every registered protected route, and source-only test names are omitted from the public mirror.
- The public package rewrites `npm test` to a retained runtime smoke test, removes repository-only scripts, and verifies the transform exactly; Python document/memory paths close SQLite handles on success and failure and direct dependencies use reproducible exact pins.
- The supported runtime is now explicit at Node `>=22.18.0`; public workflows exercise both that minimum and Node `22.23.2`, where built-in TypeScript stripping is enabled by default, so the retained plugin-runtime test can load `index.ts` without an undeclared transpiler.
- Node rate limits are keyed by endpoint and network peer, benchmark/control routes are bounded, oversized JSON returns `413`, and recall reports lexical, vector, or hybrid rank provenance truthfully.
- The optional console's recall-diagnostics proxy now accepts loopback URLs only and ignores ambient proxy settings; JSON bodies, tag collections, merge-id collections, and client-supplied ids are bounded; duplicate ids return `409`; audit triviality matching uses real word boundaries; and the public package retains the reproducible GitHub metadata auditor.
- The web console no longer loads CDN fonts or scripts: the knowledge graph uses a built-in SVG renderer, CSP is same-origin, multipart bodies are capped before parsing, and CodeQL covers Python as well as JavaScript/TypeScript.
- Wiki projection now requires its configured directory to be the actual Git top-level, preventing a nested wiki path from inheriting or committing into an unrelated parent worktree.
- The public suite now carries the nested-wiki regression; request-fragmentation and SQLite duplicate-id behavior are pinned directly; and the release scanner rejects every non-documentation IPv4 class, including multicast ranges.
- Public installs skip absent private recall-probe companions cleanly; document metadata and duplicate Content-Length headers now fail closed; and only canonical loopback/unspecified IPv4 fixtures bypass the release scanner.
- Hosted-release metadata omits an invalid static code-owner mapping, and CodeQL actions pin the verified commit behind the reviewed release instead of its annotated tag object.
- Release hardening now digest-pins the demo credential fixture, removes the production runtime-version override, separates history-author allowlisting from public content email examples, and discloses private recall-gate and complete Bandit evidence boundaries.
- Final console and CI hardening rejects Unicode authentication probes cleanly, hash-pins inline browser assets in CSP, uses stable checkbox identifiers, disables persisted checkout credentials and dependency lifecycle scripts in CI, and aligns secret-pattern thresholds across scanners.
- Nightly semantic dedupe now fingerprints each memory once per run instead of recomputing tokens and n-grams for every pair; the 1,600-row performance fixture dropped from roughly 24.5 seconds to roughly 12 seconds on the release host without changing similarity scores.
- Optional cloud audit review now rejects credential-risk rows before transport, locally masks supported PII shapes, and removes the original memory scope; Ollama remains loopback-only and networked LLM endpoints require HTTPS.
- Runtime file handling now rejects symlinked sensitive inputs and uses exclusive atomic writes for generated state; Python URL imports pin a validated public address while preserving TLS hostname verification, and document ids are stored as collision-resistant hashes.
- The optional Obsidian findings inbox is now a documented, disabled-by-default, append-only loopback HTTPS integration with normal certificate verification and optional custom-CA support; the retired broad generated-vault export is no longer exposed in the public schema.

### Security
- Node and Python dependency audits report no known vulnerabilities as of 2026-08-07.
- The repository and npm payload pass the redacting PII/secret scanner and Gitleaks with zero findings.

## [0.7.1] — 2026-05-20

### Added
- Destination audit matrix covering OpenClaw, Hermes, Codex, Claude Code/Desktop, MCP clients, Cursor/Windsurf, manual cloud imports, and Handoff Records
- v0.7.1 batchlog and release notes documenting the release path, npm-vs-pnpm decision, and remaining "OnePassword for Memory" vault-grade gaps
- MCP tool annotations so clients can distinguish read-only recall/audit/status tools from additive write tools

### Changed
- MCP server version now follows `package.json` instead of advertising a stale standalone version
- MCP source and sync-status output schemas are stricter while still allowing additive fields
- README and Memory Passport docs now link the destination audit as the current host-support status surface
- Dependencies updated to `@modelcontextprotocol/sdk@1.30.0` and `zod@4.4.3`

### Fixed
- MCP integration coverage now validates serialized JSON text fallback against `structuredContent` for every tool call, preventing output-schema drift like the prior export-brief mismatch
- Audit-maintenance test timestamps are relative to the current date, avoiding stale fixed-date failures in future release runs

## [0.7.0] — 2026-04-24

### Added
- Memory Passport launch surface via `gigabrainctl passport`, producing static Markdown/HTML/JSON reports with source inventory, readiness verdict, dedupe audit, contradiction audit, stale-memory audit, provenance gaps, secret-risk flags, and handoff briefs
- Host-specific handoff briefs for `AGENTS.md`, `CLAUDE.md`, ChatGPT, Claude.ai, Gemini, and Microsoft Copilot manual paste/import
- `docs/memory-passport.md` and `npm run demo:passport` for the launch demo flow
- Launch kit with market positioning, pilot offer, X launch copy, and a static landing page under `site/`
- Cross-agent host memory sync via `gigabrainctl sync-hosts`, with read-only local adapters for Codex memories, Claude Code memory folders, OpenClaw native memory, and Cursor/Windsurf rules or memories
- Hermes Agent MCP setup via `gigabrain-hermes-setup`, plus read-only `sync-hosts --host hermes` support for `~/.hermes/memories`
- Legacy OpenClaw/Gigabrain registry imports via `gigabrainctl import-openclaw`, preserving ids, scopes, statuses, confidence, timestamps, pinned markers, provenance links, and evidence snippets where available
- Explicit manual cloud import flow for ChatGPT, Claude.ai, Gemini, and Microsoft Copilot exports, tagged as `manual_import` with `bidirectional_disallowed` sync policy
- Additive source metadata on current and legacy memory rows: `source_host`, `source_kind`, and `sync_policy`
- Source-link tracking for deduped host memories so the same memory can keep Codex, Claude, and manual import provenance at once
- New MCP tools: `gigabrain_sources`, `gigabrain_sync_status`, and `gigabrain_export_brief`
- `docs/cross-memory-pivot-2026-04.md` explaining why Gigabrain complements native product memories rather than replacing them

### Changed
- README and package metadata now position Gigabrain as a local-first Memory Passport/control plane for agents, with the cross-memory bus as the internal architecture
- `gigabrainctl sync-hosts` now reports compact summary counts, source warnings, and grouped host readiness diagnostics
- Published package contents now include the full `docs/` and `release-notes/` directories
- Passport `--limit` now applies consistently across stale, provenance-gap, and secret-risk audit sections

### Security
- Updated transitive MCP HTTP dependencies, resolving current `fast-uri`, `hono`, `ip-address`, and `express-rate-limit` npm audit findings
- Updated `memory_api`'s pinned `lxml` dependency to `6.1.0`
- Handoff/export briefs now omit secret-risk memory rows entirely, including already-redacted markers such as `API_KEY=[REDACTED_SECRET]`

## [0.6.1] — 2026-03-18

### Changed
- Fresh standalone helper generation now uses a durable package-spec fallback instead of embedding ephemeral `~/.npm/_npx/...` cache paths
- Codex and Claude setup flows now fail closed on malformed standalone configs and surface clearer recovery guidance
- Scoped world-model/entity access now stays aligned across orchestrator, recall, and memory-API relation surfaces

### Fixed
- Legacy `memory_native_chunks` stores are now migrated before scope-based indexes are created, preventing `no such column: scope` startup failures on older OpenClaw registries
- `gigabrainctl doctor --config <missing>` now exits with an explicit config-path error instead of dropping into a raw SQLite failure
- `gigabrain-mcp` now delays MCP/service import until after config resolution so fresh helper-based launches do not fail prematurely in non-installed repos
- Multi-entity reranking now uses real entity signals instead of ineffective opaque-id text matching
- Partial-cache semantic rerank no longer demotes uncached rows when embeddings are unavailable
- Memory API relation reads now filter related rows by the same scope/access rules as their anchor memories

## [0.6.0] — 2026-03-18

### Added
- In-process recall evaluation with canonical aggregate metrics via `lib/core/eval-harness.js`, `scripts/eval-runner.js`, `scripts/eval-compare.js`, and nightly `memory_eval_history` persistence
- Optional semantic reranking infrastructure via `embedding-service.js` and additive `memory_embeddings` storage, with graceful lexical fallback when Ollama is unavailable
- World-model relationship graph storage in `memory_entity_relationships`, plus `/gb/evolution` and `/gb/relationships` HTTP endpoints
- New standalone MCP tools: `gigabrain_entity`, `gigabrain_contradictions`, and `gigabrain_relationships`
- Regression coverage for nightly eval artifacts, semantic dedupe timeout resolution, semantic rerank behavior, eval tooling, MCP world-model tools, and world-model API surfaces

### Changed
- The recall stack now standardizes on machine-safe aggregate keys such as `precision_at_3`, `mrr`, `hit_rate`, `avg_injection_tokens`, `latency_median_ms`, and `latency_p95_ms`
- Recall ranking now supports BM25-based lexical scoring, adaptive budget profiles, confidence labeling, and config-gated semantic reranking on top-N candidates
- The orchestrator now supports multi-entity routing, fallback-chain tracking, and richer confidence signals for injected memory context
- Nightly maintenance now records recall latency summaries, graph node/edge counts, embedding build results, and persisted eval artifacts in the execution report
- Entity, contradiction, relationship, evolution, vault, HTTP, and MCP surfaces now share normalized world-model helper outputs instead of reconstructing divergent schemas per surface

### Fixed
- Capture parsing now strips model thinking blocks before `parseMemoryNotes`, preventing review-queue buildup from contaminated extraction output
- Semantic dedupe timeout resolution now archives only the stored loser for still-borderline pairs and preserves auditable queue metadata instead of acting on an arbitrary queued side
- Open-loop auto-resolution now only considers newer, non-source memories with real entity linkage and sufficient overlap/confidence
- Standalone contradictions, relationships, and entity evolution surfaces now use the actual world-model schema fields (`loop_id`, `related_entity_id`, `source_memory_id`, `payload.claim_slot`, `payload.claim_value`)
- Eval comparison no longer misclassifies tiny runtime jitter in latency metrics as a quality regression
- OpenClaw hook injection now uses `appendSystemContext`, merges `ctx` correctly, and keeps scope derivation deterministic instead of silently collapsing to `shared`
- Empty-store recall now still emits a minimal `<gigabrain-context>` block with `bootstrap_mode: true`, so fresh installs can bootstrap memory instead of deadlocking on the first session
- Reported OpenClaw setup and routing regressions are resolved in the stable branch
- Setup now reports OpenClaw gateway restart failures honestly instead of claiming success after a failed restart
- Generated Codex and Claude helper scripts no longer depend on stale setup-time absolute install paths; they resolve Gigabrain dynamically from the current repo or host environment
- Claude Desktop bundles now launch through a bundled shell wrapper so Desktop does not rely on Finder resolving `node` in PATH
- CLI and MCP SQLite entrypoints now fail fast with a friendly Node `>=22.18.0` runtime error instead of raw `node:sqlite` import crashes
- Review-queue writes now serialize append-plus-retention under a queue lock, preventing lost updates during concurrent writes
- HTTP rate-limit bookkeeping now prunes empty/stale endpoint buckets instead of growing without bound
- Maintenance now records FTS rebuild failures explicitly in nightly artifacts instead of swallowing them silently
- Audit/review idempotency now includes an effective config fingerprint so changed thresholds/options are not skipped under the same review version

## [0.5.3] — 2026-03-13

### Added
- First-class Claude Code standalone setup via `gigabrain-claude-setup`, including managed `CLAUDE.md` memory instructions, project `.mcp.json` Gigabrain MCP wiring, and repo-local `.claude/` helper scripts
- Claude Desktop local extension bundle packaging via `npm run claude:desktop:bundle` for local testing and `npm run claude:desktop:bundle:release` for portable release assets, both producing a `.dxt` artifact that wraps the same Gigabrain stdio MCP server used by Claude Code
- Packaged-install smoke tests for the Codex and Claude standalone setup flows
- Release-only validation scripts for live Codex CLI registration, live OpenClaw install/setup, and deep recall evaluation
- README guidance for Claude native memory, Claude Desktop Cowork compatibility, host-by-host setup ownership, and a simpler quickstart-first install flow

### Changed
- Standalone setup/file-generation helpers are now shared between Codex and Claude flows so both clients reuse the same store model, project scope derivation, and MCP server entrypoint
- Fresh standalone installs now use the host-neutral shared store under `~/.gigabrain`, while legacy `~/.codex/gigabrain` installs remain supported in place for `0.5.3`
- Claude Desktop install docs now follow the current custom extension flow, including explicit import into the Desktop app and confirmation of the resolved shared standalone config path
- Published package contents now keep the recall eval runner and summary docs without shipping bulky generated eval JSON by default
- Top-level docs now frame Gigabrain as a local-first memory layer with host integrations, plus explicit verify/doctor guidance for OpenClaw, Codex, and Claude

### Fixed
- OpenClaw onboarding now uses the current plugin discovery flow based on `openclaw plugins install`, and the setup wizard no longer writes the stale `plugins.entries.gigabrain.path` key
- The OpenClaw setup wizard now activates `plugins.slots.memory = "gigabrain"` so fresh installs actually select Gigabrain as the active memory provider
- Claude Desktop release bundles no longer need a builder-specific absolute config path embedded in the manifest; runtime config path handling now expands portable home-relative defaults safely
- Recall routing now better handles identity and preference prompts, noisy metadata-heavy queries, month-only temporal prompts, and near-duplicate recall rows
- Orchestrated entity-brief routes now keep a truthful ranking-mode contract even when the answer is backed only by world-model context

## [0.5.2] — 2026-03-13

### Fixed
- Plugin startup no longer fails fast on transient SQLite contention: the OpenClaw entrypoint now uses the shared SQLite opener with `busy_timeout`, preventing intermittent `database is locked` failures during register/startup
- `gigabrainctl nightly` now protects itself with an output-scoped lock, clears stale dead-owner locks, skips cleanly when another nightly run is already active, and verifies its execution artifact plus usage log before reporting success

### Added
- Integration coverage for the nightly CLI success, active-lock skip, and stale-lock recovery paths

## [0.5.1] — 2026-03-13

### Added
- Codex App-first standalone support with a stable SDK-based MCP server and explicit tools for `gigabrain_recall`, `gigabrain_remember`, `gigabrain_checkpoint`, `gigabrain_provenance`, `gigabrain_recent`, and `gigabrain_doctor`
- Native-only Codex session checkpoint capture that writes task-end summaries into the shared `~/.codex/gigabrain/memory/YYYY-MM-DD.md` store by default
- Codex setup outputs now include a manual checkpoint helper action alongside install, verify, and maintenance helpers
- Codex-oriented tests for checkpoint capture, setup outputs, and MCP integration

### Changed
- Codex standalone now defaults to a shared repo store under `~/.codex/gigabrain`, a shared personal user store under `~/.codex/gigabrain/profile`, and a repo-derived default project scope so continuity stays separated by workspace
- Codex standalone docs now describe `target=user` vs `target=project`, the Codex-aware verify path, migration of older broken configs, and manual consolidation instead of hidden background logging
- Stable project-identity facts such as repo codenames now remain recallable as `durable_project` memories in the standalone Codex path

### Fixed
- Native-memory provenance lookups now resolve `native:*` ids returned by Codex recall results
- Codex MCP startup now uses the official MCP SDK transport instead of the earlier hand-rolled server
- Codex setup now bootstraps both project and user stores, migrates legacy empty-user-store configs on rerun, and exposes both paths in its setup summary
- Codex doctor paths now validate both standalone stores honestly, including hard failures for explicit `target=user` checks when the personal store is not configured
- The test runner now honors `--filter`, so Codex install and migration smokes can run directly in CI and release validation
- Published package scripts and release metadata are aligned for the standalone Codex install path

## [0.5.0] — 2026-03-11

### Added
- World-model projection layer with additive SQLite tables for `memory_entities`, `memory_entity_aliases`, `memory_beliefs`, `memory_episodes`, `memory_open_loops`, and `memory_syntheses`
- Recall orchestrator that classifies queries into strategies such as `quick_context`, `entity_brief`, `timeline_brief`, `relationship_brief`, and `verification_lookup`
- New HTTP APIs for entities, beliefs, episodes, open loops, contradictions, and rich recall explain output
- New CLI workflows: `world rebuild`, `orchestrator explain`, `synthesis build/list`, `briefing`, and `review contradictions|open-loops`
- Obsidian Surface 2.0 additions: entity pages, people/projects/open-loop/contradiction/current-belief/stale-belief views, review notes, and generated session briefings
- World-model and orchestrator test coverage, plus API regression coverage for the new routes

### Changed
- Nightly maintenance now refreshes the world model and synthesis layer after native sync/promotion and dedupe stages
- Startup and HTTP request paths automatically warm the world-model layer when it is empty but active memories exist
- Vault summaries and home note now expose entities and synthesis-driven memory-OS concepts in addition to raw nodes
- Config and plugin schema gained additive `orchestrator`, `worldModel`, `synthesis`, `control`, and `surface` sections while remaining backward-compatible with `0.4.x`

### Fixed
- Nightly maintenance now rebuilds FTS5 and runs `graph_build` after `vault_build`, keeping lexical recall and graph artifacts aligned with the latest vault state
- Fresh-workspace nightly runs no longer fail when `memory_relations` has not been created yet; graph generation degrades cleanly to an empty graph
- Temporal month recall now prefers source-dated memories over generic rows whose `updated_at` merely falls inside the same month
- Person and world-model projections now suppress common metadata noise such as `archive`, `contact`, `content`, `date`, `link`, `name`, and `status`
- Gigabrain now registers as a `memory` plugin so OpenClaw can assign it to the memory slot without persistent doctor warnings

## [0.4.3] — 2026-03-08

### Fixed
- Recall injection no longer exposes internal provenance such as `src=...`, memory ids, or source paths in the hidden Gigabrain context block
- Native recall no longer re-indexes persisted recall artifacts like `<gigabrain-context>`, `query:`, `Source:`, or transcript-style `user:` / `assistant:` lines from session notes
- Older memories containing relative wording like `today` / `heute` are now marked with their recorded date in recall injection so stale plans are not presented as if they refer to the current day

### Changed
- README now clarifies the recall hygiene behavior and notes that OpenClaw's separate `memory_search` tool controls its own visible citations via `memory.citations`

## [0.4.2] — 2026-03-08

### Added
- `npm run setup` is now shipped in the published package, alongside `vault:report`
- Setup integration test coverage for the first-run wizard, vault bootstrap, and AGENTS refresh flow
- Release notes document for the `0.4` rollout

### Changed
- The setup wizard now enables the Obsidian surface by default, builds the first vault, and seeds hybrid-memory defaults when missing
- Installation and onboarding docs now explain that Obsidian is recommended for the `v0.4` memory surface, what an initially sparse vault means, and how `vault pull` fits into the local workflow
- Web console docs now frame the UI as the operational companion to the Obsidian surface

## [0.4.1] — 2026-03-07

### Fixed
- Published a clean npm patch release after auditing the `0.4.0` tarball and removing machine-specific example paths from the package contents

### Changed
- GitHub `main`, npm `latest`, and release metadata are aligned on the scrubbed `0.4.1` package

## [0.4.0] — 2026-03-07

### Added
- Obsidian Memory Surface with structured vault export under `00 Home`, `10 Native`, `20 Nodes/active`, `30 Views`, and `40 Reports`
- `vault build`, `vault doctor`, `vault report`, and `vault pull` workflows for building and syncing the surface to another machine
- Shared surface summary model used by both Obsidian and the FastAPI web console
- Hybrid memory model with explicit remember intent, native-to-registry promotion, and provenance fields like `source_layer`, `source_path`, and `source_line`
- Task-specific local Qwen 3.5 profiles for memory review and other structured LLM work

### Changed
- Explicit remember/save requests can now project to native markdown and structured registry memory together
- Nightly maintenance now ends with `vault_build` and emits surface artifacts such as `memory-surface-summary.json`
- Web console gained a surface landing view with freshness, native-vs-registry counts, review queue, and recent archive summaries
- Setup guidance now centers the Obsidian surface as the recommended `v0.4` browse experience while keeping the runtime workspace as the source of truth

### Fixed
- Production hardening for the new surface and hybrid memory rollout, including dry-run artifact isolation, vault health checks, and manual-folder preservation
- Remember-intent fallback now queues review instead of silently dropping explicit save requests when the internal tag is missing
- Shared-scope durable remembers no longer leak into `MEMORY.md`

## [0.3.0] — 2026-03-05

### Security
- Timing-safe token comparison (`crypto.timingSafeEqual` / `hmac.compare_digest`)
- XML-escape query parameters in recall context to prevent injection
- Bump `lxml-html-clean` 0.4.1 → 0.4.4 (CVE fix)
- Remove stored auth token from `localStorage` on authentication failure
- Auth startup fail-closed: gateway refuses to start without a valid token (unless `GB_ALLOW_NO_AUTH=1` for local dev)
- Timeline endpoint auth test added to CI
- Git history sanitized — single-commit squash keeps legacy development history out of public releases
- Remove legacy `CLAWDBOT_WORKSPACE` env var and stale legacy references

### Added
- `SECURITY.md` with responsible disclosure instructions via GitHub Security Advisories

## [0.3.0-rc1] — 2026-02-26

### Added
- Graph builder (`graph-build.js`) — entity co-occurrence graph with label propagation clustering
- Vault export (`vault-export.js`) — registry to markdown vault files for offline browsing
- Evaluation harness (`harness-lab-run.js`) with recall benchmark and A/B comparison tooling
- Global exception handler in memory_api to prevent stack trace leakage
- Path traversal guard on document delete endpoint
- Prototype pollution guard in config `deepMerge`

### Changed
- Default paths now use `$HOME/.openclaw/gigabrain/` instead of hardcoded user directories
- Pinned `fastapi==0.133.1` in memory_api requirements
- Removed legacy `clawdbot` config fallback from config loader
- Depersonalized all test fixtures and eval cases for public release

### Security
- Token auth is fail-closed on all HTTP endpoints
- Timing-safe token comparison (`crypto.timingSafeEqual` / `hmac.compare_digest`)
- SSRF protection in web console URL fetcher
- Path traversal validation on document operations
- `.gitignore` covers `*.db`, `*.sqlite`, `*.pem`, `*.key`, credentials

### Removed
- Legacy `clawdbot.plugin.json`
- Internal operational docs (`OPS_IMESSAGE.md`, `OPENCLAW_ALIGNMENT.md`)
- Bundled `data/memory.db` placeholder

## [0.2.0] — 2026-02-15

### Added
- Native sync — indexes `MEMORY.md` and daily notes alongside the SQLite registry
- Person service — entity mention tracking for person-aware recall ordering
- Spark bridge contract routes for advisory pull/ack and suggestion ingest
- Nightly pipeline (`gigabrainctl nightly`) — maintain + audit + vault-export + graph-build
- Quality gate — junk filter with 7 pattern categories, confidence thresholds, LLM review
- Web console (`memory_api`) — FastAPI dashboard for browsing, editing, dedup review
- Session tracking with per-agent scoping
- `migrate-v3.js` schema migration with rollback support

### Changed
- Recall mode supports `hybrid`, `personal_core`, and `project_context` strategies
- Class budgets (core/situational/decisions) are now configurable and must sum to 1.0
- Deduplication split into exact + semantic with separate thresholds

## [0.1.0] — 2026-01-20

### Added
- Initial capture and recall pipeline
- SQLite registry with event-sourced storage (`memory_events` + `memory_current`)
- Exact deduplication
- `<memory_note>` XML tag protocol for agent-driven capture
- Token-authenticated HTTP endpoints on OpenClaw gateway
- Config schema via `openclaw.plugin.json`
- Test suite (unit, integration, regression, performance)
