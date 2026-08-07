# Gigabrain

<p align="center">
  <strong>One memory your AI assistants can share — and you can control.</strong>
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

If you use more than one AI assistant — one for writing, another for code, a third in your editor — each one remembers different things about you and your work. Those memories stay separate. They can repeat themselves, miss important context, or disagree about what is still current.

**Gigabrain brings supported memories together in one place you control.** It reads them without changing the originals, remembers where each piece came from, and points out when information conflicts or has been replaced by something newer.

Your AI assistants keep their own built-in memory for speed. Gigabrain gives them a shared, longer-term record that stays local by default and that you can review at any time.

## What it does

- **Shared recall, explicit scope** — project facts and stable user preferences can be shared by Codex, Claude Code, Hermes, and OpenClaw when they point at the same Gigabrain config.
- **Provenance for every claim** — source host, source path, trust tier, evidence, timestamps, and status stay inspectable.
- **Contradiction handling** — competing claims are resolved by a deterministic trust → corroboration → recency policy, with an append-only adjudication record.
- **Bi-temporal memory** — a fact can have both a content time and a validity window; expired and superseded rows are excluded from normal recall.
- **Recovery and audit** — optional transcript harvesting, secret-risk filtering, review queues, Handoff Records, and a human-readable memory wiki.
- **Local-first operation** — SQLite, lexical recall, policy checks, and the default setup work without a cloud memory backend.

Gigabrain does **not** scrape account-level memories from ChatGPT, Claude.ai, Gemini, or Copilot. It does **not** silently synchronize two computers. It does **not** turn memory into an unquestionable source of truth. It gives you an inspectable system for deciding what should be recalled and why.

## How it works

1. **Ingest** supported local memory files, explicit checkpoints, and manual exports into a local event store.
2. **Project** the latest state into SQLite, preserving source and validity metadata.
3. **Arbitrate** duplicates and contradictions with reviewable rules; destructive uncertainty goes to a queue.
4. **Recall** through MCP, CLI, or authenticated HTTP with lexical search and optional loopback-only Ollama embeddings.

```
   Codex   Claude   Cursor   OpenClaw   Hermes   manual exports
     └────────┴────────┴─────────┴─────────┴──────────────┘
                              │   (supported imports are read-only)
                              ▼
                    ┌────────────────────┐
                    │      Gigabrain     │   capture · arbitrate · recall
                    │ arbitration ledger │   MCP · CLI · HTTP
                    └─────────┬──────────┘
                              │  de-conflicted, source-stamped recall
                              ▼
                  any configured agent, via gigabrain_recall
```

## Quickstart

```bash
npm install @legendaryvibecoder/gigabrain
npx gigabrainctl init --project-root /path/to/repo
npx gigabrainctl doctor --config ~/.gigabrain/config.json --target both
npx gigabrainctl handoff --config ~/.gigabrain/config.json \
  --output-dir ./gigabrain-memory-audit
```

`init` writes the canonical standalone config to `~/.gigabrain/config.json`. Use that same config for later commands and MCP registrations. Setup can discover supported local memory files and import them read-only; review the generated audit before enabling broader capture.

Choose the host guide: [Codex](docs/setup-codex.md) · [Claude Code](docs/setup-claude.md) · [OpenClaw](docs/setup-openclaw.md).

### Two computers are two stores unless you connect them

Installing the same package version on a MacBook and a Mac Studio does not make their memories identical. Code parity, config parity, and data parity are separate checks. Use a reviewed `export-bundle` / `import-bundle` workflow or configure the optional authenticated remote bridge; Gigabrain never enables cross-host transport silently. See [sharing](docs/sharing.md).

## Release highlights

| | What it means for you |
| --- | --- |
| **Answer-shaped recall** | Duration, completion, and certification questions now favor evidence that can actually answer the question while demoting unrelated preferences. |
| **Immediate arbitration** | Contradictions are evaluated during ingest as well as maintenance, with uncertain destructive changes routed to review. |
| **Host-memory adapters** | Codex, Claude Code, Hermes, Cursor, and Windsurf local surfaces can be inspected and imported with source attribution. |
| **Portable handoff** | Integrity-hashed export/import bundles support deliberate movement between stores without implying background sync. |
| **Public-release privacy gate** | Git files and the real npm pack inventory are scanned completely; unknown binary files fail closed and findings are redacted. |
| **Hardened local console** | Authentication, scope enforcement, bounded upload/fetch paths, security headers, and dependency audits are covered by runtime tests. |

