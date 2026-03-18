# Codex App + Codex CLI Setup Guide

Standalone setup for Gigabrain with Codex App and Codex CLI. No OpenClaw required.

## Install

```bash
npm install @legendaryvibecoder/gigabrain
```

## Bootstrap

Bootstrap Codex wiring for the current repo. Fresh installs use the host-neutral shared standalone store under `~/.gigabrain/`, keep the shared personal user store under `~/.gigabrain/profile/`, and derive a stable repo-specific scope for the current workspace. If you already have a supported legacy install under `~/.codex/gigabrain/`, setup reuses it in place for `0.6.1`:

```bash
npx gigabrain-codex-setup --project-root /path/to/repo
```

The Codex setup is safe to rerun and is the recommended repair path for stale standalone configs.

### What the Codex setup does

- Creates `~/.gigabrain/config.json` for the shared standalone store by default, or reuses `~/.codex/gigabrain/config.json` when a legacy standalone install already exists
- Bootstraps both the shared standalone store and its shared user store (`~/.gigabrain/profile/` on fresh installs), including `MEMORY.md`, `memory/registry.sqlite`, and output folders
- Adds a Codex-specific `AGENTS.md` block that prefers Gigabrain MCP tools over ad-hoc file grepping
- Creates repo-local `.codex/setup.sh` plus `.codex/actions/` helper scripts for install, verify, maintenance, MCP launch, and manual session checkpointing
- Teaches the current repo a stable repo scope so its continuity stays separated inside the shared standalone store by default
- Migrates older Codex configs that still have an empty `codex.userProfilePath`, legacy `codex:global` project scope defaults, or a recall order that skips the user store
- Prints the resolved config path, store root, sharing mode, and whether the path is canonical or legacy-supported
- Writes helper scripts that resolve Gigabrain dynamically from repo-local `node_modules/.bin`, `command -v`, or `npx --no-install` instead of depending on the original install temp path

### What gets shared by default

- Codex and Claude share the same standalone registry only when they point at the same config path.
- Repo memory still stays repo-scoped by default through `project:<repo>:<hash>`.
- Personal memory is shared through the user store.
- Use `--store-mode project-local` if you want this repo isolated.

## Register the MCP server

```bash
.codex/actions/install-gigabrain-mcp.sh
```

## Useful commands after setup

```bash
npx gigabrain-codex-setup --project-root /path/to/repo
npx gigabrain-codex-checkpoint --config ~/.gigabrain/config.json --summary "Implemented the MCP server"
npx gigabrainctl doctor --config ~/.gigabrain/config.json --target both
npx gigabrainctl maintain --config ~/.gigabrain/config.json
```

## Standalone Codex defaults in v0.6.1

- `llm.provider = "none"`
- `llm.review.enabled = false`
- `vault.enabled = false`
- `codex.projectStorePath = ~/.gigabrain`
- `codex.userProfilePath = ~/.gigabrain/profile`
- `codex.defaultProjectScope = project:<repo>:<hash>`
- `codex.recallOrder = ["project", "user", "remote"]`

## Codex App behavior in v0.6.1

- Codex App works through MCP, not through undocumented internal Codex state.
- `gigabrain_remember` with `target=user` is for stable personal preferences and facts that should follow you across repos.
- `gigabrain_remember` with `target=project` is for repo-specific decisions, conventions, and active project context.
- `gigabrain_checkpoint` is for task-end session capture into `~/.gigabrain/memory/YYYY-MM-DD.md` by default on fresh standalone installs.
- `gigabrain_checkpoint` remains repo-scoped by default and uses the derived `project:<repo>:<hash>` scope for the current workspace.
- `gigabrainctl maintain` is a manual consolidation step when you want promotion and cleanup.
- There is no hidden Nimbus-style background logging in Codex App mode.

## Recommended install and verify flow

1. Run `npx gigabrain-codex-setup --project-root /path/to/repo`.
2. Run `.codex/actions/install-gigabrain-mcp.sh`, or use the printed `codex mcp add gigabrain ...` command from setup.
3. Run `.codex/actions/verify-gigabrain.sh` first. Absolute fallback: `npx gigabrainctl doctor --config ~/.gigabrain/config.json --target both`.
4. In Codex, use `gigabrain_doctor` if you want to confirm that both the repo store and the personal user store are healthy from the MCP side as well.

## Project-local storage (opt-in)

If you prefer strict per-repo storage:

```bash
npx gigabrain-codex-setup --project-root /path/to/repo --store-mode project-local
```

That keeps the store under `/path/to/repo/.gigabrain/`, places the personal user store under `/path/to/repo/.gigabrain/profile/`, and adds `.gigabrain/` to the repo `.gitignore`.

## Troubleshooting

- If `gigabrain_doctor` or `gigabrain_remember target=user` reports `target store 'user' is not configured`, re-run `npx gigabrain-codex-setup --project-root /path/to/repo` so the standalone config is migrated to the current defaults.
- Prefer `.codex/actions/verify-gigabrain.sh` over memorizing raw paths; it already targets the resolved config for this repo.
- If you want to inspect only the user store, run `npx gigabrainctl doctor --config ~/.gigabrain/config.json --target user`.
- If you want to inspect only the repo store, run `npx gigabrainctl doctor --config ~/.gigabrain/config.json --target project`.

## Upgrading from v0.5.x

Re-run `npx gigabrain-codex-setup --project-root /path/to/repo` to refresh the shared standalone defaults, verify helper scripts, and doctor path. Existing `~/.codex/gigabrain` installs remain supported in place for `0.6.1`.
