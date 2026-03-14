# Changelog

All notable changes to Gigabrain are documented in this file.

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
- Published a clean npm patch release after auditing the `0.4.0` tarball and removing Nimbus-specific example paths from the package contents

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
- Git history sanitized — single-commit squash to remove any leaked credentials from prior commits
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
