# Gigabrain

<p align="center">
  <strong>One shared memory for your AI assistants, under your control.</strong>
</p>

<p align="center">
  <a href="https://github.com/legendaryvibecoder/gigabrain/releases"><img src="https://img.shields.io/github/v/release/legendaryvibecoder/gigabrain?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="https://www.npmjs.com/package/@legendaryvibecoder/gigabrain"><img src="https://img.shields.io/npm/v/@legendaryvibecoder/gigabrain?style=for-the-badge" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg?style=for-the-badge" alt="MIT License"></a>
  <a href="https://github.com/legendaryvibecoder/gigabrain/stargazers"><img src="https://img.shields.io/github/stars/legendaryvibecoder/gigabrain?style=for-the-badge" alt="GitHub Stars"></a>
  <img src="https://img.shields.io/badge/local--first-by%20default-brightgreen?style=for-the-badge" alt="Local-first by default">
</p>

<p align="center">
  <a href="docs/configuration.md">Configuration</a> ·
  <a href="CHANGELOG.md">Changelog</a> ·
  <a href="CONTRIBUTING.md">Contributing</a> ·
  <a href="SECURITY.md">Security</a> ·
  <a href="https://github.com/legendaryvibecoder/gigabrain/discussions">Discussions</a>
</p>

---

## Why this exists

Each AI assistant keeps a separate memory of your work, so one assistant can miss a decision that you made with another. You then explain the same facts again. Old information can also guide new work.

When a Codex session moves an app from Stripe to Paddle, Claude Code can still hold the old Stripe record. A later billing change can then use Stripe code.

## What Gigabrain does

Gigabrain keeps one local record for supported AI assistants.

- **Read supported memory files.** Gigabrain adds the facts that it finds to the shared record. It keeps each source file unchanged.
- **Keep the source and dates.** You can check where a fact came from and when it entered the store.
- **Show conflicts.** Gigabrain applies documented rules when two records disagree about the same fact. It gives more weight to strong support and recent evidence, then keeps the decision history.
- **Store data on your computer.** The default memory store stays on your computer. You choose each optional connection.

Gigabrain works beside each assistant's built-in memory as a shared record that you can inspect or correct. Use an export when you want to move it.

## Quickstart

These commands install the package, connect a project, check the setup, and write an audit report. All supported imports stay read-only.

```bash
npm install @legendaryvibecoder/gigabrain
npx gigabrainctl init --project-root /path/to/repo
npx gigabrainctl doctor --config ~/.gigabrain/config.json --target both
npx gigabrainctl handoff --config ~/.gigabrain/config.json \
  --output-dir ./gigabrain-memory-audit
```

`init` writes the configuration to `~/.gigabrain/config.json`. The other commands and assistant setups use this file. Read the audit report before you enable a feature from the [configuration guide](docs/configuration.md).

Open the guide for your assistant: [Codex](docs/setup-codex.md) · [Claude Code](docs/setup-claude.md) · [OpenClaw](docs/setup-openclaw.md).

## Limits and safeguards

- Memories in ChatGPT, Claude.ai, Gemini, and Copilot stay in those accounts. Gigabrain can import a supported file after you export it.
- A laptop and a desktop use separate stores. Use a reviewed bundle or a configured connection when you want to move data between them. See the [sharing guide](docs/sharing.md).
- Gigabrain ranks evidence with documented rules and lets you inspect or change the result.
- The local store can contain sensitive data. Protect the computer and review every export before you move it. Read the [privacy guide](docs/public/privacy-model.md).

The [configuration guide](docs/configuration.md) describes every setting and optional feature.

---

## Technical reference

## Core behavior

- **Shared recall with clear scope:** Codex, Claude Code, Hermes, and OpenClaw can share project facts and stable user preferences when they use the same Gigabrain configuration.
- **Source record:** Each claim keeps its source host, path, evidence, time data, status, and trust tier.
- **Conflict rules:** Gigabrain checks source trust first. It then checks independent support. Recency resolves the final tie. An append-only record keeps each decision.
- **Time model:** A fact can have a content time and a validity window. Normal recall skips expired or superseded rows.
- **Checkpoint control plane:** A checkpoint is an immutable episode, not automatically a durable fact. Durable candidates stay as reviewable claims until an authorized decision promotes them.
- **Audit tools:** Optional tools can recover transcripts, filter secret risks, manage review queues, write Handoff Records, and build a memory wiki.
- **Local operation:** The default setup runs locally, where SQLite stores the data and lexical search finds it. Policy checks control each result. A cloud memory service is optional.

## Processing flow

