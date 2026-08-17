# Claude Code + Claude Desktop Setup Guide

Claude Code/Desktop can use the standalone Gigabrain store over MCP; native Claude auto-memory files are a separate, machine-local layer and are imported read-only when visible.

Standalone setup for Gigabrain with Claude Code and Claude Desktop. No OpenClaw required.

## Install

```bash
npm install @legendaryvibecoder/gigabrain
```

## Bootstrap

Bootstrap Claude wiring for the current repo. Fresh installs use the same standalone path as Codex under `~/.gigabrain/`, keep the personal user store under `~/.gigabrain/profile/`, and derive the same stable repo-specific scope. A supported legacy install under `~/.codex/gigabrain/` is reused in place:

```bash
npx gigabrain-claude-setup --project-root /path/to/repo
```

The Claude setup is safe to rerun. If `CLAUDE.md`, `.mcp.json`, or the shared standalone config drift over time, rerun setup first and then run doctor.

### What the Claude setup does

- Uses `~/.gigabrain/config.json` as the canonical shared standalone config for fresh installs, or reuses `~/.codex/gigabrain/config.json` when a legacy standalone install already exists
- Bootstraps both the shared standalone store and its shared user store (`~/.gigabrain/profile/` on fresh installs), including `MEMORY.md`, `memory/registry.sqlite`, and output folders
- Adds or refreshes a managed Gigabrain memory block inside `CLAUDE.md`
- Adds or refreshes a `gigabrain` server entry inside project `.mcp.json`
- Creates repo-local `.claude/setup.sh` plus `.claude/actions/` helper scripts for verify, maintenance, MCP launch, and manual session checkpointing
- Preserves existing `CLAUDE.md` content and unrelated `.mcp.json` server entries on rerun
- Prints the resolved config path, store root, sharing mode, and whether the path is canonical or legacy-supported
- Writes helper scripts that resolve Gigabrain dynamically from repo-local `node_modules/.bin`, `command -v`, or `npx --no-install` instead of depending on the original install temp path

### What gets shared by default

- Claude and Codex share the same standalone registry only when they point at the same config path.
- Repo memory still stays repo-scoped by default through `project:<repo>:<hash>`.
- Personal memory is shared through the user store.
- Use `--store-mode project-local` if you want this repo isolated.

## Useful commands after setup

```bash
npx gigabrain-claude-setup --project-root /path/to/repo
npx gigabrain-codex-checkpoint --config ~/.gigabrain/config.json --summary "Implemented the Claude workflow"
npx gigabrainctl doctor --config ~/.gigabrain/config.json --target both
npx gigabrainctl maintain --config ~/.gigabrain/config.json
npm run claude:desktop:bundle
```

## Claude Code behavior

- Claude Code reads the local Gigabrain MCP server from `.mcp.json`
- `CLAUDE.md` teaches Claude how to use `gigabrain_recall`, `gigabrain_remember`, `gigabrain_checkpoint`, and `gigabrain_provenance`
- The Claude path uses the same shared project/user memory model as the Codex standalone path
- `gigabrain_checkpoint` writes an immutable episode. Any durable candidates remain reviewable claims until an authorized decision promotes them.
- `gigabrain_checkpoint_list` and `gigabrain_checkpoint_get` provide exact episode enumeration when semantic recall is not complete enough.
- There is still no hidden background capture; checkpoints stay explicit and task-end driven

## Claude Desktop behavior

- `npm run claude:desktop:bundle` builds a local test `.dxt` bundle under `dist/claude-desktop/` with an absolute config default for the current machine
- `npm run claude:desktop:bundle:release` builds a portable release `.dxt` bundle with `~/.gigabrain/config.json` as the default config path
- The bundle wraps the same Gigabrain stdio MCP server used by Claude Code
- The desktop extension now launches through a bundled shell launcher that prepends common macOS/Homebrew PATH entries before `exec node`, instead of assuming Finder can resolve `node` correctly on its own
- The desktop extension uses the same Gigabrain MCP server and standalone config contract as Claude Code

