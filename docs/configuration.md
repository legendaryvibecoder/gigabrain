# Configuration Reference

OpenClaw mode keeps config under `plugins.entries.gigabrain.config` in `openclaw.json`. Codex and Claude standalone modes store the same schema in `~/.gigabrain/config.json` by default for fresh installs, reuse `~/.codex/gigabrain/config.json` when a supported legacy standalone install already exists, or use `<repo>/.gigabrain/config.json` when you opt into `--store-mode project-local`. The full OpenClaw plugin schema is defined in [`openclaw.plugin.json`](../openclaw.plugin.json).

## Runtime

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

## Capture

```json
{
  "capture": {
    "enabled": true,
    "requireMemoryNote": true,
    "minConfidence": 0.65,
    "minContentChars": 25,
    "rememberIntent": {
      "enabled": true,
      "phrasesBase": ["remember this", "remember that", "merk dir", "note this", "save this"],
      "writeNative": true,
      "writeRegistry": true
    }
  }
}
```

- `requireMemoryNote` — when `true`, only explicit `<memory_note>` tags trigger capture (recommended)
- `minConfidence` — minimum confidence score to store a memory (0.0–1.0)
- `rememberIntent` — lets the agent treat natural phrases like `remember that` as an explicit memory-save instruction without exposing the internal `<memory_note>` protocol to the user

### Hybrid capture behavior in v0.6.x

- Explicit durable remember intent writes a concise native note and a matching registry memory when the model emits `<memory_note>`
- Explicit ephemeral remember intent writes to the daily note and stays out of the durable registry by default
- Codex App checkpoints write native-only session summaries, decisions, open loops, touched files, and durable candidates into the daily log of the shared standalone store by default
- Codex App checkpoints are not background capture; they are intentional task-end summaries that later feed native sync and optional promotion
- If the user clearly asked to remember something but the model forgets the internal tag, Gigabrain now queues a review row instead of silently losing the request

## Recall

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

## Orchestrator and world model

```json
{
  "orchestrator": {
    "defaultStrategy": "auto",
    "allowDeepLookup": true,
    "deepLookupRequires": ["source_request", "exact_date", "exact_wording", "low_confidence_no_brief"],
    "profileFirst": true,
    "entityLockEnabled": true,
    "strategyRerankEnabled": true
  },
  "worldModel": {
    "enabled": true,
    "entityKinds": ["person", "project", "organization", "place", "topic"],
    "surfaceEntityKinds": ["person", "project", "organization"],
    "topicEntities": {
      "mode": "strict_hidden",
      "exportToSurface": false
    },
    "customSlotRules": [],
    "hostTrust": {}
  },
  "synthesis": {
    "enabled": true,
    "briefing": {
      "enabled": true,
      "includeSessionPrelude": true
    }
  }
}
```

- The orchestrator chooses a profile-first recall path and only allows deep lookup for source/date/wording verification or true low-confidence-no-brief cases
- The world model projects atomic memories into internal entities, beliefs, episodes, contradictions, and syntheses without replacing the underlying registry
- Syntheses generate reusable briefs for recall, current state, what changed, and session-start context

### `worldModel.customSlotRules`

Generic detectors already recognise common claim slots (relationship, location, role, preference, decision, birthday, identity). `customSlotRules` lets a deployment add durable slots for its own projects, people, or domain terms instead of hardcoding them. Each rule maps a regex over the memory text to a slot and is applied **before** the generic detectors, so a custom rule always wins for text it matches. Defaults to `[]` (generic detectors only). Invalid regexes are skipped rather than thrown.

| Field | Required | Purpose |
| --- | --- | --- |
| `pattern` | yes | Regex matched against the memory content |
| `flags` | no | Regex flags (default `i`) |
| `slot` | yes | Dotted slot id, e.g. `project.apollo.status` |
| `topic` | no | Coarse topic used by recall reranking |
| `subtopic` | no | Finer label within the topic |
| `value` | no | Fixed normalized value; omit to summarise the matched text |
| `operation` | no | `update` (default) or `remember` |

```json
{
  "worldModel": {
    "customSlotRules": [
      { "pattern": "acme rocket project", "slot": "project.acme.status", "topic": "project", "subtopic": "status" },
      { "pattern": "prefers oxford commas", "slot": "preference.style.oxford", "topic": "preference", "subtopic": "style", "value": "oxford_comma:true" }
    ]
  }
}
```

### `worldModel.hostTrust`

When two agents write contradictory beliefs into the same claim slot, the winner is chosen by **confidence + recency + host trust**. `hostTrust` assigns each source host a trust weight in `[0, 1]` (default `0.5` = neutral; unlisted hosts stay neutral). Trust is a **tie-breaker, not a veto**: it maps to a bounded `[-0.1, +0.1]` score term — large enough that a high-trust source outranks a *fresher* low-trust belief (the cross-agent drift / memory-poisoning fix), but smaller than any substantial confidence gap, so a clearly better-supported belief still wins regardless of host. This mirrors the per-host trust applied at ingest, so the same signal flows from capture into belief resolution. Defaults to `{}` (no trust weighting; scoring is unchanged).

```json
{
  "worldModel": {
    "hostTrust": {
      "codex": 0.8,
      "claude_code": 0.8,
      "cursor": 0.6,
      "chatgpt_manual": 0.4
    }
  }
}
```

## Dedupe

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

## LLM (optional)

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

## Native sync

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

## Native promotion

```json
{
  "nativePromotion": {
    "enabled": true,
    "promoteFromDaily": true,
    "promoteFromMemoryMd": true,
    "minConfidence": 0.72
  }
}
```

Native promotion turns durable native bullets back into structured registry memories with provenance (`source_layer`, `source_path`, `source_line`). This keeps OpenClaw-style native memory first-class while still giving Gigabrain structured recall, dedupe, and archive behavior.

## Obsidian surface

```json
{
  "vault": {
    "enabled": true,
    "path": "obsidian-vault",
    "subdir": "Gigabrain",
    "clean": true,
    "homeNoteName": "Home",
    "exportActiveNodes": false,
    "exportRecentArchivesLimit": 200,
    "manualFolders": ["Inbox", "Manual"],
    "views": { "enabled": true },
    "reports": { "enabled": true }
  }
}
```

See [docs/obsidian.md](obsidian.md) for full surface details and setup.

## Quality

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

## Architecture note

`v0.6.x` keeps the memory architecture intentionally simple:

- native markdown (`MEMORY.md`, daily notes, curated files) is the human-readable source layer
- SQLite is the operational registry, projection, and query layer
- FTS5 is an in-database lexical accelerator for active registry recall
- there is no separate vector database requirement for core capture, nightly maintenance, or plugin recall

This means changing a local LLM or embedding model does not break the core write/recall path. Optional LLM profiles help with review and extraction quality, but native writes, SQLite indexing, and orchestrated recall still work in deterministic mode.
