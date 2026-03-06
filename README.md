# Gigabrain

Gigabrain is the long-term memory layer for [OpenClaw](https://openclaw.ai) agents. It converts conversations and native notes into durable, queryable memory, then injects the right context before each prompt so agents stay consistent across sessions.

It is built for local-first production use: SQLite-backed recall, deterministic dedupe/audit flows, native markdown sync, and an optional FastAPI console for memory operations.

## What it does

- **Capture**: Extracts structured facts (preferences, decisions, entities, episodes) from conversations and stores them in a SQLite registry
- **Recall**: Before each prompt, searches the registry and native markdown files to inject relevant context the agent "remembers"
- **Dedupe**: Exact and hybrid semantic deduplication catches duplicates, paraphrases, and malformed near-duplicates with type-aware thresholds
- **Native sync**: Indexes your workspace `MEMORY.md` and daily notes alongside the registry for unified recall
- **Person service**: Tracks entity mentions across memories for person-aware retrieval ordering
- **Quality gate**: Junk filters, durable-personal retention bias, plausibility heuristics, and optional LLM second opinion keep memory clean without losing important relationship context
- **Audit**: Nightly maintenance with snapshots, execution artifacts, archive reports, review queue retention, and quality scoring
- **Web console**: Optional FastAPI dashboard for browsing, editing, and managing memories

## Prerequisites

- **Node.js** >= 22.x (uses `node:sqlite` experimental API)
- **OpenClaw** >= 2026.2.15 (gateway + plugin loader)
- **Python** >= 3.10 (only for the optional web console)
- **Ollama** (optional, for local LLM-based extraction review and semantic search)

## Installation

### Option A: npm install + setup wizard (recommended)

Install:

```bash
mkdir -p ~/.openclaw/plugins
cd ~/.openclaw/plugins
npm install @legendaryvibecoder/gigabrain
cd node_modules/@legendaryvibecoder/gigabrain
```

Run the one-command setup wizard:

```bash
npm run setup -- --workspace /path/to/your-openclaw-workspace
```

What the setup wizard does:

- Ensures `plugins.entries.gigabrain` exists in `~/.openclaw/openclaw.json`
- Sets plugin path and runtime paths (`workspaceRoot`, `registryPath`)
- Bootstraps the DB and indexes native memory files
- Adds AGENTS memory protocol block (unless `--skip-agents`)
- Restarts gateway (unless `--skip-restart`)

Wizard help:

```bash
npm run setup -- --help
```

### Option B: Manual setup (custom environments)

1. Install from source:

```bash
cd ~/.openclaw/plugins
git clone https://github.com/legendaryvibecoder/gigabrain.git
```

2. Register plugin in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "gigabrain": {
        "path": "~/.openclaw/plugins/gigabrain",
        "config": {
          "enabled": true
        }
      }
    }
  }
}
```

3. Restart gateway:

```bash
openclaw gateway restart
```

4. Run migration once:

```bash
node scripts/migrate-v3.js --apply --config ~/.openclaw/openclaw.json
```

## Configuration

All config lives under `plugins.entries.gigabrain.config` in `openclaw.json`. The full schema is defined in [`openclaw.plugin.json`](openclaw.plugin.json). Key sections:

### Runtime

```json
{
  "runtime": {
    "timezone": "Europe/Vienna",
    "paths": {
      "workspaceRoot": "/path/to/agent/workspace",
      "memoryRoot": "memory",
      "registryPath": "/path/to/memory.db"
    }
  }
}
```

- `workspaceRoot` — agent workspace root (where `MEMORY.md` lives)
- `memoryRoot` — subdirectory for daily notes (default: `memory`)
- `registryPath` — path to the SQLite database (auto-created if missing)

### Capture

```json
{
  "capture": {
    "enabled": true,
    "requireMemoryNote": true,
    "minConfidence": 0.65,
    "minContentChars": 25
  }
}
```

- `requireMemoryNote` — when `true`, only explicit `<memory_note>` tags trigger capture (recommended)
- `minConfidence` — minimum confidence score to store a memory (0.0–1.0)

### Recall

```json
{
  "recall": {
    "topK": 8,
    "minScore": 0.45,
    "maxTokens": 1200,
    "mode": "hybrid"
  }
}
```

- `topK` — maximum memories injected per prompt
- `mode` — `personal_core` (identity-heavy), `project_context` (task-heavy), or `hybrid`
- `classBudgets` — budget split between core/situational/decisions (must sum to 1.0)

### Dedupe

```json
{
  "dedupe": {
    "exactEnabled": true,
    "semanticEnabled": true,
    "autoThreshold": 0.92,
    "reviewThreshold": 0.85
  }
}
```

- Above `autoThreshold` — auto-merged silently
- Between `reviewThreshold` and `autoThreshold` — queued for review

### LLM (optional)

```json
{
  "llm": {
    "provider": "ollama",
    "baseUrl": "http://127.0.0.1:11434",
    "model": "qwen3.5:9b",
    "taskProfiles": {
      "memory_review": {
        "temperature": 0.15,
        "top_p": 0.8,
        "top_k": 20,
        "max_tokens": 180
      },
      "chat_general": {
        "model": "qwen3.5:latest",
        "temperature": 1.0,
        "top_p": 0.95,
        "top_k": 40,
        "max_tokens": 1200,
        "reasoning": "default"
      }
    },
    "review": {
      "enabled": true,
      "profile": "memory_review"
    }
  }
}
```

Providers: `ollama`, `openai_compatible`, `openclaw`, or `none` (deterministic-only mode).

Task profiles let you keep one local model family while changing sampling per job. `memory_review` intentionally uses a small non-zero temperature for stable JSON output with Qwen 3.5, while `chat_general` stays close to the model defaults.

### Native sync

```json
{
  "native": {
    "enabled": true,
    "memoryMdPath": "MEMORY.md",
    "dailyNotesGlob": "memory/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*.md"
  }
}
```

Indexes workspace markdown files into `memory_native_chunks` for unified recall alongside the registry.

### Quality

```json
{
  "quality": {
    "junkFilterEnabled": true,
    "durableEnabled": true,
    "plausibility": {
      "enabled": true
    },
    "valueThresholds": {
      "keep": 0.78,
      "archive": 0.30,
      "reject": 0.18
    }
  }
}
```

Built-in junk patterns block system prompts, API keys, and benchmark artifacts from being stored. Durable patterns and relationship-aware rules preserve important user, agent, and continuity facts. Plausibility heuristics help archive malformed captures such as broken paraphrases and noisy technical discoveries that should not live as durable memory.

### Nightly maintenance

`nightly` now runs a full maintenance pipeline:

`snapshot -> native_sync -> quality_sweep -> exact_dedupe -> semantic_dedupe -> audit_delta -> archive_compression -> vacuum -> metrics_report`

Important artifacts written by the run:

- `output/nightly-execution-YYYY-MM-DD.json`
- `output/memory-kept-YYYY-MM-DD.md`
- `output/memory-archived-or-killed-YYYY-MM-DD.md`
- `output/memory-review-queue.jsonl`

See [`openclaw.plugin.json`](openclaw.plugin.json) for the complete schema with all defaults.

## First-time setup details

Migration creates the database schema (`memory_events`, `memory_current`, `memory_native_chunks`, `memory_entity_mentions`) and backfills events from any existing data.

A rollback metadata file is written to `output/rollback-meta.json` in case you need to revert.

## Memory notes (how capture works)

Gigabrain captures memories when the agent emits `<memory_note>` XML tags in its responses. By default, `requireMemoryNote` is `true`, so **only explicit tags trigger capture** — Gigabrain won't silently extract facts from normal conversation.

### Tag format

```xml
<memory_note type="USER_FACT" confidence="0.9">User prefers dark mode in all editors.</memory_note>
```

**Attributes:**

| Attribute | Required | Values |
|-----------|----------|--------|
| `type` | Yes | `USER_FACT`, `PREFERENCE`, `DECISION`, `ENTITY`, `EPISODE`, `AGENT_IDENTITY`, `CONTEXT` |
| `confidence` | No | `0.0`–`1.0`, or `high` / `medium` / `low` (default: `0.65`) |
| `scope` | No | Memory scope, e.g. `shared`, `profile:main` (default: from config) |

**Rules:**
- One fact per tag — keep it short and concrete
- No secrets, credentials, API keys, or tokens
- No system prompt wrappers or tool output envelopes
- Content must be at least 25 characters (configurable via `capture.minContentChars`)
- Content must not exceed 1200 characters
- Nested `<memory_note>` tags are rejected

### Agent instructions (AGENTS.md)

For the agent to emit memory notes correctly, you need instructions in your workspace `AGENTS.md` (or equivalent instruction file).

- If you used the setup wizard, this block is added automatically (unless `--skip-agents`).
- If you used manual setup, add it yourself.

Minimal example:

```markdown
## Memory

