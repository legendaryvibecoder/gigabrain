# Gigabrain

<p align="center">
  <strong>Local-first memory for AI agents.</strong>
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

**Gigabrain** is a local-first memory stack for [OpenClaw](https://openclaw.ai) agents, Codex App, Codex CLI, Claude Code, and Claude Desktop. It converts conversations and native notes into durable, queryable memory, then injects the right context before each prompt so agents stay consistent across sessions.

Built for production use: SQLite-backed recall, deterministic dedupe/audit flows, native markdown sync, world model, Obsidian surface, and an optional web console for memory operations.

## Supported clients

| Host surface | Install | What Gigabrain owns |
| --- | --- | --- |
| **OpenClaw** | `openclaw plugins install` | Registry, native sync, recall orchestration, audit/nightly, memory-slot provider |
| **Codex App / CLI** | `npm install` + setup | Shared project/user memory store, MCP tools, checkpoints, maintenance |
| **Claude Code** | `npm install` + setup | Shared project/user memory store, MCP tools, managed `.mcp.json` wiring |
| **Claude Desktop** | `claude:desktop:bundle` | Same MCP-backed memory store and tools as Claude Code |

## Quickstart

### OpenClaw

```bash
openclaw plugins install @legendaryvibecoder/gigabrain
cd ~/.openclaw/extensions/gigabrain && npm run setup -- --workspace /path/to/workspace
npx gigabrainctl doctor --config ~/.openclaw/openclaw.json
```

> [Full setup guide](docs/setup-openclaw.md)

### Codex App / Codex CLI

```bash
npm install @legendaryvibecoder/gigabrain
npx gigabrain-codex-setup --project-root /path/to/repo
.codex/actions/verify-gigabrain.sh
```

> [Full setup guide](docs/setup-codex.md)

### Claude Code / Claude Desktop

```bash
npm install @legendaryvibecoder/gigabrain
npx gigabrain-claude-setup --project-root /path/to/repo
.claude/actions/verify-gigabrain.sh
```

> [Full setup guide](docs/setup-claude.md)

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
- **MCP tools** — `gigabrain_recall`, `gigabrain_remember`, `gigabrain_checkpoint`, `gigabrain_provenance`, `gigabrain_recent`, `gigabrain_doctor`, `gigabrain_entity`, `gigabrain_contradictions`, `gigabrain_relationships`
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
| Sharing model | Multi-host sharing modes and scope rules | [docs/sharing.md](docs/sharing.md) |
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
- **Obsidian** (recommended for the `v0.6.x` memory surface)

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

- [`v0.6.1`](release-notes/v0.6.1.md) · [`v0.6.0`](release-notes/v0.6.0.md) · [`v0.5.3`](release-notes/v0.5.3.md) · [`v0.5.2`](release-notes/v0.5.2.md) · [`v0.5.1`](release-notes/v0.5.1.md) · [Changelog](CHANGELOG.md)

## License

MIT License. See [LICENSE](LICENSE) for details.
