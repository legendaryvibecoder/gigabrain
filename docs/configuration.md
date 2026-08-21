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

### Hybrid capture behavior

- Explicit durable remember intent writes a concise native note and a matching registry memory when the model emits `<memory_note>`
- Explicit ephemeral remember intent writes to the daily note and stays out of the durable registry by default
- Codex App checkpoints write native-only session summaries, decisions, open loops, touched files, and durable candidates into the daily log of the shared standalone store by default
- Codex App checkpoints are not background capture; they are intentional task-end summaries that later feed native sync and optional promotion
- If the user clearly asked to remember something but the model forgets the internal tag, Gigabrain now queues a review row instead of silently losing the request

## Recall

```json
{
  "recall": {
    "autoInjectEnabled": false,
    "topK": 8,
    "maxTokens": 1200,
    "mode": "hybrid",
    "relevanceFloor": {
      "minMatchedTokens": 2,
      "denseCosine": 0.65
    }
  }
}
```

- `autoInjectEnabled` — default `false`; agents recall on demand unless an operator deliberately enables always-on prompt injection
- `topK` — maximum memories injected per prompt
- `mode` — `personal_core` (identity-heavy), `project_context` (task-heavy), or `hybrid`
- `classBudgets` — budget split between core/situational/decisions (must sum to 1.0)
- `semanticRerankEnabled` — **default `true` (U14)**: recall fuses the lexical FTS5 ranking with a dense bge-m3 cosine ranking (weighted Borda-count rank aggregation) over embeddings cached in `memory_embeddings`; capture's embedding-kNN neighbor selection reads the same flag. Degrades silently to lexical-only when Ollama is unreachable or no embeddings are cached — no crash, no log spam. Set to `false` for strictly lexical recall.
- `crossEncoderRerankEnabled` — default `false`: seam for a cross-encoder rerank over the fused candidate set; currently an identity passthrough until a measured experiment wires a model in.
- `ollamaUrl` / `embeddingModel` / `embeddingTimeoutMs` — dense-leg embedding endpoint (loopback-only, port 11434 enforced), model (`bge-m3`), and per-call timeout
- `relevanceFloor.minMatchedTokens` — default `2` for queries with at least four informative tokens; short queries require one token
- `relevanceFloor.denseCosine` — default `0.65`; a sufficiently strong dense match may pass without the lexical minimum
- Recall never performs native sync, projection rebuild, or maintenance. Run those write paths explicitly.
- Local HTTP recall defaults an omitted scope to `shared`. An explicit `project:*` scope is exact and excludes shared and profile rows; an explicit `profile:*` scope is the intentional personal-memory path.

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
      "includeSessionPrelude": false
    }
  }
}
```

- The orchestrator chooses a profile-first recall path and only allows deep lookup for source/date/wording verification or true low-confidence-no-brief cases
- The world model projects atomic memories into internal entities, beliefs, episodes, contradictions, and syntheses without replacing the underlying registry
- Syntheses generate reusable briefs for explicit recall and current-state views. Set `includeSessionPrelude` to `true` only when always-on session context is an intentional deployment choice.

### `worldModel.enabled`

Clean toggle for the entity, belief, and contradiction projection layer. It defaults to `true`. Setting it to `false` skips world-model rebuilds and makes world-model-backed surfaces return empty results without breaking capture or recall. Deterministic belief arbitration remains available in either mode.

### `worldModel.customSlotRules`

Generic detectors already recognise common claim slots (relationship, location, role, preference, decision, birthday, identity). `customSlotRules` lets a deployment add durable slots for its own projects, people, or domain terms instead of hardcoding them. Each rule maps a regex over the memory text to a slot and is applied **before** the generic detectors, so a custom rule always wins for text it matches. Defaults to `[]` (generic detectors only). Invalid regexes are skipped rather than thrown.

Slot detection also applies to **entity-less, user-anchored facts** ("The user …" / first person): such rows are projected onto a synthetic, arbitration-only `user:self` entity so the arbiter can adjudicate implicit rivals about the user. A built-in mode-level topic lexicon covers the canonical personal-fact life domains: transport mode, work-location mode, residence (dwelling/tenure — city facts stay in the value-typed `location.current_city` slot), employment, device platform, subscription service, health regimen, financial obligations (per-obligation slots: mortgage, auto loan, student loan, banking — each loan is its own exclusive state), relationship status, education program, pet companion, exercise routine, diet pattern, and hobby activity. Every lexicon alternative names a domain noun (employer, landlord, prescription, mortgage, …), never a bare verb, and noun-demanding domains match before the broader verb-led ones, so unrelated facts cannot acquire a life-domain slot. Domain-grouped facts only arbitrate when some row carries an explicit state-change or incapacity cue ("sold", "switched", "no longer", "upgraded to", "paid off", "relocated", "surgery", …) — co-facts about one domain (a second hobby, an additional device) are never superseded, and even then only the single most-similar rival position is superseded (spared co-facts stay active and surface for review). The synthetic entity is never written to `memory_entities`, so entity surfaces and briefs are unaffected. `customSlotRules` still extends coverage to deployment-specific domains without code.

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

### `worldModel.arbiter`

Robustness knobs for the deterministic arbitration rule (**trust tier > corroboration > recency**). All defenses work offline — no LLM or network is required.

| Key | Default | Purpose |
| --- | --- | --- |
| `clusterThreshold` | `0.55` | Token-set similarity at or above which two claim values within a slot merge into one position (paraphrase clustering). Values with a negation mismatch or differing numeric tokens never merge. `1` restricts merging to containment/identical values. |
| `clusterLlmRefinement` | `false` | Opt-in local-LLM refinement of the deterministic clusters. OFF by default; the deterministic path is the tested path. |
| `recencyAmbiguityWindowMs` | `300000` (5 min) | Recency comparisons treat assertion times within this window as EQUAL. At equal tier and support inside the window, the conflict is ambiguous and surfaces for review instead of being auto-resolved by millisecond ordering (clock-skew defense). |
| `independenceWindowMs` | `600000` (10 min) | Near-identical text from the same host inside this window counts as ONE corroboration witness (sock-puppet burst defense). |
| `supportCapPerSource` | `1` | Maximum corroboration witnesses a single `(source_host, source_kind)` pair can contribute to a position — one writable surface can never out-vote independent stores. |

### `agentRegistry` (top level)

`source_agent` is free text in rival stores and therefore a sock-puppet vector. The arbiter only lets an agent identity carry its host's trust tier when the identity is **registered**: built-in host-family names (exact match — prefix variants like `codex_fake9000` do not vouch), any key pinned in `hostTrust`, or an entry in this list. Unregistered agents cap at the unknown trust floor. Defaults to `[]`.

```json
{
  "agentRegistry": ["fleet-worker-1", "fleet-worker-2"]
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

`ollama` is the local-first default. If you configure a networked `openai_compatible` or `openclaw` endpoint, treat it as a separate data processor: use TLS, protect credentials, and review the endpoint's retention policy. Gigabrain's transcript pipeline permits raw-transcript extraction only through a local provider or an explicitly injected local hook. Cloud audit review skips credential-risk rows, masks supported credential/email/IP/home-user-path shapes locally, and sends no original scope; it still cannot prove that every sensitive phrase was detected.

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

## Optional local imports

```json
{
  "native": {
    "cloudInbox": {
      "enabled": false,
      "dir": "~/.gigabrain/cloud-inbox",
      "staleDays": 30
    },
    "transcripts": {
      "enabled": false,
      "globs": [
        "~/.codex/sessions/**/*.jsonl",
        "~/.claude/projects/**/*.jsonl"
      ],
      "maxFiles": 50,
      "maxTurns": 200
    }
  }
}
```

Both importers are off by default. `cloudInbox` reads files you deliberately place in its local directory; it does not connect to a cloud account. `transcripts` reads bounded local session files and should be enabled only after you review the configured paths and the privacy implications. Neither option uploads data or silently synchronizes another computer.

## Node HTTP authentication

The OpenClaw plugin resolves its `/gb` route token from `runtime.apiToken`, the OpenClaw gateway token, or `GB_UI_TOKEN`, in that order. Without a token, data routes are not registered by default.

`GB_ALLOW_NO_AUTH=1` is a dangerous development-only exception. When it is set and no token is configured, Node route-level authentication is bypassed and a warning is logged. Use it only for a disposable loopback process; never expose that mode to a LAN, tailnet, reverse proxy, or the public internet. The Python console always requires `GB_UI_TOKEN` or `GB_UI_SCOPE_TOKENS` and does not honor this bypass.

## Remote bridge

```json
{
  "remoteBridge": {
    "enabled": false,
    "baseUrl": "",
    "authToken": "",
    "timeoutMs": 8000
  }
}
```

The optional bridge adds an authenticated remote recall source; it is off by default and does not merge databases. Use an HTTPS endpoint you control, keep `authToken` out of source control, and apply the same least-privilege and retention rules you would use for any service that can read memory content. Export/import remains the simpler option for occasional transfer between machines.

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

## Obsidian integration

```json
{
  "native": {
    "vaults": [
      { "path": "~/Notes/example-vault", "glob": "**/*.md", "maxFileKB": 512 }
    ]
  }
}
```

This is the supported read-only reference leg: vault notes can inform recall but
never become Gigabrain beliefs.

The separate findings inbox is a narrow, append-only write to one
Gigabrain-owned note and is disabled by default:

```json
{
  "vault": {
    "inbox": {
      "enabled": true,
      "apiUrl": "https://127.0.0.1:27124",
      "notePath": "GigaBrain/Findings.md",
      "apiKeyPath": "~/.config/obsidian-local-rest-api/key",
      "caPath": "~/.config/obsidian-local-rest-api/cert.pem",
      "maxFindings": 20
    }
  }
}
```

The broad generated-vault export surface is retired. See
[docs/obsidian.md](obsidian.md) for the exact direction, trust and TLS boundaries.

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

## Telemetry counters (opt-in, local-only)

```json
{
  "telemetry": {
    "countersEnabled": false
  }
}
```

- `countersEnabled` — **default `false`**. When `true`, Gigabrain keeps a small local counters file (`<outputDir>/gigabrain-counters.json`) tracking five plain event counts: `audit_runs`, `watch_runs`, `new_findings_surfaced`, `verdicts_applied` (derived from recorded arbiter verdicts on the ledger, including reinstatements), and `hook_installs`.
- The counters are **counts only** — no memory content, no memory ids, no hostnames, no reconciliation metadata ever appears in the file or its export. This is a hard rule (schema-asserted in the test suite), per the project telemetry policy.
- **Nothing auto-uploads.** The only way counters leave the file is `gigabrainctl watch --export-counters`, which prints them to stdout for you to share (or not).

## Architecture note

The current architecture keeps the core memory path intentionally simple:

- native markdown (`MEMORY.md`, daily notes, curated files) is the human-readable source layer
- SQLite is the operational registry, projection, and query layer
- FTS5 is the in-database lexical accelerator; optional locally generated embeddings can add semantic reranking
- there is no separate vector database requirement for core capture, nightly maintenance, or plugin recall

This means changing a local LLM or embedding model does not break the core write/recall path. Optional LLM profiles help with review and extraction quality, but native writes, SQLite indexing, and orchestrated recall still work in deterministic mode.
