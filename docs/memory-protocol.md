# Memory Protocol

How Gigabrain captures and stores memories through the agent's conversation.

## Memory notes (how capture works)

Gigabrain captures memories when the agent emits `<memory_note>` XML tags in its responses. By default, `requireMemoryNote` is `true`, so **only explicit tags trigger capture** — Gigabrain won't silently extract facts from normal conversation.

## Tag format

```xml
<memory_note type="USER_FACT" confidence="0.9">User prefers dark mode in all editors.</memory_note>
```

### Attributes

| Attribute | Required | Values |
|-----------|----------|--------|
| `type` | Yes | `USER_FACT`, `PREFERENCE`, `DECISION`, `ENTITY`, `EPISODE`, `AGENT_IDENTITY`, `CONTEXT` |
| `confidence` | No | `0.0`–`1.0`, or `high` / `medium` / `low` (default: `0.65`) |
| `scope` | No | Memory scope, e.g. `shared`, `profile:main` (default: from config) |

### Rules

- One fact per tag — keep it short and concrete
- No secrets, credentials, API keys, or tokens
- No system prompt wrappers or tool output envelopes
- Content must be at least 25 characters (configurable via `capture.minContentChars`)
- Content must not exceed 1200 characters
- Nested `<memory_note>` tags are rejected

## Agent instructions (AGENTS.md)

For the agent to emit memory notes correctly, you need instructions in your workspace `AGENTS.md` (or equivalent instruction file).

- If you used the setup wizard, this block is added automatically (unless `--skip-agents`).
- If you used manual setup, add it yourself.

### Minimal example

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
