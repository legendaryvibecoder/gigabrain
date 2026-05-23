# Gigabrain

<p align="center">
  <strong>Local-first memory control plane for agents.</strong>
</p>

<p align="center">
  <a href="https://github.com/legendaryvibecoder/gigabrain/releases"><img src="https://img.shields.io/github/v/release/legendaryvibecoder/gigabrain?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="https://www.npmjs.com/package/@legendaryvibecoder/gigabrain"><img src="https://img.shields.io/npm/v/@legendaryvibecoder/gigabrain?style=for-the-badge" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://github.com/legendaryvibecoder/gigabrain/stargazers"><img src="https://img.shields.io/github/stars/legendaryvibecoder/gigabrain?style=for-the-badge" alt="GitHub Stars"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=for-the-badge" alt="Node >=22">
</p>

<p align="center">
  <a href="docs/configuration.md">Configuration</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="SECURITY.md">Security</a> ·
  <a href="https://github.com/legendaryvibecoder/gigabrain/discussions">Discussions</a>
</p>

---

**Gigabrain** is the local-first Memory Passport and control plane for AI agents. It gives you one inspectable place to inventory, audit, deduplicate, and safely hand off memory across [OpenClaw](https://openclaw.ai), Codex App/CLI, Claude Code/Desktop, Hermes-style MCP/HTTP bridges, Cursor/Windsurf, and explicit manual imports from cloud products.

The product face is **Memory Passport + Auditor + Handoff Layer**. The cross-memory bus is the architecture underneath: SQLite-backed recall, deterministic dedupe/audit flows, host-memory adapters, native markdown sync, world model, Obsidian surface, and an optional web console for memory operations.

Gigabrain does not replace native memories. It connects, checks, deduplicates, exports, and audits them where the host exposes local files or the user provides an explicit export. Closed cloud memories such as ChatGPT, Claude.ai, Gemini, and Microsoft Copilot are manual import/export flows only.

## Supported clients

| Host surface | Install | What Gigabrain owns |
| --- | --- | --- |
| **OpenClaw** | `openclaw plugins install` | Registry, native sync, recall orchestration, audit/nightly, memory-slot provider |
| **Codex App / CLI** | `npm install` + setup | Shared project/user memory store, MCP tools, checkpoints, maintenance |
| **Claude Code** | `npm install` + setup | Shared project/user memory store, MCP tools, managed `.mcp.json` wiring |
| **Claude Desktop** | `claude:desktop:bundle` | Same MCP-backed memory store and tools as Claude Code |
| **Hermes Agent** | `gigabrain-hermes-setup` | MCP tools plus read-only sync for Hermes built-in memory files |
| **Local host memories** | `gigabrainctl sync-hosts` | Read-only local adapters for Codex memories, Claude Code memory, Hermes memory files, Cursor/Windsurf rules, plus explicit manual imports |
| **Memory Passport** | `gigabrainctl passport` | Static Markdown/HTML audit report, readiness verdict, and safe AGENTS.md, CLAUDE.md, ChatGPT, Claude.ai, Gemini, and Copilot handoff briefs |

## Quickstart

### I use multiple agents

```bash
npm install @legendaryvibecoder/gigabrain
npx gigabrain-codex-setup --project-root /path/to/repo
npx gigabrain-claude-setup --project-root /path/to/repo
npx gigabrain-hermes-setup --config ~/.gigabrain/config.json --workspace-root /path/to/repo
npx gigabrainctl sync-hosts --config ~/.gigabrain/config.json --host codex,claude_code,hermes,cursor,windsurf
npx gigabrainctl passport --config ~/.gigabrain/config.json --output-dir ./gigabrain-passport
```

This gives Codex, Claude, and Hermes the same local project/user memory store, indexes visible local host memories read-only, then writes a static Memory Passport report plus handoff briefs under `./gigabrain-passport/`. See the [Memory Passport guide](docs/memory-passport.md), [Codex setup](docs/setup-codex.md#using-gigabrain-across-multiple-agents), [Claude setup](docs/setup-claude.md#using-gigabrain-across-multiple-agents), [Hermes setup](docs/setup-hermes.md), the [Nimbus Memory Bridge Contract](docs/nimbus-memory-bridge.md), the [destination audit](docs/audits/destination-audit-2026-05.md), and the [cross-memory pivot](docs/cross-memory-pivot-2026-04.md).

Manual cloud imports must be explicit:

```bash
npx gigabrainctl sync-hosts --config ~/.gigabrain/config.json \
  --manual-import ./chatgpt-memory-export.md \
  --manual-source-host chatgpt_manual
npx gigabrainctl passport --config ~/.gigabrain/config.json --output-dir ./gigabrain-passport
```

### Codex only

```bash
npm install @legendaryvibecoder/gigabrain
npx gigabrain-codex-setup --project-root /path/to/repo
.codex/actions/verify-gigabrain.sh
```

> [Full setup guide](docs/setup-codex.md)

### Claude / OpenClaw

```bash
npm install @legendaryvibecoder/gigabrain
npx gigabrain-claude-setup --project-root /path/to/repo
.claude/actions/verify-gigabrain.sh
```

For OpenClaw:

```bash
openclaw plugins install @legendaryvibecoder/gigabrain
cd ~/.openclaw/extensions/gigabrain && npm run setup -- --workspace /path/to/workspace
npx gigabrainctl doctor --config ~/.openclaw/openclaw.json
```

> Full guides: [Claude](docs/setup-claude.md), [OpenClaw](docs/setup-openclaw.md)

### Hermes / Nimbus migration

```bash
npm install @legendaryvibecoder/gigabrain
npx gigabrain-hermes-setup --config ~/.gigabrain/config.json --workspace-root /path/to/workspace --install --test
hermes gateway restart
```

Import a legacy Nimbus/OpenClaw backup with provenance:

```bash
npx gigabrainctl import-openclaw \
  --config ~/.gigabrain/config.json \
  --registry /path/to/backup/clawd/memory/registry.sqlite \
  --source-label nimbus-backup \
  --dry-run
```

> Full guide: [Hermes setup](docs/setup-hermes.md)
> Nimbus runtime policy: [Nimbus Memory Bridge Contract](docs/nimbus-memory-bridge.md)

Upgrading? See the [upgrade guide](docs/upgrading.md).

## How it works

```
Conversation (OpenClaw / Codex / Claude Code / Claude Desktop)
               │
               ▼
┌──────────────────────────────────┐
│           Gigabrain              │
│   (memory layer + MCP server)   │
├──────────────────────────────────┤
│  Capture ─► Policy ─► Registry  │
│  Recall  ◄─ Orchestrator        │
│  Host Sync ◄─ Codex/Claude/etc. │
│  Native Sync ◄─► MEMORY.md      │
│  World Model (entities/beliefs) │
│  Vault Mirror ─► Obsidian       │
└──────────────┬───────────────────┘
               │
         SQLite + FTS5
```

## Highlights

- **Capture** — hybrid model: explicit remember intent writes durable memory, Codex checkpoints write episodic session logs
- **Recall** — orchestrator chooses between quick context, entity briefs, timeline briefs, and verification-oriented recall automatically
- **MCP tools** — `gigabrain_recall`, `gigabrain_remember`, `gigabrain_checkpoint`, `gigabrain_provenance`, `gigabrain_recent`, `gigabrain_sources`, `gigabrain_sync_status`, `gigabrain_export_brief`, `gigabrain_doctor`, `gigabrain_entity`, `gigabrain_contradictions`, `gigabrain_relationships`
- **Memory Passport** — static Markdown/HTML source inventory, readiness verdict, dedupe audit, contradiction audit, stale-memory audit, provenance gaps, secret-risk flags, and safe handoff briefs that omit secret-risk rows entirely
- **Host memory bus** — read-only local sync for Codex, Claude Code, Cursor/Windsurf, OpenClaw native memory, and bridge-friendly Hermes integrations
- **Dedupe** — exact + hybrid semantic deduplication with type-aware thresholds
- **Native sync** — indexes `MEMORY.md` and daily notes alongside the registry for unified recall
- **World model** — entities, beliefs, episodes, open loops, contradictions, and syntheses
- **Obsidian surface** — structured vault with native files, entity pages, briefings, and views
- **Quality gate** — junk filters, plausibility heuristics, and LLM second opinion
- **Audit** — nightly maintenance with snapshots, archive reports, and quality scoring
- **Eval** — in-process recall eval harness, nightly quality history, and latency summaries
- **Web console** — optional FastAPI dashboard for browsing and managing memories
- **Person service** — entity mention tracking for person-aware retrieval ordering

## Key subsystems

| Subsystem | Description | Docs |
|-----------|-------------|------|
| Memory Passport | Static local audit report and handoff briefs | [docs/memory-passport.md](docs/memory-passport.md) |
| Destination audit | Host-by-host integration status and gaps | [docs/audits/destination-audit-2026-05.md](docs/audits/destination-audit-2026-05.md) |
| Launch kit | Positioning, pilot offer, X posts, and static marketing site | [docs/launch/gtm-brief.md](docs/launch/gtm-brief.md) |
| Sharing model | Multi-host sharing modes and scope rules | [docs/sharing.md](docs/sharing.md) |
| TweetClaw source memory | Public X/Twitter signal workflow for OpenClaw agents | [docs/tweetclaw-source-memory.md](docs/tweetclaw-source-memory.md) |
| Cross-memory pivot | Why Gigabrain still matters when native memories exist | [docs/cross-memory-pivot-2026-04.md](docs/cross-memory-pivot-2026-04.md) |
| Configuration | Full config reference (runtime, capture, recall, dedupe, LLM, vault, quality) | [docs/configuration.md](docs/configuration.md) |
| Memory protocol | Capture tags, agent instructions, AGENTS.md | [docs/memory-protocol.md](docs/memory-protocol.md) |
| Recall pipeline | 11-step orchestrated recall with strategy selection | [docs/recall.md](docs/recall.md) |
| Obsidian surface | Vault structure, setup, pull workflow | [docs/obsidian.md](docs/obsidian.md) |
| Nightly maintenance | Pipeline steps, artifacts, scheduling | [docs/maintenance.md](docs/maintenance.md) |

## Prerequisites

- **Node.js** >= 22.x (uses `node:sqlite` experimental API)
- **OpenClaw** >= 2026.2.15 (only for the plugin path)
- **Python** >= 3.10 (only for the optional web console)
- **Ollama** (optional, for local LLM review and semantic search)
- **Obsidian** (recommended for the memory surface)

## CLI

```bash
npx gigabrainctl nightly                          # Full nightly pipeline
npx gigabrainctl maintain                         # Maintenance only
npx gigabrainctl audit --mode shadow|apply        # Quality audit
npx gigabrainctl inventory                        # Memory stats
npx gigabrainctl doctor                           # Health check
npx gigabrainctl world rebuild                    # Rebuild world model
npx gigabrainctl orchestrator explain --query "…" # Explain recall strategy
npx gigabrainctl synthesis build                  # Rebuild synthesis
npx gigabrainctl review contradictions            # Inspect contradictions
npx gigabrainctl review open-loops                # Inspect open loops
npx gigabrainctl sync-hosts --host codex,claude_code # Index local host memories
npx gigabrainctl sync-hosts sources               # Show source counts/freshness
npx gigabrainctl sync-hosts export-brief          # Safe AGENTS.md/CLAUDE.md brief
npx gigabrainctl passport --output-dir ./passport # Build Memory Passport + handoffs
npx gigabrainctl vault build                      # Build Obsidian surface
npx gigabrainctl vault doctor                     # Vault health check
npx gigabrainctl vault report                     # Surface summary
npx gigabrainctl vault pull --host … --target …   # Pull vault to laptop
```

All commands accept `--config <path>` and are also available as `npm run` scripts.

## HTTP endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/gb/health` | No | Health check |
| `POST` | `/gb/recall` | Token | Memory recall for a query |
| `POST` | `/gb/suggestions` | Token | Structured suggestion ingest |
| `POST` | `/gb/bench/recall` | Token | Recall benchmark endpoint |
| `GET` | `/gb/memory/:id/timeline` | Token | Event timeline for a memory |
| `GET` | `/gb/evolution` | Token | Entity evolution timeline by claim slot |
| `GET` | `/gb/relationships` | Token | Relationship graph with counterpart metadata |

Auth uses the `X-GB-Token` header. Fail-closed: no token configured = all requests rejected.

## Web console

Optional FastAPI dashboard for browsing and managing memories. See [`memory_api/README.md`](memory_api/README.md).

## Testing

```bash
npm test                    # All tests
npm run test:unit           # Unit tests only
npm run test:integration    # Integration tests
npm run test:regression     # Regression tests
npm run test:performance    # Performance tests
npm run test:release-live   # Live Codex/OpenClaw smoke
npm run audit:high          # npm audit gate for release
npm run pack:dry-run        # Verify published package contents
npm run eval:deep-recall    # Recall-routing evaluation
```

## Benchmarking

```bash
node bench/memorybench/run.js \
  --base-url http://127.0.0.1:18789 \
  --token "$GB_UI_TOKEN" \
  --cases eval/cases.jsonl \
  --topk 8 --runs 3
```

Results written to `bench/memorybench/data/runs/`.

## Project structure

```
gigabrain/
├── index.ts                    # Plugin entry point (OpenClaw extension)
├── openclaw.plugin.json        # Config schema definition
├── package.json
│
├── lib/core/                   # Core services
│   ├── config.js               # Config validation and normalization
│   ├── capture-service.js      # Extraction, dedup, registry upsert
│   ├── recall-service.js       # Search, filter, inject pipeline
│   ├── event-store.js          # Append-only event log
│   ├── projection-store.js     # Materialized current-state view
│   ├── native-sync.js          # MEMORY.md + daily notes indexer
│   ├── person-service.js       # Entity mention graph
│   ├── policy.js               # Junk filter, plausibility, retention rules
│   ├── audit-service.js        # Quality scoring, review, restore/report
│   ├── maintenance-service.js  # Nightly pipeline, snapshots, artifacts
│   ├── llm-router.js           # LLM provider abstraction + task profiles
│   ├── vault-mirror.js         # Obsidian surface builder + pull workflow
│   ├── http-routes.js          # Gateway HTTP endpoints
│   ├── review-queue.js         # Capture and audit review queue
│   └── metrics.js              # Telemetry counters
│
├── scripts/                    # CLI tools
│   ├── gigabrainctl.js         # Main control plane
│   ├── migrate-v3.js           # Schema migration
│   ├── harmonize-memory.js     # Memory harmonization
│   └── vault-export.js         # Direct vault surface build
│
├── docs/                       # Detailed documentation
├── memory_api/                 # Optional web console (FastAPI)
├── tests/                      # Test suite
├── bench/memorybench/          # Benchmark harness
└── eval/                       # Evaluation cases
```

## Security

- All HTTP endpoints require token auth (`X-GB-Token`)
- Auth is fail-closed: no token = all requests rejected
- Web console escapes all user content (XSS prevention)
- `memory_api` binds to `127.0.0.1` only
- Dependencies audited with `pip-audit` and `npm audit`

Do not open public issues for vulnerabilities. Use the private reporting flow in [SECURITY.md](SECURITY.md).

## Contributing

External contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.

- Issues for concrete bugs or scoped feature requests
- Discussions for design questions, product ideas, or usage help
- Avoid posting secrets, private paths, or runtime artifacts

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=legendaryvibecoder/gigabrain&type=date)](https://star-history.com/#legendaryvibecoder/gigabrain)

## Release notes

- [`v0.7.0`](release-notes/v0.7.0-cross-memory-pivot.md) · [`v0.6.1`](release-notes/v0.6.1.md) · [`v0.6.0`](release-notes/v0.6.0.md) · [`v0.5.3`](release-notes/v0.5.3.md) · [Changelog](CHANGELOG.md)

## License

MIT License. See [LICENSE](LICENSE) for details.
