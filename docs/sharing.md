# How Sharing Works

Gigabrain supports multiple sharing modes depending on your host surface and config paths.

## Sharing modes

| Mode | Default path | What is shared | What stays isolated |
| --- | --- | --- | --- |
| OpenClaw plugin | `~/.openclaw/openclaw.json` + plugin-managed paths | Nothing automatically with standalone hosts | OpenClaw plugin runtime and memory config |
| Codex shared standalone | `~/.gigabrain/config.json` | Shared standalone registry + shared user store with Claude when they point at the same config | Repo memory stays separated by `project:<repo>:<hash>` scope |
| Claude shared standalone | `~/.gigabrain/config.json` | Same standalone registry + same user store with Codex when they point at the same config | Repo memory stays separated by `project:<repo>:<hash>` scope |
| Project-local standalone | `<repo>/.gigabrain/config.json` | Nothing outside the repo unless you explicitly reuse that config elsewhere | Repo store and user overlay stay local to that repo |

## Key principles

- **OpenClaw is isolated by default**: The OpenClaw plugin path has its own config and does not silently share standalone Codex/Claude memory.
- **Codex + Claude share when pointed at the same config**: Fresh installs of both use `~/.gigabrain/config.json`, so they share the registry and user store.
- **Repo memory is always scoped**: Regardless of sharing mode, repo memory stays separated by `project:<repo>:<hash>`.
- **Personal memory follows the user store**: Both Codex and Claude read/write personal memory through the shared user store under `~/.gigabrain/profile/`.
- **Project-local is opt-in**: Use `--store-mode project-local` during setup for strict per-repo isolation.

## Scope rules

- **Private/main sessions** (direct chat): recall from all sources including `MEMORY.md` and private scopes
- **Shared contexts** (group chats, other users): only curated shared memories, never private data

Configure scope behavior in `openclaw.json` under the agent's memory settings.