1. **Ingest:** Add supported local memory files, explicit checkpoints, and manual exports to a local event store.
2. **Build the current view:** Write the latest state to SQLite and keep its source and validity data.
3. **Resolve conflicts:** Apply reviewable rules to duplicate or conflicting claims. A queue holds uncertain changes that can remove data.
4. **Serve recall:** Use lexical search through MCP, the CLI, or authenticated HTTP. Loopback Ollama embeddings are optional.

```
   Codex   Claude   Cursor   OpenClaw   Hermes   manual exports
     └────────┴────────┴─────────┴─────────┴──────────────┘
                              │   (supported imports are read-only)
                              ▼
                    ┌────────────────────┐
                    │      Gigabrain     │   capture · resolve · recall
                    │ arbitration ledger │   MCP · CLI · HTTP
                    └─────────┬──────────┘
                              │  recall with sources after conflict checks
                              ▼
                  any configured agent uses gigabrain_recall
```

## Release highlights

| | What it means for you |
| --- | --- |
| **Checkpoint control plane** | Checkpoints become immutable episodes. Durable candidates remain reviewable proposals, and decisions can produce policy-versioned receipts. |
| **Remote MCP beta** | A self-hosted Streamable HTTP connector can serve approved tools to Claude and ChatGPT. It verifies OAuth JWTs, enforces exact memory scopes, redacts local paths, and enables no writes by default. |
| **Answer-focused recall** | Recall selects evidence that can answer questions about duration, completion, or certification. Unrelated preferences rank lower. |
| **Conflict checks during import** | Gigabrain checks conflicts during import and during maintenance. Risky changes wait for review. |
| **Local host imports** | Gigabrain can inspect and import supported local data from Codex, Claude Code, Hermes, Cursor, and Windsurf. Each imported fact keeps its source. |
| **Portable handoff** | Export and import bundles use integrity hashes. Data moves only when you run the export and import commands. |
| **Privacy check for releases** | The release check scans Git files and the npm package contents. It blocks unknown binary files and redacts each finding. |
| **Secured local console** | Runtime tests cover authentication, scope rules, path limits, security headers, and dependency checks. |

The cloud inbox, transcript recovery, Git wiki, Obsidian reference set, remote bridge, and URL importer start disabled. Read the [configuration guide](docs/configuration.md) and [privacy model](docs/public/privacy-model.md) before you add a data source or network provider.

## Supported clients

| Host surface | Install | What Gigabrain handles |
| --- | --- | --- |
| **OpenClaw** | `openclaw plugins install` | Provides an optional memory slot, registry, recall, conflict checks, and maintenance |
| **Codex desktop, CLI, or IDE** | `npm install` and setup | Keeps the local project and user store on the configured Codex host. It also provides MCP tools. |
| **Claude Code** | `npm install` and setup | Uses the same standalone store when its configuration matches. Setup adds MCP tools and `.mcp.json` entries. |
| **Claude Desktop** | `claude:desktop:bundle` | Uses the same MCP-backed memory store and tools as Claude Code |
| **Claude web or ChatGPT web** | Self-hosted remote MCP | Connects to an OAuth-protected, read-only-by-default `/mcp` endpoint. See the [remote setup guide](docs/setup-remote-mcp.md). |
| **Hermes Agent** | `gigabrain-hermes-setup` | Adds MCP tools and imports local Hermes memory files in read-only mode |
| **Cursor or Windsurf** | `gigabrainctl sync-hosts` | Imports local project rules and memory in read-only mode |
| **Cloud assistants** | Explicit file import | Parses supported ChatGPT, Gemini, or Copilot files after you export them |

## Privacy model

- Gigabrain keeps the standalone SQLite store under `~/.gigabrain/`. A hosted Gigabrain service is optional.
- The default LLM provider setting is `none`. Optional semantic embeddings go only to a loopback Ollama endpoint.
- Gigabrain extracts raw transcripts through a local provider or a local hook that you add. A cloud audit excludes rows that can contain credentials. Before data leaves the computer, Gigabrain masks supported PII patterns and removes the original scope.
- Native host stores use read-only import. To add a supported memory file from a cloud account, export it first.
- Enable each network feature before use. The remote bridge is opt-in. For URL import, the Python console requires an exact host allowlist and an explicit setting.
- Remote MCP is an explicit self-hosted service. It reads the configured Gigabrain store while running; it does not upload or replicate that store by itself, and writes stay disabled unless separately enabled and authorized.
- The release gate scans all publishable files, the npm package contents, Git data, and GitHub data. Its output hides matched values.

The SQLite store and generated Markdown can contain sensitive memory. Protect the host account, use disk encryption, restrict file permissions, and review each export before you move it. Read the full boundary in the [privacy model](docs/public/privacy-model.md).

