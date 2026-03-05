# Gigabrain Launch Hotfix Report (2026-03-05)

## Scope
- GitHub: `legendaryvibecoder/gigabrain`
- Nimbus live runtime: `/Users/Nimbus/runtime/clawd-live/projects/gigabrain`

## Forensics
- Snapshot + diff matrix generated on Nimbus:
  - `_launch_forensics/20260305-090943/DIFF_MATRIX.md`
- Compared files:
  - `index.ts`
  - `README.md`
  - `package.json`
  - `memory_api/requirements.txt`
  - `.gitignore`
  - `openclaw.plugin.json`

## Key Findings
- Nimbus runtime had drift from `origin/main` on:
  - `index.ts`
  - `README.md`
  - `package.json`
  - `memory_api/requirements.txt`
- `origin/main` already carried required launch baseline:
  - `license: MIT`
  - `README` link uses `https://openclaw.ai`
  - `lxml-html-clean==0.4.4`

## Implemented Hotfixes

### 1) Canonical sync
- Nimbus runtime plugin directory was backed up and replaced atomically from GitHub `origin/main`.
- Runtime parity verification (SHA-256) now matches `origin/main` for all audited files.
- Canonical runtime commit:
  - `origin/main`: `6ceec20694109d865cc04fbf1a0807ffe44ef0e9`

### 2) Config cleanup (`tools.allow`)
- Removed unknown entries causing warning noise:
  - `cron`
  - `gateway`
- Result: `tools.allow allowlist contains unknown entries` warning no longer appears in current post-fix window.

### 3) Subagent stability hardening
- Changed default subagent model from `codex` to `anthropic/claude-sonnet-4-6`.
- Removed `codex` from `nimbusmain.subagents.allowAgents` for launch window stability.

### 4) Provenance handling
- Ran `openclaw plugins install --link /Users/Nimbus/runtime/clawd-live/projects/gigabrain`.
- Post-fix `openclaw doctor` no longer reports the prior gigabrain provenance diagnostic.

### 5) Stage tag
- Created private staging tag on GitHub:
  - `v0.3.0-rc-private` -> `6ceec20694109d865cc04fbf1a0807ffe44ef0e9`

## Launch Gate Automation
- Added `scripts/launch-gate-check.sh`.
- Tracks blocker signals:
  - OAuth refresh 401
  - RPC probe failure
  - launchctl timeout restart
  - gigabrain error lines in `gateway.err.log` (time-windowed)
- Non-blocking warning:
  - Brave 429

## Current Gate Status
- Historical windows (24h/1h) still show pre-fix events and restart turbulence.
- Immediate post-fix slice (after `2026-03-05T08:14:30Z`) shows:
  - `tools_allow_unknown = 0`
  - `provenance_warn = 0`
  - `launchctl_timeout = 0`

## PR
- Reconcile PR: https://github.com/legendaryvibecoder/gigabrain/pull/8
- Note: merge is currently blocked by branch protection (required review/check workflow).