## Recommended install and verify flow

1. Run `npx gigabrain-claude-setup --project-root /path/to/repo`.
2. Review `CLAUDE.md` and `.mcp.json` in the repo.
3. Run `.claude/actions/verify-gigabrain.sh` first. Absolute fallback: `npx gigabrainctl doctor --config ~/.gigabrain/config.json --target both`.
4. Build the desktop bundle with `npm run claude:desktop:bundle` for local testing, or `npm run claude:desktop:bundle:release` for a portable release asset.
5. In Claude Desktop on macOS, open Settings > Extensions > Advanced settings > Install Extension and import the generated `.dxt` file.
6. If Claude asks for a config path, use the resolved path from setup. On fresh installs that is usually `~/.gigabrain/config.json`; legacy standalone installs may still use `~/.codex/gigabrain/config.json`.
7. Use `.claude/actions/checkpoint-gigabrain-session.sh --summary "..."` after meaningful work if you want episodic session capture.

## Using Gigabrain across multiple agents

Claude Code, Codex, and other local agents can share Gigabrain when they point at the same standalone config, usually `~/.gigabrain/config.json`.

```bash
npx gigabrain-codex-setup --project-root /path/to/repo
npx gigabrain-claude-setup --project-root /path/to/repo
npx gigabrainctl sync-hosts --config ~/.gigabrain/config.json --host codex,claude_code,cursor,windsurf
npx gigabrainctl sync-hosts status --config ~/.gigabrain/config.json
```

Use `sync-hosts sources --include-discovery` to inspect visible local host memories before or after sync. Claude Code memories are read from `~/.claude/projects/*/memory/` when present; Codex memories are read from `~/.codex/memories/` when that folder exists.

Manual cloud-product imports are always explicit and local:

```bash
npx gigabrainctl sync-hosts --config ~/.gigabrain/config.json \
  --manual-import ./claude-export.md \
  --manual-source-host claude_manual
```

Gigabrain does not scrape ChatGPT, Claude.ai, Gemini, or Microsoft Copilot memory. Manual imports remain explicit. For approved live access from Claude or ChatGPT, use the separate self-hosted [Remote MCP](setup-remote-mcp.md) profile; it does not synchronize native account memory.

## Claude memory surfaces vs Gigabrain

Claude has multiple memory/instruction surfaces. Treat them as complementary rather than interchangeable:

- **Claude account memory**: hosted product memory is outside Gigabrain's local import boundary.
- **Claude Code instructions**: `CLAUDE.md` and `.claude/rules/` provide required project guidance. Gigabrain setup manages only its marked integration block and preserves unrelated content.
- **Claude Code auto memory**: Claude writes project-scoped Markdown under its local project memory directory. Anthropic documents this as machine-local and not shared across machines or cloud environments. Gigabrain can import visible files read-only.
- **Gigabrain local**: explicit project/user memory across hosts, with immutable checkpoints, reviewed claim promotion, provenance, recall orchestration, maintenance, and a shared local store.
- **Gigabrain remote MCP**: an optional self-hosted, OAuth-protected `/mcp` endpoint for Claude web. It is read-only by default and does not synchronize Claude's native account memory.

### Recommended stance

- Leave Claude native memory on if you want Claude's own account-level personalization.
- Use Gigabrain for durable repo/project continuity, explicit remembered facts, checkpoints, provenance, and shared local stores across Codex/Claude/OpenClaw surfaces.
- Do not assume Claude's native memory and Gigabrain are deduplicated or synchronized with each other.
- Do not assume two machines share Claude or Gigabrain state because they use the same repo.

## Upgrading

Run `npx gigabrain-claude-setup --project-root /path/to/repo`, review `CLAUDE.md` and `.mcp.json`, then run doctor before building the desktop extension.
