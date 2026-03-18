# Claude Code + Claude Desktop Setup Guide

Standalone setup for Gigabrain with Claude Code and Claude Desktop. No OpenClaw required.

## Install

```bash
npm install @legendaryvibecoder/gigabrain
```

## Bootstrap

Bootstrap Claude wiring for the current repo. Fresh installs use the same shared standalone store as Codex under `~/.gigabrain/`, keep the shared personal user store under `~/.gigabrain/profile/`, and derive the same stable repo-specific scope. If you already have a supported legacy install under `~/.codex/gigabrain/`, setup reuses it in place for `0.6.1`:

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

## Claude memory surfaces vs Gigabrain

Claude now has multiple memory/instruction surfaces, and `v0.6.x` treats them as complementary rather than interchangeable:

- **Claude Desktop account/chat memory**: Anthropic's own memory for supported plans and clients. Gigabrain does not read, import, or synchronize those memories.
- **Claude Code memory**: Claude Code loads `CLAUDE.md` and related local instruction files. Gigabrain integrates with that by managing a Gigabrain block and exposing MCP tools, but it does not replace Claude Code's own instruction loading.
- **Claude Desktop Cowork**: Anthropic currently documents no memory across Cowork sessions. Gigabrain can still be used as the local memory layer if Cowork is operating in the same repo/config environment, but Cowork itself is not a first-class Gigabrain-native integration in `v0.6.x`.
- **Gigabrain**: explicit, local-first project/user memory across hosts, with checkpoints, provenance, recall orchestration, maintenance, and a shared local store.

### Recommended stance

- Leave Claude native memory on if you want Claude's own account-level personalization.
- Use Gigabrain for durable repo/project continuity, explicit remembered facts, checkpoints, provenance, and shared local stores across Codex/Claude/OpenClaw surfaces.
- Do not assume Claude's native memory and Gigabrain are deduplicated or synchronized with each other.

## Cowork note

- Cowork is compatibility-audited for the same repo/config path, but `v0.6.x` does not claim a dedicated Cowork memory integration.
- If you use Cowork and want durable continuity, keep Gigabrain configured in the same repo and rely on the shared local store rather than expecting Cowork session memory.

## Upgrading

Run `npx gigabrain-claude-setup --project-root /path/to/repo`, review `CLAUDE.md` and `.mcp.json`, then run doctor before building the desktop extension.
