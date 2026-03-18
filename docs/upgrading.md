# Upgrading

## Per-client upgrade paths

### OpenClaw users (from older Gigabrain docs)

Move to `openclaw plugins install @legendaryvibecoder/gigabrain`, rerun `npm run setup -- --workspace ...`, then run `npx gigabrainctl doctor --config ~/.openclaw/openclaw.json`.

### Codex v0.5.1 / v0.5.2 users

Re-run `npx gigabrain-codex-setup --project-root /path/to/repo` to refresh the shared standalone defaults, verify helper scripts, and doctor path. Existing `~/.codex/gigabrain` installs remain supported in place for `0.6.1`.

### Claude adopters

Run `npx gigabrain-claude-setup --project-root /path/to/repo`, review `CLAUDE.md` and `.mcp.json`, then run doctor before building the desktop extension.

## Expected upgrade order (all hosts)

1. Re-run setup for the host surface you use.
2. Run doctor or the generated verify script.
3. Only then troubleshoot custom config by hand if something still looks wrong.

## What setup reruns do

- Preserve existing project memory and user store data
- Migrate stale standalone defaults (user store paths, recall order, project scope)
- Refresh helper scripts and agent instruction blocks
- Print the resolved config path, store root, and sharing mode