Gigabrain handles memory capture and recall automatically.

### Memory Note Protocol

When the user explicitly asks you to remember or save something
(e.g. "remember that", "save this", "note that I prefer X"):

1. Emit a `<memory_note>` tag with the fact:
   ```xml
   <memory_note type="USER_FACT" confidence="0.9">Concrete fact here.</memory_note>
   ```
2. Use one tag per fact.
3. Keep facts short, concrete, and self-contained.
4. Choose the appropriate type (USER_FACT, PREFERENCE, DECISION, ENTITY, EPISODE, AGENT_IDENTITY).

When the user does NOT explicitly ask to save memory:
- Do NOT emit `<memory_note>` tags.
- Normal conversation does not trigger memory capture.

Never include secrets, credentials, tokens, or API keys in memory notes.
```

### How recall works

Before each prompt, Gigabrain:

1. **Sanitizes the user query** — strips prior `<gigabrain-context>` blocks, metadata lines, bootstrap injections, and markdown noise to extract the real question
2. **Entity coreference resolution** — detects pronoun follow-ups (e.g. "was weisst du noch über sie?") and enriches the query with the entity from prior messages in the conversation
3. Searches the SQLite registry for memories relevant to the sanitized query
4. Searches native markdown files (`MEMORY.md`, daily notes) for matching chunks
5. **Entity answer quality scoring** — for "who is" / "wer ist" queries, penalizes instruction-like memories ("Add to profile: ...") and boosts direct factual content
6. **Deduplication** — removes duplicate memories by normalized content before ranking
7. Applies class budgets (core / situational / decisions) and token limits
8. **Entity answer hints** — for entity queries, extracts top-3 factual answers and includes them as `entity_answer_hints` in the injection block
9. Injects the results as a system message placed before the last user message in the conversation

The agent doesn't need to do anything special for recall — it happens automatically via the gateway plugin hooks.

### Scope rules

- **Private/main sessions** (direct chat): recall from all sources including `MEMORY.md` and private scopes
- **Shared contexts** (group chats, other users): only curated shared memories, never private data

Configure scope behavior in `openclaw.json` under the agent's memory settings.

## CLI

The control plane is `scripts/gigabrainctl.js`:

```bash
# Full nightly pipeline (maintain + optional harmonize + audit apply)
node scripts/gigabrainctl.js nightly

