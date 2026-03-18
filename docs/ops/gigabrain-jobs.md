# Gigabrain v3 Jobs (Source of Truth)

Production orchestration is cron-first and single-command:

- `node <repo>/scripts/gigabrainctl.js nightly --config $HOME/.openclaw/openclaw.json`
- No legacy wrapper scripts and no inline bash orchestration in cron payload.

## Active Jobs

| Job ID | Name | SLA | Owner | Command | Rollback |
|---|---|---|---|---|---|
| `<cron-id>` | `nightly-brain` | daily, finish < 20m | `<operator>` | `node <repo>/scripts/gigabrainctl.js nightly --config $HOME/.openclaw/openclaw.json` | restore pre-cutover snapshot + config backup, then restart gateway |
| `<cron-id>` | `harness-lab-daily` | non-prod | `<operator>` | unchanged, non-production | unchanged |

## Health Checks

- `openclaw cron list --all --json`
- `openclaw cron runs --id <cron-id> --limit 20`
- `node <repo>/scripts/gigabrainctl.js doctor --config $HOME/.openclaw/openclaw.json`
- `tail -n 200 <workspace>/memory/usage-log.md`
- `tail -n 200 <workspace>/output/memory-events.jsonl`
- `ls -lah <workspace>/output/memory-archived-or-killed-*.md | tail -n 5`
- `ls -lah <workspace>/output/memory-native-sync-*.md | tail -n 5`

## Agent Instruction Contract

- Nimbus-style operators should keep memory-note behavior explicit:
  - Use `skills/memory-note/SKILL.md` only for explicit "remember/save" user intents.
  - Keep normal replies free of `<memory_note>` tags.
- Workspace instruction precedence for memory behavior:
  1. `AGENTS.md` (operational and safety rules)
  2. `SOUL.md` (identity/tone only)
  3. Skill-specific instructions (`SKILL.md`)
- If instructions conflict, apply the stricter memory/safety rule and do not downgrade capture protections.