The cloud-inbox drop folder, transcript harvesting, git wiki, Obsidian reference corpus, remote bridge, and URL importer are opt-in. Review [configuration](docs/configuration.md) and the [privacy model](docs/public/privacy-model.md) before enabling additional data sources or networked providers.

## Supported clients

| Host surface | Install | What Gigabrain owns |
| --- | --- | --- |
| **OpenClaw** | `openclaw plugins install` | Optional memory-slot provider, registry, recall, arbitration, maintenance |
| **Codex desktop / CLI / IDE** | `npm install` + setup | Local project/user store and MCP tools on the configured Codex host |
| **Claude Code** | `npm install` + setup | Same standalone store when configured identically, MCP tools, `.mcp.json` wiring |
| **Claude Desktop** | `claude:desktop:bundle` | Same MCP-backed memory store and tools as Claude Code |
| **Hermes Agent** | `gigabrain-hermes-setup` | MCP tools plus read-only import of local Hermes memory files |
| **Cursor / Windsurf** | `gigabrainctl sync-hosts` | Read-only import adapter for local project rules/memory; no native write-back |
| **Cloud assistants** | explicit file import | Manual ChatGPT, Gemini, or Copilot exports parsed locally; no account scraping |

## Privacy model

- The default standalone store is local SQLite under `~/.gigabrain/`; no hosted Gigabrain backend is required.
- The default LLM provider is `none`. Optional semantic embeddings are sent only to a loopback Ollama endpoint.
- Raw transcript extraction is permitted only with a local provider or an explicitly injected local hook. Cloud audit review skips credential-risk rows, masks supported PII shapes locally, and omits the original scope; cloud providers do not receive raw transcripts through capture.
- Native host stores are imported read-only. Account-level cloud memories are outside scope unless you export them explicitly.
- Network features are explicit: the remote bridge is opt-in; the Python console's URL import is disabled by default and requires an exact host allowlist.
- The release gate scans tracked and untracked publishable files, npm package contents, Git metadata, and GitHub metadata without printing matched values.

Local-first does not mean risk-free: the SQLite store and generated Markdown can contain sensitive memory. Protect the host account, use disk encryption, restrict file permissions, and review exports before moving them. Full boundary: [docs/public/privacy-model.md](docs/public/privacy-model.md).

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

- **Capture** — explicit `remember` calls, checkpoints, host imports, and optional transcript recovery become append-only events.
- **Recall** — FTS5/BM25 works without a model. When local embeddings are available, Gigabrain fuses lexical and dense rankings, then applies scope, status, answer-shape, provenance, and arbitration policy.
- **Arbitration** — a claim-slot world model records competing beliefs and applies trust tier → corroboration → recency with clock-skew and source-independence defenses.
- **Audit + Handoff Records** — static Markdown/HTML/JSON reports show readiness, source coverage, contradictions, stale rows, and secret-risk omissions.

Gigabrain does not claim state of the art. The published evidence is a small development regression set, not a held-out industry benchmark; see [benchmark evidence](docs/public/benchmark-evidence.md).

## Why use it when native memory exists?

