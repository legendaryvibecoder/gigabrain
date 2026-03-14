# Gigabrain

Gigabrain is a local-first memory stack for [OpenClaw](https://openclaw.ai) agents, Codex App, Codex CLI, Claude Code, and Claude Desktop workflows. It converts conversations and native notes into durable, queryable memory, then injects or serves the right context before each prompt so agents stay consistent across sessions.

It is built for local-first production use: SQLite-backed recall, deterministic dedupe/audit flows, native markdown sync, and an optional FastAPI console for memory operations.

Release references:

- Changelog: [`CHANGELOG.md`](CHANGELOG.md)
- `v0.5.3` release notes: [`release-notes/v0.5.3.md`](release-notes/v0.5.3.md)
- `v0.5.2` release notes: [`release-notes/v0.5.2.md`](release-notes/v0.5.2.md)
- `v0.5.1` release notes: [`release-notes/v0.5.1.md`](release-notes/v0.5.1.md)

## Supported clients

| Host surface | Best starting point | What Gigabrain owns | What the host owns |
| --- | --- | --- | --- |
| OpenClaw | `openclaw plugins install @legendaryvibecoder/gigabrain` + `npm run setup -- --workspace ...` | Local registry, native sync, recall orchestration, audit/nightly flows, memory-slot provider | Gateway runtime, channels, agent execution, plugin loading |
| Codex App / Codex CLI | `npx gigabrain-codex-setup --project-root ...` | Shared local project/user memory store, MCP tools, explicit checkpoints, maintenance/doctor flows | App/CLI UX, MCP client wiring, session execution |
| Claude Code | `npx gigabrain-claude-setup --project-root ...` | Shared local project/user memory store, MCP tools, explicit checkpoints, managed `.mcp.json` wiring | `CLAUDE.md` loading, project instructions, Claude Code runtime behavior |
| Claude Desktop | `npm run claude:desktop:bundle` for local testing, `npm run claude:desktop:bundle:release` for portable release assets | Same local MCP-backed memory store and tools as Claude Code | Desktop extension hosting, native app/chat UX, Claude account memory |
| Claude Desktop Cowork | Compatibility-audited via the same repo/store | Same local memory layer when pointed at the same repo/config | Cowork orchestration and app control, with no documented memory across sessions |

## Quickstart

### I use OpenClaw

```bash
openclaw plugins install @legendaryvibecoder/gigabrain
cd ~/.openclaw/extensions/gigabrain
npm run setup -- --workspace /path/to/your-openclaw-workspace
npx gigabrainctl doctor --config ~/.openclaw/openclaw.json
```

Sharing by default: OpenClaw is its own plugin path and does not silently share standalone Codex/Claude memory.

### I use Codex

```bash
npm install @legendaryvibecoder/gigabrain
npx gigabrain-codex-setup --project-root /path/to/repo
.codex/actions/verify-gigabrain.sh
```

Sharing by default: Codex uses the shared standalone store at `~/.gigabrain/config.json` on fresh installs and shares memory with Claude only when both point at the same config.

### I use Claude Code / Claude Desktop

```bash
npm install @legendaryvibecoder/gigabrain
npx gigabrain-claude-setup --project-root /path/to/repo
.claude/actions/verify-gigabrain.sh
```

Optional Claude Desktop step:

```bash
npm run claude:desktop:bundle
```

Sharing by default: Claude uses the same shared standalone store as Codex only when both point at the same config. Cowork is compatibility-audited only.

If you need more detail, jump to:

- [Option A: OpenClaw npm install + setup wizard](#option-a-openclaw-npm-install--setup-wizard-recommended-for-openclaw)
- [Option C: Codex App + Codex CLI](#option-c-codex-app--codex-cli-standalone-no-openclaw-required)
- [Option D: Claude Code + Claude Desktop](#option-d-claude-code--claude-desktop-standalone-no-openclaw-required)

## How sharing works

| Mode | Default path | What is shared | What stays isolated |
| --- | --- | --- | --- |
| OpenClaw plugin | `~/.openclaw/openclaw.json` + plugin-managed paths | Nothing automatically with standalone hosts | OpenClaw plugin runtime and memory config |
| Codex shared standalone | `~/.gigabrain/config.json` | Shared standalone registry + shared user store with Claude when they point at the same config | Repo memory stays separated by `project:<repo>:<hash>` scope |
| Claude shared standalone | `~/.gigabrain/config.json` | Same standalone registry + same user store with Codex when they point at the same config | Repo memory stays separated by `project:<repo>:<hash>` scope |
| Project-local standalone | `<repo>/.gigabrain/config.json` | Nothing outside the repo unless you explicitly reuse that config elsewhere | Repo store and user overlay stay local to that repo |

## What it does

- **Capture**: Uses a hybrid memory model where explicit remember intent writes durable memory and Codex App checkpoints write episodic native session logs
- **Recall**: Before each prompt, the recall orchestrator chooses between quick context, entity briefs, timeline briefs, and verification-oriented recall
- **Standalone MCP**: Exposes explicit `gigabrain_recall`, `gigabrain_remember`, `gigabrain_checkpoint`, `gigabrain_provenance`, `gigabrain_recent`, and `gigabrain_doctor` tools for Codex App, Codex CLI, Claude Code, and Claude Desktop
- **Dedupe**: Exact and hybrid semantic deduplication catches duplicates, paraphrases, and malformed near-duplicates with type-aware thresholds
- **Native sync**: Indexes your workspace `MEMORY.md` and daily notes alongside the registry for unified recall
- **World model**: Projects atomic memories into entities, beliefs, episodes, open loops, contradictions, and syntheses that can power better recall and review
- **Obsidian surface**: Builds a structured vault with native files, active memory nodes, entity pages, briefings, reports, and views so your agent can expose memory clearly in Obsidian and sync it to another machine
- **Person service**: Tracks entity mentions across memories for person-aware retrieval ordering
- **Quality gate**: Junk filters, durable-personal retention bias, plausibility heuristics, and optional LLM second opinion keep memory clean without losing important relationship context
- **Audit**: Nightly maintenance with snapshots, execution artifacts, archive reports, review queue retention, and quality scoring
- **Web console**: Optional FastAPI dashboard for browsing, editing, and managing memories

## Prerequisites

- **Node.js** >= 22.x (uses `node:sqlite` experimental API)
- **OpenClaw** >= 2026.2.15 (gateway + plugin loader, only required for the OpenClaw plugin path)
- **Python** >= 3.10 (only for the optional web console)
- **Ollama** (optional, for local LLM-based extraction review and semantic search)
- **Obsidian** (recommended for the `v0.5.x` memory surface; core capture/recall still works without it)

## Installation

If you are here for Codex App, Codex CLI, Claude Code, or Claude Desktop, skip the OpenClaw setup and jump straight to the standalone options below. OpenClaw is only required for the plugin path.

### Option A: OpenClaw npm install + setup wizard (recommended for OpenClaw)

Install:

```bash
openclaw plugins install @legendaryvibecoder/gigabrain
cd ~/.openclaw/extensions/gigabrain
```

Run the one-command setup wizard:

```bash
npm run setup -- --workspace /path/to/your-openclaw-workspace
```

The wizard is safe to rerun. If your OpenClaw config is stale, partial, or comes from older Gigabrain docs, rerun the wizard first and use doctor immediately after.

What the setup wizard does:

- Ensures `plugins.entries.gigabrain` exists in `~/.openclaw/openclaw.json`
- Sets `plugins.slots.memory = "gigabrain"` so OpenClaw uses Gigabrain as the active memory provider
- Sets runtime paths (`workspaceRoot`, `memoryRoot`, `outputDir`, `registryPath`)
- Enables the `v0.5.1` hybrid memory defaults for explicit remember intent, native promotion, and world-model-aware surfaces
- Bootstraps the DB and indexes native memory files
- Enables the Obsidian memory surface by default and builds the first vault unless `--skip-vault`
- Adds or refreshes the AGENTS memory protocol block (unless `--skip-agents`)
- Restarts gateway (unless `--skip-restart`)

Recommended follow-up after setup:

1. Install Obsidian if you want the `v0.5` memory surface.
2. Open `<workspace>/obsidian-vault/Gigabrain`.
3. Start at `00 Home/Home.md`.
4. If the vault looks sparse at first, that is normal: Gigabrain only shows memories that already exist in native notes or the registry.

Verify the install:

```bash
npx gigabrainctl doctor --config ~/.openclaw/openclaw.json
```

Wizard help:

```bash
npm run setup -- --help
```

Useful setup flags:

```bash
npm run setup -- --workspace /path/to/workspace --vault-path ~/Documents/gigabrainvault
npm run setup -- --workspace /path/to/workspace --skip-vault
```

If doctor reports config drift or stale paths, rerun the setup wizard before editing `openclaw.json` manually.

### Option B: OpenClaw manual setup (custom environments)

1. Install from source:

```bash
git clone https://github.com/legendaryvibecoder/gigabrain.git
openclaw plugins install -l /absolute/path/to/gigabrain
```

2. Register plugin in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "slots": {
      "memory": "gigabrain"
    },
    "entries": {
      "gigabrain": {
        "config": {
          "enabled": true
        }
      }
    }
  }
}
```

`plugins.slots.memory = "gigabrain"` is the important part that tells OpenClaw to use Gigabrain as the active memory-slot provider.

Notes:

- Recent OpenClaw builds discover third-party plugins from `~/.openclaw/extensions` or linked paths in `plugins.load.paths`, not from `~/.openclaw/plugins/node_modules`.
- Do not add `plugins.entries.gigabrain.path` manually unless your OpenClaw build explicitly documents that key.

3. Restart gateway:

```bash
openclaw gateway restart
```

4. Run migration once:

```bash
node scripts/migrate-v3.js --apply --config ~/.openclaw/openclaw.json
```

5. Verify the resulting config:

```bash
npx gigabrainctl doctor --config ~/.openclaw/openclaw.json
```

### Option C: Codex App + Codex CLI (standalone, no OpenClaw required)

Install Gigabrain into your repo or workspace:

```bash
npm install @legendaryvibecoder/gigabrain
```

Bootstrap Codex wiring for the current repo. Fresh installs use the host-neutral shared standalone store under `~/.gigabrain/`, keep the shared personal user store under `~/.gigabrain/profile/`, and derive a stable repo-specific scope for the current workspace. If you already have a supported legacy install under `~/.codex/gigabrain/`, setup reuses it in place for `0.5.3`:

```bash
npx gigabrain-codex-setup --project-root /path/to/repo
```

The Codex setup is safe to rerun and is the recommended repair path for stale standalone configs.

What the Codex setup does:

- Creates `~/.gigabrain/config.json` for the shared standalone store by default, or reuses `~/.codex/gigabrain/config.json` when a legacy standalone install already exists
- Bootstraps both the shared standalone store and its shared user store (`~/.gigabrain/profile/` on fresh installs), including `MEMORY.md`, `memory/registry.sqlite`, and output folders
- Adds a Codex-specific `AGENTS.md` block that prefers Gigabrain MCP tools over ad-hoc file grepping
- Creates repo-local `.codex/setup.sh` plus `.codex/actions/` helper scripts for install, verify, maintenance, and manual session checkpointing
- Teaches the current repo a stable repo scope so its continuity stays separated inside the shared standalone store by default
- Migrates older Codex configs that still have an empty `codex.userProfilePath`, legacy `codex:global` project scope defaults, or a recall order that skips the user store
- Prints the resolved config path, store root, sharing mode, and whether the path is canonical or legacy-supported

What gets shared by default:

- Codex and Claude share the same standalone registry only when they point at the same config path.
- Repo memory still stays repo-scoped by default through `project:<repo>:<hash>`.
- Personal memory is shared through the user store.
- Use `--store-mode project-local` if you want this repo isolated.

Then register the MCP server in Codex:

```bash
codex mcp add gigabrain -- /absolute/path/to/node /absolute/path/to/node_modules/@legendaryvibecoder/gigabrain/scripts/gigabrain-mcp.js --config ~/.gigabrain/config.json
```

Useful Codex commands after setup:

```bash
npx gigabrain-codex-setup --project-root /path/to/repo
npx gigabrain-codex-checkpoint --config ~/.gigabrain/config.json --summary "Implemented the MCP server"
npx gigabrainctl doctor --config ~/.gigabrain/config.json --target both
npx gigabrainctl maintain --config ~/.gigabrain/config.json
```

Standalone Codex defaults in `v0.5.1`:

- `llm.provider = "none"`
- `llm.review.enabled = false`
- `vault.enabled = false`
- `codex.projectStorePath = ~/.gigabrain`
- `codex.userProfilePath = ~/.gigabrain/profile`
- `codex.defaultProjectScope = project:<repo>:<hash>`
- `codex.recallOrder = ["project", "user", "remote"]`

Codex App behavior in `v0.5.1`:

- Codex App works through MCP, not through undocumented internal Codex state.
- `gigabrain_remember` with `target=user` is for stable personal preferences and facts that should follow you across repos.
- `gigabrain_remember` with `target=project` is for repo-specific decisions, conventions, and active project context.
- `gigabrain_checkpoint` is for task-end session capture into `~/.gigabrain/memory/YYYY-MM-DD.md` by default on fresh standalone installs.
- `gigabrain_checkpoint` remains repo-scoped by default and uses the derived `project:<repo>:<hash>` scope for the current workspace.
- `gigabrainctl maintain` is a manual consolidation step when you want promotion and cleanup.
- There is no hidden Nimbus-style background logging in Codex App mode.

Recommended Codex install and verify flow:

1. Run `npx gigabrain-codex-setup --project-root /path/to/repo`.
2. Run the printed `codex mcp add gigabrain ...` command, or use `.codex/actions/install-gigabrain-mcp.sh`.
3. Run `.codex/actions/verify-gigabrain.sh` first. Absolute fallback: `npx gigabrainctl doctor --config ~/.gigabrain/config.json --target both`.
4. In Codex, use `gigabrain_doctor` if you want to confirm that both the repo store and the personal user store are healthy from the MCP side as well.

Upgrading older Codex installs:

- Re-run `npx gigabrain-codex-setup --project-root /path/to/repo`.
- The setup rerun preserves existing project memory but migrates stale standalone defaults so the user store is configured, repo scope becomes the default project scope, and recall order becomes `project,user,remote`.

If you prefer strict per-repo storage, you can opt in explicitly:

```bash
npx gigabrain-codex-setup --project-root /path/to/repo --store-mode project-local
```

That keeps the store under `/path/to/repo/.gigabrain/`, places the personal user store under `/path/to/repo/.gigabrain/profile/`, and adds `.gigabrain/` to the repo `.gitignore`.

Troubleshooting:

- If `gigabrain_doctor` or `gigabrain_remember target=user` reports `target store 'user' is not configured`, re-run `npx gigabrain-codex-setup --project-root /path/to/repo` so the standalone config is migrated to the current defaults.
- Prefer `.codex/actions/verify-gigabrain.sh` over memorizing raw paths; it already targets the resolved config for this repo.
- If you want to inspect only the user store, run `npx gigabrainctl doctor --config ~/.gigabrain/config.json --target user`.
- If you want to inspect only the repo store, run `npx gigabrainctl doctor --config ~/.gigabrain/config.json --target project`.

### Option D: Claude Code + Claude Desktop (standalone, no OpenClaw required)

Install Gigabrain into your repo or workspace:

```bash
npm install @legendaryvibecoder/gigabrain
```

Bootstrap Claude wiring for the current repo. Fresh installs use the same shared standalone store as Codex under `~/.gigabrain/`, keep the shared personal user store under `~/.gigabrain/profile/`, and derive the same stable repo-specific scope. If you already have a supported legacy install under `~/.codex/gigabrain/`, setup reuses it in place for `0.5.3`:

```bash
npx gigabrain-claude-setup --project-root /path/to/repo
```

The Claude setup is safe to rerun. If `CLAUDE.md`, `.mcp.json`, or the shared standalone config drift over time, rerun setup first and then run doctor.

What the Claude setup does:

- Uses `~/.gigabrain/config.json` as the canonical shared standalone config for fresh installs, or reuses `~/.codex/gigabrain/config.json` when a legacy standalone install already exists
- Bootstraps both the shared standalone store and its shared user store (`~/.gigabrain/profile/` on fresh installs), including `MEMORY.md`, `memory/registry.sqlite`, and output folders
- Adds or refreshes a managed Gigabrain memory block inside `CLAUDE.md`
- Adds or refreshes a `gigabrain` server entry inside project `.mcp.json`
- Creates repo-local `.claude/setup.sh` plus `.claude/actions/` helper scripts for verify, maintenance, and manual session checkpointing
- Preserves existing `CLAUDE.md` content and unrelated `.mcp.json` server entries on rerun
- Prints the resolved config path, store root, sharing mode, and whether the path is canonical or legacy-supported

What gets shared by default:

- Claude and Codex share the same standalone registry only when they point at the same config path.
- Repo memory still stays repo-scoped by default through `project:<repo>:<hash>`.
- Personal memory is shared through the user store.
- Use `--store-mode project-local` if you want this repo isolated.

Useful Claude commands after setup:

```bash
npx gigabrain-claude-setup --project-root /path/to/repo
npx gigabrain-codex-checkpoint --config ~/.gigabrain/config.json --summary "Implemented the Claude workflow"
npx gigabrainctl doctor --config ~/.gigabrain/config.json --target both
npx gigabrainctl maintain --config ~/.gigabrain/config.json
npm run claude:desktop:bundle
```

Claude Code behavior:

- Claude Code reads the local Gigabrain MCP server from `.mcp.json`
- `CLAUDE.md` teaches Claude how to use `gigabrain_recall`, `gigabrain_remember`, `gigabrain_checkpoint`, and `gigabrain_provenance`
- The Claude path uses the same shared project/user memory model as the Codex standalone path
- There is still no hidden background capture; checkpoints stay explicit and task-end driven

Claude Desktop behavior:

- `npm run claude:desktop:bundle` builds a local test `.dxt` bundle under `dist/claude-desktop/` with an absolute config default for the current machine
- `npm run claude:desktop:bundle:release` builds a portable release `.dxt` bundle with `~/.gigabrain/config.json` as the default config path
- The bundle wraps the same Gigabrain stdio MCP server used by Claude Code
- The desktop extension uses the same Gigabrain MCP server and standalone config contract as Claude Code

### Claude memory surfaces vs Gigabrain

Claude now has multiple memory/instruction surfaces, and `v0.5.3` treats them as complementary rather than interchangeable:

- **Claude Desktop account/chat memory**: Anthropic’s own memory for supported plans and clients. Gigabrain does not read, import, or synchronize those memories.
- **Claude Code memory**: Claude Code loads `CLAUDE.md` and related local instruction files. Gigabrain integrates with that by managing a Gigabrain block and exposing MCP tools, but it does not replace Claude Code’s own instruction loading.
- **Claude Desktop Cowork**: Anthropic currently documents no memory across Cowork sessions. Gigabrain can still be used as the local memory layer if Cowork is operating in the same repo/config environment, but Cowork itself is not a first-class Gigabrain-native integration in `v0.5.3`.
- **Gigabrain**: explicit, local-first project/user memory across hosts, with checkpoints, provenance, recall orchestration, maintenance, and a shared local store.

Recommended stance:

- Leave Claude native memory on if you want Claude’s own account-level personalization.
- Use Gigabrain for durable repo/project continuity, explicit remembered facts, checkpoints, provenance, and shared local stores across Codex/Claude/OpenClaw surfaces.
- Do not assume Claude’s native memory and Gigabrain are deduplicated or synchronized with each other.

Recommended Claude install and verify flow:

1. Run `npx gigabrain-claude-setup --project-root /path/to/repo`.
2. Review `CLAUDE.md` and `.mcp.json` in the repo.
3. Run `.claude/actions/verify-gigabrain.sh` first. Absolute fallback: `npx gigabrainctl doctor --config ~/.gigabrain/config.json --target both`.
4. Build the desktop bundle with `npm run claude:desktop:bundle` for local testing, or `npm run claude:desktop:bundle:release` for a portable release asset.
5. In Claude Desktop on macOS, open Settings > Extensions > Advanced settings > Install Extension and import the generated `.dxt` file.
6. If Claude asks for a config path, use the resolved path from setup. On fresh installs that is usually `~/.gigabrain/config.json`; legacy standalone installs may still use `~/.codex/gigabrain/config.json`.
7. Use `.claude/actions/checkpoint-gigabrain-session.sh --summary "..."` after meaningful work if you want episodic session capture.

Cowork note:

- Cowork is compatibility-audited for the same repo/config path, but `v0.5.3` does not claim a dedicated Cowork memory integration.
- If you use Cowork and want durable continuity, keep Gigabrain configured in the same repo and rely on the shared local store rather than expecting Cowork session memory.

## Upgrade / existing users

- **OpenClaw users from older Gigabrain docs**: move to `openclaw plugins install @legendaryvibecoder/gigabrain`, rerun `npm run setup -- --workspace ...`, then run `npx gigabrainctl doctor --config ~/.openclaw/openclaw.json`.
- **Codex `0.5.1` / `0.5.2` users**: rerun `npx gigabrain-codex-setup --project-root /path/to/repo` to refresh the shared standalone defaults, verify helper scripts, and doctor path. Existing `~/.codex/gigabrain` installs remain supported in place for `0.5.3`.
- **Claude adopters**: run `npx gigabrain-claude-setup --project-root /path/to/repo`, review `CLAUDE.md` and `.mcp.json`, then run doctor before building the desktop extension.

Across all hosts, the expected upgrade order is:

1. Re-run setup for the host surface you use.
2. Run doctor or the generated verify script.
3. Only then troubleshoot custom config by hand if something still looks wrong.

## Configuration

OpenClaw mode keeps config under `plugins.entries.gigabrain.config` in `openclaw.json`. Codex and Claude standalone modes store the same schema in `~/.gigabrain/config.json` by default for fresh installs, reuse `~/.codex/gigabrain/config.json` when a supported legacy standalone install already exists, or use `<repo>/.gigabrain/config.json` when you opt into `--store-mode project-local`. The full OpenClaw plugin schema is defined in [`openclaw.plugin.json`](openclaw.plugin.json). Key sections:

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

Hybrid capture behavior in `v0.5.1`:

- Explicit durable remember intent writes a concise native note and a matching registry memory when the model emits `<memory_note>`
- Explicit ephemeral remember intent writes to the daily note and stays out of the durable registry by default
- Codex App checkpoints write native-only session summaries, decisions, open loops, touched files, and durable candidates into the daily log of the shared standalone store by default
- Codex App checkpoints are not background capture; they are intentional task-end summaries that later feed native sync and optional promotion
- If the user clearly asked to remember something but the model forgets the internal tag, Gigabrain now queues a review row instead of silently losing the request

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

### Orchestrator and world model

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
    }
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

### Architecture note

`v0.5` keeps the memory architecture intentionally simple:

- native markdown (`MEMORY.md`, daily notes, curated files) is the human-readable source layer
- SQLite is the operational registry, projection, and query layer
- FTS5 is an in-database lexical accelerator for active registry recall
- there is no separate vector database requirement for core capture, nightly maintenance, or plugin recall

This means changing a local LLM or embedding model does not break the core write/recall path. Optional LLM profiles help with review and extraction quality, but native writes, SQLite indexing, and orchestrated recall still work in deterministic mode.

### Native promotion

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

### Obsidian surface (recommended in `v0.5`)

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

Gigabrain does not require Obsidian for core capture/recall, but you do need Obsidian if you want the visual memory surface introduced in `v0.5.x`.

The default `v0.5.x` surface is intentionally curated. When enabled, Gigabrain builds a read-only Obsidian memory surface under `<vault.path>/<vault.subdir>` with:

- `00 Home/Home.md`
- `30 Views/Current State.md`
- `30 Views/What Changed.md`
- `30 Views/Important People.md`
- `30 Views/Important Projects.md`
- `30 Views/Native Notes.md`
- `50 Briefings/Session Brief.md`

Large diagnostic exports, raw review queues, and broad entity dumps are not part of the default curated surface.
- `10 Native/` mirrored `MEMORY.md`, daily/session notes, and curated native files
- `20 Entities/` people, project, organization, and place pages generated from the world model
- `20 Nodes/active/` one note per active registry memory with provenance fields like `source_layer`, `source_path`, and `source_line`
- `30 Views/` dashboards such as Active Memories, Relationships, Review Queue, Recent Archives, Native Sources, Promoted Memories, Registry-only Memories, People, Projects, Open Loops, Contradictions, Current Beliefs, Stale Beliefs, and What Changed
- `40 Reviews/` generated contradiction/open-loop review artifacts
- `50 Briefings/` session and nightly briefing notes
- `60 Reports/` deeper synthesis reports such as contradiction/open-loop summaries
- `40 Reports/` manifest, freshness, latest nightly/native-sync summaries, and the latest vault build summary

`Inbox/` and `Manual/` are reserved human-written folders inside the generated subdir and are never cleaned. The surface is intentionally read-only from Obsidian in `v0.5.1`: the runtime workspace remains the source of truth, and local sync is a one-way pull.

Quickstart:

1. Run `npm run setup -- --workspace /path/to/workspace` or enable `vault.enabled=true` manually.
2. Open the generated folder `<workspace>/obsidian-vault/Gigabrain` in Obsidian.
3. Start in `00 Home/Home.md`, then inspect `10 Native/`, `20 Entities/`, `20 Nodes/active/`, `30 Views/`, and `50 Briefings/`.
4. On a second machine, use `vault pull` and open the pulled `Gigabrain` folder in Obsidian locally.

If you have almost no native notes or remembered facts yet, the initial vault will mostly contain the shell, reports, and empty views. That is expected.

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

`snapshot -> native_sync -> quality_sweep -> exact_dedupe -> semantic_dedupe -> audit_delta -> archive_compression -> vacuum -> metrics_report -> vault_build -> graph_build`

Important artifacts written by the run:

- `output/nightly-execution-YYYY-MM-DD.json`
- `output/memory-kept-YYYY-MM-DD.md`
- `output/memory-archived-or-killed-YYYY-MM-DD.md`
- `output/memory-review-queue.jsonl`
- `output/vault-build-YYYY-MM-DD.md`
- `output/memory-surface-summary.json`

The `nightly` CLI now protects itself with an output-scoped lock, clears stale dead-owner locks, and verifies the execution artifact plus usage log before returning success. If another nightly run is already active, it returns a clean JSON skip instead of overlapping maintenance work.

During nightly maintenance Gigabrain also refreshes the registry FTS5 table after `VACUUM`, so active-memory lexical recall stays aligned with the current SQLite projection.

See [`openclaw.plugin.json`](openclaw.plugin.json) for the complete schema with all defaults.

## First-time setup details

Migration creates the core SQLite schema (`memory_events`, `memory_current`, `memory_native_chunks`, `memory_entity_mentions`, optional `memory_fts`, and world-model tables when enabled) and backfills events from any existing data.

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

Gigabrain uses a hybrid memory model.

- Native markdown (`MEMORY.md` and `memory/YYYY-MM-DD.md`) is the human-readable layer.
- The Gigabrain registry is the structured recall layer built on top.
- In Codex App and Claude standalone mode, the shared store usually lives under `~/.gigabrain/` on fresh installs, while `~/.codex/gigabrain/` remains supported for legacy setups.
- Use `gigabrain_recall` first for continuity in Codex App sessions, usually with the repo-specific scope your setup generated for this workspace.
- Use `gigabrain_remember` only for explicit durable saves.
- Use `gigabrain_checkpoint` at task end after substantial implementation, debugging, planning, or compaction-style summaries.
- Do not grep Gigabrain store files directly unless the MCP server is unavailable.

### Memory Note Protocol
Gigabrain is native-memory-first. For users, the important behavior is:

- `MEMORY.md` is the curated durable layer
- `memory/YYYY-MM-DD.md` is the daily native layer
- explicit "remember that" moments project into native memory and the structured registry
- Codex App task-end checkpoints project to the daily native layer only
- the user never needs to know the internal XML protocol

Internally, explicit remembers still use `<memory_note>` tags for compatibility and structured capture.

When the user does NOT explicitly ask to save memory:
- Do NOT emit `<memory_note>` tags.
- Normal conversation does not trigger memory capture.

Never include secrets, credentials, tokens, or API keys in memory notes.
```

### How recall works

Before each prompt, Gigabrain:

1. **Sanitizes the user query** — strips prior `<gigabrain-context>` blocks, metadata lines, bootstrap injections, and markdown noise to extract the real question
2. **Entity coreference resolution** — detects pronoun follow-ups (e.g. "was weisst du noch über sie?") and enriches the query with the entity from prior messages in the conversation
3. Uses the recall orchestrator to choose between quick context, entity brief, timeline brief, relationship brief, or verification-oriented recall
4. Searches the SQLite registry and native markdown files (`MEMORY.md`, daily notes) for the right supporting context behind that strategy
5. **Recall hygiene** — strips persisted recall artifacts and transcript-style control lines out of native recall so old `<gigabrain-context>`, `query:`, `Source:`, or `user:` / `assistant:` lines do not feed back into future answers
6. **Entity answer quality scoring** — for "who is" / "wer ist" queries, penalizes instruction-like memories ("Add to profile: ...") and boosts direct factual content
7. **Deduplication** — removes duplicate memories by normalized content before ranking
8. **Temporal safety** — older memories that say `today` / `heute` / `currently` are marked with their recorded date instead of being treated as if they refer to the current day
9. **World-model synthesis** — where possible, prefers entity/timeline syntheses over raw snippet piles
10. Applies class budgets (core / situational / decisions) and token limits
11. Injects the results as a system message placed before the last user message in the conversation, without exposing internal provenance like file paths or memory ids

The agent doesn't need to do anything special for recall — it happens automatically via the gateway plugin hooks.

If you also use OpenClaw's separate `memory_search` / `memory_get` tools, note that their visible `Source:` behavior is controlled by OpenClaw's own `memory.citations` setting, not by Gigabrain.

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

# Rebuild world-model projections
node scripts/gigabrainctl.js world rebuild --config ~/.openclaw/openclaw.json

# Explain recall strategy selection for a query
node scripts/gigabrainctl.js orchestrator explain --query "Who is Liz?" --config ~/.openclaw/openclaw.json

# Rebuild or inspect synthesis artifacts
node scripts/gigabrainctl.js synthesis build --config ~/.openclaw/openclaw.json
node scripts/gigabrainctl.js synthesis list --config ~/.openclaw/openclaw.json

# Inspect open loops / contradictions
node scripts/gigabrainctl.js review open-loops --config ~/.openclaw/openclaw.json
node scripts/gigabrainctl.js review contradictions --config ~/.openclaw/openclaw.json

# Build the Obsidian memory surface
node scripts/gigabrainctl.js vault build --config ~/.openclaw/openclaw.json

# Inspect freshness and manual-folder health
node scripts/gigabrainctl.js vault doctor --config ~/.openclaw/openclaw.json

# Print the latest surface summary
node scripts/gigabrainctl.js vault report --config ~/.openclaw/openclaw.json

# Pull the generated surface from a remote host to a local vault root
node scripts/gigabrainctl.js vault pull \
  --host memory-host \
  --remote-path /path/to/obsidian-vault \
  --target ~/Documents/gigabrainvault

# Compatibility helper for a direct build
node scripts/vault-export.js --config ~/.openclaw/openclaw.json
```

`nightly --help` is safe and prints usage instead of starting a real run.

All commands are also available as npm scripts: `npm run setup`, `npm run nightly`, `npm run maintain`, `npm run vault`, `npm run vault:doctor`, `npm run vault:report`, `npm run vault:pull`, `npm run vault:export`, etc.

Practical local-Obsidian flow:

1. Build or refresh the surface on the runtime machine: `npm run vault`
2. Pull it to your laptop: `npm run vault:pull -- --host nimbus --remote-path /path/to/obsidian-vault --target ~/Documents/gigabrainvault`
3. Open `~/Documents/gigabrainvault/Gigabrain` in Obsidian

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

Features: dual-surface landing view with vault freshness and review/archive summaries, memory browser with search/filter, concept deduplication view, audit queue, document store, profile viewer, and knowledge graph visualization.

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

The default suite includes 29 executable tests covering config validation, policy rules, capture service, memory actions, orchestrator behavior, projection store FTS behavior, person service, world-model behavior, LLM routing, native-sync query handling, vault surface generation and pull, OpenClaw setup wizard behavior, Codex and Claude standalone setup flows, packaged-install setup smokes, Claude Desktop bundle packaging, audit maintenance, vault CLI, migration, bridge routes, native recall, regression behavior, and nightly performance.

Release validation can go further with:

- `npm run test:release-live` for live Codex CLI registration and live OpenClaw install/setup checks on a machine that has both CLIs installed
- `npm run eval:deep-recall` for the expanded recall-routing evaluation used when the core recall stack changes

## Contributing

External contributions are welcome.

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a PR.
- Use Issues for concrete bugs or scoped feature requests.
- Use Discussions for design questions, product ideas, or usage help.
- Please avoid posting secrets, private paths, or personal runtime artifacts in issues or PRs.

If you want to propose a bigger memory-behavior change, open a discussion first. Small, well-tested PRs are much easier to review.

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
│   ├── vault-mirror.js         # Obsidian memory surface builder + pull workflow
│   ├── http-routes.js          # Gateway HTTP endpoints
│   ├── review-queue.js         # Capture and audit review queue retention
│   └── metrics.js              # Telemetry counters
│
├── scripts/                    # CLI tools
│   ├── gigabrainctl.js         # Main control plane
│   ├── migrate-v3.js           # Schema migration
│   ├── harmonize-memory.js     # Memory harmonization
│   └── vault-export.js         # Direct vault surface build helper
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

Please do not open public issues for vulnerabilities. Use the private reporting flow in [SECURITY.md](SECURITY.md).

## License

MIT License. See LICENSE file for details.