# Maintenance only (snapshot, native sync, quality sweep, dedupe, artifacts, vacuum)
node scripts/gigabrainctl.js maintain

# Quality audit (shadow = dry-run, apply = commit changes, restore = rollback, report = render)
node scripts/gigabrainctl.js audit --mode shadow|apply|restore|report

# Print memory inventory stats
node scripts/gigabrainctl.js inventory

# Health check
node scripts/gigabrainctl.js doctor
```

`nightly --help` is safe and prints usage instead of starting a real run.

All commands are also available as npm scripts: `npm run nightly`, `npm run maintain`, etc.

## HTTP endpoints

The plugin registers these routes on the OpenClaw gateway:

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/gb/health` | No | Health check |
| `POST` | `/gb/recall` | Token | Memory recall for a query |
| `POST` | `/gb/suggestions` | Token | Structured suggestion ingest |
| `POST` | `/gb/bench/recall` | Token | Recall benchmark endpoint |
| `GET` | `/gb/memory/:id/timeline` | Token | Event timeline for a memory |

Auth uses the `X-GB-Token` header. The token is configured in the gateway.

## Web console (memory_api)

An optional FastAPI dashboard for browsing and managing memories. See [`memory_api/README.md`](memory_api/README.md) for setup.

Features: memory browser with search/filter, concept deduplication view, audit queue, document store, profile viewer, knowledge graph visualization.

## Testing

```bash
# Run all tests (requires Node.js with --experimental-sqlite)
npm test

# Filter by category
npm run test:unit
npm run test:integration
npm run test:regression
npm run test:performance
```

The suite includes 12 executable tests covering config validation, policy rules, capture service, person service, LLM routing, native-sync query handling, audit maintenance, migration, bridge routes, native recall, regression behavior, and nightly performance.

## Benchmarking

```bash
# Single benchmark run
node bench/memorybench/run.js \
  --base-url http://127.0.0.1:18789 \
  --token "$GB_UI_TOKEN" \
  --cases eval/cases.jsonl \
  --topk 8 --runs 3

# Compare two environments
node bench/memorybench/compare.js \
  --base-a http://host-a:18789 --token-a "$TOKEN_A" --label-a baseline \
  --base-b http://host-b:18789 --token-b "$TOKEN_B" --label-b candidate \
  --runs 3
```

Results are written to `bench/memorybench/data/runs/`.

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
│   ├── audit-service.js        # Quality scoring, review, restore/report flows
│   ├── maintenance-service.js  # Nightly pipeline, snapshots, execution artifacts
│   ├── llm-router.js           # LLM provider abstraction + task profiles
│   ├── http-routes.js          # Gateway HTTP endpoints
│   ├── review-queue.js         # Capture and audit review queue retention
│   └── metrics.js              # Telemetry counters
│
├── scripts/                    # CLI tools
│   ├── gigabrainctl.js         # Main control plane
│   ├── migrate-v3.js           # Schema migration
│   └── harmonize-memory.js     # Memory harmonization
│
├── memory_api/                 # Optional web console (FastAPI)
│   ├── app.py
│   ├── requirements.txt
│   └── static/index.html
│
├── tests/                      # Test suite
├── bench/memorybench/          # Benchmark harness
└── eval/                       # Evaluation cases
```

## Security

- All HTTP endpoints require token authentication (`X-GB-Token` header)
- Auth is **fail-closed**: if no token is configured, all requests are rejected
- The web console escapes all user content to prevent XSS
- The memory_api binds to `127.0.0.1` only — use Tailscale or SSH tunneling for remote access
- Dependencies are audited with `pip-audit` and `npm audit`. Transitive dependency alerts (e.g. from peer dependencies) are tracked via Dependabot

## License

MIT License. See LICENSE file for details.