Native memory is now real and useful: [Codex has local memories](https://learn.chatgpt.com/docs/customization/memories), [Claude Code has auto memory](https://code.claude.com/docs/en/memory), [Cursor has project-scoped memories](https://docs.cursor.com/en/context/memories), and [OpenClaw has hybrid memory search](https://docs.openclaw.ai/concepts/memory-search). Their documented boundaries differ, and several stores remain machine- or product-local.

Gigabrain's job is not to pretend those features do not exist. Its job is to provide cross-product provenance, explicit project/user scopes, deterministic contradiction handling, bi-temporal validity, portable exports, and one protocol surface that you can audit independently. See [the detailed comparison](docs/public/why-gigabrain.md).

## MCP tools

`gigabrain_recall` · `gigabrain_remember` · `gigabrain_checkpoint` · `gigabrain_provenance` · `gigabrain_recent` · `gigabrain_sources` · `gigabrain_sync_status` · `gigabrain_export_brief` · `gigabrain_entity` · `gigabrain_relationships` · `gigabrain_contradictions` · `gigabrain_arbitrate` · `gigabrain_adjudications` · `gigabrain_beliefs_as_of` · `gigabrain_review_queue` · `gigabrain_doctor`

The core memory surfaces are mapped across agents (MCP), operators (CLI), and the optional HTTP app — see the [coverage matrix](docs/coverage-matrix.md) for the exact coverage of each action.

## CLI

```bash
npx gigabrainctl init                       # auto-detect + wire installed agents
npx gigabrainctl handoff --output-dir ./out # Memory Audit + safe Handoff Records
npx gigabrainctl nightly                     # full nightly pipeline (ingest, arbitrate, audit)
npx gigabrainctl doctor                      # health check
npx gigabrainctl inventory                   # memory stats
npx gigabrainctl review contradictions       # inspect cross-agent contradictions
npx gigabrainctl sync-hosts --host codex,claude_code  # force a host re-ingest
npx gigabrainctl vault sync|status           # read-only Obsidian reference corpus
npx gigabrainctl transcript sync|status      # raw-rollout harvester
npx gigabrainctl wiki project|reconcile|status  # git-versioned memory wiki
npx gigabrainctl watch --install-hook --kind=session  # auto-capture on session end
npx gigabrainctl export-bundle --out ./memory-bundle.json
npx gigabrainctl import-bundle --in ./memory-bundle.json
npx gigabrainctl migrate legacy-drop --dry-run  # containment-gated legacy cleanup
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

`/gb` and `/gb/health` expose only landing/health information. Data routes accept `X-GB-Token`, `X-OpenClaw-Token`, or a Bearer token and fail closed when no token is configured. `GB_ALLOW_NO_AUTH=1` is an explicit, dangerous development escape hatch: it bypasses the Node route checks only when no token is configured, emits a warning, and must never be used beyond a loopback-only disposable environment. OpenClaw gateway authentication can still add an outer auth layer.

## Key subsystems

| Subsystem | Docs |
|-----------|------|
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

- **Node.js** >= 22.18.0 (uses `node:sqlite` and built-in TypeScript type stripping)
- **Ollama** (optional, for local fact extraction + semantic search)
- **OpenClaw** >= 2026.2.15 (only for the plugin path)
- **Python** >= 3.10 (only for the optional web console)

## Testing

```bash
node tests/run-all.js     # repository suite
node scripts/package-smoke.js  # packaged runtime smoke test
npm run pack:dry-run     # verify published package contents
node scripts/check-no-pii.mjs
node scripts/check-public-mirror.mjs --require-single-commit  # public mirror only
npm run audit:github-metadata -- --repo owner/repository     # after remote creation
```

## Security

- By default, all data-bearing Node HTTP endpoints require timing-safe token auth. The Node token grants access to that configured store; scope is a recall/query filter there, while scoped-token isolation and id-existence concealment are enforced by the optional FastAPI console. The development-only `GB_ALLOW_NO_AUTH=1` escape hatch above is unsafe for network exposure.
- The optional web console is documented for loopback binding, adds security headers, bounds uploads and extracted PDF text, and disables URL import by default.
- Release dependencies are checked with `npm audit` and `pip-audit`; the dated result and residual risks are in the [security review](docs/public/security-review.md).
- The public mirror is created from an explicit allowlist as a new single-commit history; the private engineering repository is never flipped public in place.

Do not open public issues for vulnerabilities — use the private flow in [SECURITY.md](SECURITY.md).

## Contributing

External contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) first. Open Issues for concrete bugs, Discussions for design/usage. Never post secrets, private paths, or runtime artifacts.

## License

MIT License. See [LICENSE](LICENSE).
