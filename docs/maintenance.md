# Nightly Maintenance

Gigabrain runs a full maintenance pipeline via the `nightly` command.

## Pipeline steps

```
snapshot -> native_sync -> quality_sweep -> exact_dedupe -> semantic_dedupe ->
audit_delta -> archive_compression -> vacuum -> metrics_report -> vault_build -> graph_build
```

## Artifacts

Each nightly run produces:

| Artifact | Description |
|----------|-------------|
| `output/nightly-execution-YYYY-MM-DD.json` | Full execution log with step timings |
| `output/memory-kept-YYYY-MM-DD.md` | Memories retained after quality sweep |
| `output/memory-archived-or-killed-YYYY-MM-DD.md` | Memories archived or rejected |
| `output/memory-review-queue.jsonl` | Items queued for manual review |
| `output/vault-build-YYYY-MM-DD.md` | Vault surface build summary |
| `output/memory-surface-summary.json` | Aggregate memory surface stats |

## Concurrency protection

The `nightly` CLI protects itself with an output-scoped lock, clears stale dead-owner locks, and verifies the execution artifact plus usage log before returning success. If another nightly run is already active, it returns a clean JSON skip instead of overlapping maintenance work.

## FTS5 refresh

During nightly maintenance Gigabrain also refreshes the registry FTS5 table after `VACUUM`, so active-memory lexical recall stays aligned with the current SQLite projection.

## Scheduling

For OpenClaw users, nightly maintenance is managed through OpenClaw cron jobs. For standalone users, schedule `npx gigabrainctl nightly --config <path>` via your preferred scheduler (cron, launchd, systemd timer).

## Manual maintenance

```bash
# Run full nightly pipeline
npx gigabrainctl nightly --config <config-path>

# Run maintenance only (no audit apply)
npx gigabrainctl maintain --config <config-path>

# Dry-run audit
npx gigabrainctl audit --mode shadow --config <config-path>
```

See [`openclaw.plugin.json`](../openclaw.plugin.json) for the complete schema with all defaults.
