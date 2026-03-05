# Gigabrain Launch Hotfix Report (2026-03-05)

## Scope
- GitHub: `legendaryvibecoder/gigabrain`
- Nimbus live runtime: `/Users/Nimbus/runtime/clawd-live/projects/gigabrain`

## Forensics
- Snapshot + diff matrix created under `_launch_forensics/<timestamp>/DIFF_MATRIX.md`
- Compared files: `index.ts`, `README.md`, `package.json`, `memory_api/requirements.txt`, `.gitignore`, `openclaw.plugin.json`

## Key Findings
- Nimbus runtime diverged from `origin/main` on `index.ts`, `README.md`, `package.json`, `memory_api/requirements.txt`.
- `origin/main` has required launch baseline:
  - `license: MIT`
  - `README` uses `https://openclaw.ai`
  - `lxml-html-clean==0.4.4`
- No hard Gigabrain stacktrace crashes seen in `gateway.err.log` during the audited window.

## Implemented Ops Guardrails
- Added `scripts/launch-gate-check.sh` for pragmatic launch gating.
- Gate blockers:
  - `oauth_refresh_401`
  - `rpc_probe_failed`
  - `launchctl_timeout`
  - gigabrain error lines in `gateway.err.log`
- Non-blocking warning:
  - `brave_429`

## Remaining Operational Risk (Known)
- Plugin provenance warning may persist depending on local plugin registration mode.
- If persistent, treat as launch exception only with explicit runtime SHA pinning and documentation.