## How it works under the hood

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
│  Host Sync ◄─ Codex/Claude/etc. │  ← read-only adapters
│  Transcript Harvester ◄─ logs   │  ← optional recovery
│  Arbiter (trust>support>recency)│  ← at ingest + nightly
│  World Model (entities/beliefs) │
│  Git Wiki ◄─► reviewed edits    │  ← optional, high trust
└──────────────┬───────────────────┘
               │
         SQLite + FTS5 + optional local embeddings
```

- **Capture:** Explicit `remember` calls, host imports, and optional transcript recovery become append-only events. Checkpoints additionally create immutable episodes; durable candidates become reviewable claims rather than silent memories.
- **Recall:** FTS5 and BM25 search text directly. When local embeddings are available, Gigabrain combines lexical and dense rankings. It then applies scope, status, answer fit, source data, and conflict rules.
- **Conflict review:** The world model records competing beliefs for each claim slot and ranks them by trust tier. It next checks independent support. Recency resolves any remaining tie. Clock-skew and source-independence checks protect the result.
- **Audit reports:** Static Markdown, HTML, and JSON reports show readiness, source coverage, conflicts, stale rows, and omitted secret risks.

The published evidence comes from a small development regression set. The [benchmark evidence](docs/public/benchmark-evidence.md) page describes its limits.

## Why use it when native memory exists?

Several assistants provide useful native memory. [Codex has local memories](https://learn.chatgpt.com/docs/customization/memories), [Claude Code has auto memory](https://code.claude.com/docs/en/memory), [Cursor has project memories](https://docs.cursor.com/en/context/memories), and [OpenClaw has hybrid memory search](https://docs.openclaw.ai/concepts/memory-search). Each product documents a different scope. Some stores stay on one machine or inside one product.

Gigabrain keeps source data across products and separates project facts from user preferences. Fixed rules resolve conflicts. Validity dates control when each fact applies. You can move the record with an export and audit the protocol independently. The [detailed comparison](docs/public/why-gigabrain.md) maps these features to native memory.

## MCP tools

`gigabrain_recall` · `gigabrain_remember` · `gigabrain_checkpoint` · `gigabrain_checkpoint_list` · `gigabrain_checkpoint_get` · `gigabrain_claim_propose` · `gigabrain_claim_review` · `gigabrain_claim_decide` · `gigabrain_receipt_write` · `gigabrain_receipt_get` · `gigabrain_provenance` · `gigabrain_recent` · `gigabrain_sources` · `gigabrain_sync_status` · `gigabrain_export_brief` · `gigabrain_entity` · `gigabrain_relationships` · `gigabrain_contradictions` · `gigabrain_arbitrate` · `gigabrain_adjudications` · `gigabrain_beliefs_as_of` · `gigabrain_review_queue` · `gigabrain_doctor`

Local and remote surfaces are intentionally asymmetric: broad writes stay local,
while remote MCP exposes a reviewed read allowlist and narrow opt-in writes. See
the [checkpoint control plane](docs/checkpoint-control-plane.md), [remote connector
guide](docs/setup-remote-mcp.md), and [coverage matrix](docs/coverage-matrix.md).

## CLI

```bash
npx gigabrainctl init                       # Find and connect installed agents
npx gigabrainctl handoff --output-dir ./out # Write a memory audit and safe Handoff Records
npx gigabrainctl nightly                    # Run the nightly import, conflict check, and audit
npx gigabrainctl doctor                     # Check system health
npx gigabrainctl inventory                  # Show memory statistics
npx gigabrainctl review contradictions      # Review conflicts across agents
npx gigabrainctl sync-hosts --host codex,claude_code  # Import a host again
npx gigabrainctl vault sync|status          # Use the read-only Obsidian reference set
npx gigabrainctl transcript sync|status     # Recover raw local transcripts
npx gigabrainctl wiki project|reconcile|status  # Manage the Git versioned memory wiki
npx gigabrainctl watch --install-hook --kind=session  # Capture at the end of a session
npx gigabrainctl export-bundle --out ./memory-bundle.json
npx gigabrainctl import-bundle --in ./memory-bundle.json
npx gigabrainctl migrate legacy-drop --dry-run  # Preview legacy cleanup
```

All commands accept `--config <path>` and are also available as `npm run` scripts.

## HTTP endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/gb` | No | Service landing response |
| `GET` | `/gb/health` | No | Health check |
| `POST` | `/gb/bench/recall` | Token | Recall result plus benchmark diagnostics |
| `POST` | `/gb/control/apply` | Token | **Mutating:** apply an explicit memory action |
| `GET` | `/gb/entities` | Token | List world-model entities |
| `GET` | `/gb/entities/:id` | Token | Entity detail (`/gb/entities/detail?id=...` is also accepted) |
| `GET` | `/gb/beliefs` | Token | List beliefs |
| `GET` | `/gb/episodes` | Token | List episodes |
| `GET` | `/gb/open-loops` | Token | List open loops |
| `GET` | `/gb/contradictions` | Token | List contradiction-review items |
| `GET` | `/gb/adjudications` | Token | List arbitration verdicts |
| `GET` | `/gb/beliefs-as-of` | Token | Bi-temporal belief snapshot |
| `GET` | `/gb/review-queue` | Token | Read-only review queue |
| `GET` | `/gb/relationships` | Token | Relationship graph for an entity |
| `GET` | `/gb/evolution` | Token | Entity evolution by claim slot |
| `GET` | `/gb/memory/:id/timeline` | Token | Event timeline for a memory |
| `POST` | `/gb/recall` | Token | Memory recall for a query |
| `POST` | `/gb/recall/explain` | Token | Recall diagnostics and routing explanation |
| `POST` | `/gb/suggestions` | Token | **Mutating:** validate and ingest structured suggestions |

