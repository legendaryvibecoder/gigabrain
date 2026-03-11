# Changelog

All notable changes to Gigabrain are documented in this file.

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
- Temporal month recall now prefers source-dated memories over generic rows whose `updated_at` merely falls inside the same month
- Person and world-model projections now suppress common metadata noise such as `archive`, `contact`, `content`, `date`, `link`, `name`, and `status`

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
