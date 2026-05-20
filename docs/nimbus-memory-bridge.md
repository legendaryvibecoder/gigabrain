# Nimbus Memory Bridge Contract

Nimbus on Hermes uses a three-layer memory model:

| Layer | Role | Write policy |
| --- | --- | --- |
| `SOUL.md` | Identity, tone, boundaries, Nimbus continuity | Stable persona only |
| Hermes native memory | Small always-on hot cache loaded at session start | Routing hints and current runtime facts only |
| Gigabrain | Authoritative long-term and cross-agent memory control plane | Imported memories, checkpoints, provenance, project/user facts |

## Runtime Policy

- Recall from Gigabrain for personal, project, continuity, prior-work, migration, identity, and ops questions.
- Write `gigabrain_checkpoint` after substantial completed work.
- Write stable personal facts with `gigabrain_remember target=user`.
- Write project decisions and conventions with `gigabrain_remember target=project`.
- Keep Hermes native memory compact. Do not bulk-copy imported Nimbus/OpenClaw memories into `~/.hermes/memories/`.

## Sync Policy

Hermes native memory is indexed into Gigabrain read-only:

```bash
npx gigabrainctl sync-hosts \
  --config ~/.codex/gigabrain/config.json \
  --host hermes \
  --hermes-home ~/.hermes \
  --scope profile:nimbus
```

This makes Hermes' local hot-cache notes visible in Gigabrain without making Gigabrain rewrite Hermes' native files.

## Acceptance Checks

```bash
hermes mcp test gigabrain
hermes -z "Call gigabrain_recall with query '779443319 Telegram Nimbus' and answer with the first recalled memory content only."
npx gigabrainctl sync-hosts status --config ~/.codex/gigabrain/config.json
```

Expected state:

- Hermes MCP lists `gigabrain` with all tools enabled.
- The recall smoke returns a Nimbus backup memory such as the numeric Telegram chat id.
- `sync-hosts status` shows `hermes` and `openclaw` synced.
- Hermes `MEMORY.md` stays small and does not contain the bulk imported backup registry.