`/gb` and `/gb/health` return service status only. Every data route accepts `X-GB-Token`, `X-OpenClaw-Token`, or a Bearer token. A route denies access when its configuration has no token. The dangerous development setting `GB_ALLOW_NO_AUTH=1` can bypass Node route checks only when no token is configured. It prints a warning. Use this setting only in a disposable loopback environment. OpenClaw gateway authentication can add an outer layer.

## Key subsystems

| Subsystem | Docs |
|-----------|------|
| Checkpoint / claim / receipt control plane | [docs/checkpoint-control-plane.md](docs/checkpoint-control-plane.md) |
| Remote MCP for Claude and ChatGPT | [docs/setup-remote-mcp.md](docs/setup-remote-mcp.md) |
| Memory Audit + Handoff Records | [docs/handoff-record.md](docs/handoff-record.md) |
| Surface coverage matrix (MCP / CLI / HTTP) | [docs/coverage-matrix.md](docs/coverage-matrix.md) |
| Configuration reference | [docs/configuration.md](docs/configuration.md) |
| Privacy and trust boundaries | [docs/public/privacy-model.md](docs/public/privacy-model.md) |
| Public security review | [docs/public/security-review.md](docs/public/security-review.md) |
| Native-memory comparison | [docs/public/why-gigabrain.md](docs/public/why-gigabrain.md) |
| Benchmark evidence | [docs/public/benchmark-evidence.md](docs/public/benchmark-evidence.md) |
| Recall pipeline | [docs/recall.md](docs/recall.md) |
| Nightly maintenance | [docs/maintenance.md](docs/maintenance.md) |
| Obsidian vault reference | [docs/obsidian.md](docs/obsidian.md) |

## Prerequisites

- **Node.js** 22.18.0 or later. Gigabrain uses `node:sqlite` and built-in TypeScript type stripping.
- **Ollama** is optional. It provides local fact extraction and semantic search.
- **OpenClaw** 2026.2.15 or later is required for the plugin path.
- **Python** 3.10 or later is required for the optional web console.

## Testing

```bash
node tests/run-all.js     # Run the repository tests
node scripts/package-smoke.js  # Test the packaged runtime
npm run pack:dry-run     # Check the published package contents
node scripts/check-no-pii.mjs
node scripts/check-public-mirror.mjs --require-single-commit  # Check the public mirror
npm run audit:github-metadata -- --repo owner/repository     # Check a new remote
```

## Security

- Node HTTP endpoints that carry data require a token by default. The code compares tokens with timing-safe logic. A Node token grants access to its configured store, where scope filters recall and queries. The optional FastAPI console isolates scoped tokens and conceals whether an ID exists. Limit `GB_ALLOW_NO_AUTH=1` to the development use described above.
- The optional web console listens on loopback as documented. It sets security headers and limits uploads. Extracted PDF text also has a size limit. URL import starts disabled.
- Release checks run `npm audit` and `pip-audit` against dependencies. The [security review](docs/public/security-review.md) gives the date, result, and remaining risks.
- An explicit allowlist creates the public mirror with a new single-commit history. The private engineering repository stays private.

Report vulnerabilities through the private process in [SECURITY.md](SECURITY.md).

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) before you send a change. Report a concrete bug in Issues, or use Discussions for design and usage questions. Remove private data from every post, including secrets, local paths, identifiers, and runtime files.

## License

MIT License. See [LICENSE](LICENSE).
