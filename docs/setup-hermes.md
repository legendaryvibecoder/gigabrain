# Hermes Setup

Gigabrain connects to Hermes through a standard stdio MCP server. Hermes keeps its built-in `~/.hermes/memories` active, while Gigabrain provides the shared cross-agent store, provenance, Passport reports, and OpenClaw/Nimbus backup imports.

For Nimbus, use the [Nimbus Memory Bridge Contract](nimbus-memory-bridge.md): Hermes native memory stays a compact hot cache, while Gigabrain is the authoritative long-term memory control plane.

## Install

```bash
npm install @legendaryvibecoder/gigabrain
```

Use the same standalone config as Codex or Claude when you want all agents to share one local memory control plane:

```bash
npx gigabrain-hermes-setup \
  --config ~/.gigabrain/config.json \
  --workspace-root /path/to/workspace
```

For older Codex-first installs, `~/.codex/gigabrain/config.json` remains supported:

```bash
npx gigabrain-hermes-setup \
  --config ~/.codex/gigabrain/config.json \
  --workspace-root /path/to/workspace
```

The setup command prints the exact Hermes MCP command. To install and verify in one step:

```bash
npx gigabrain-hermes-setup \
  --config ~/.gigabrain/config.json \
  --workspace-root /path/to/workspace \
  --install \
  --test
hermes gateway restart
```

Equivalent manual command:

```bash
hermes mcp add gigabrain \
  --env \
    GIGABRAIN_CONFIG=~/.gigabrain/config.json \
    GIGABRAIN_MODE=standalone \
    GIGABRAIN_WORKSPACE_ROOT=/path/to/workspace \
  --command node \
  --args "$(npm root -g)/@legendaryvibecoder/gigabrain/scripts/gigabrain-mcp.js"
hermes mcp test gigabrain
hermes gateway restart
```

## Nimbus/OpenClaw Backup Import

Import legacy OpenClaw/Gigabrain `registry.sqlite` files explicitly. Start with a dry-run:

```bash
npx gigabrainctl import-openclaw \
  --config ~/.gigabrain/config.json \
  --registry /path/to/backup/clawd/memory/registry.sqlite \
  --memory-root /path/to/backup/clawd/memory \
  --source-host openclaw \
  --source-label nimbus-backup-2026-02-12 \
  --dry-run
```

If the counts match the expected backup, remove `--dry-run` to apply. The importer preserves memory ids where possible, scope, status, confidence, tags, timestamps, pinned markers, supersession metadata, source links, and legacy evidence snippets.

## Hermes Local Memory Sync

Hermes built-in memory files can also be indexed read-only:

```bash
npx gigabrainctl sync-hosts \
  --config ~/.gigabrain/config.json \
  --host hermes \
  --hermes-home ~/.hermes
```

This imports readable text files from `~/.hermes/memories/` as `source_host=hermes`, `source_kind=native_memory`, and `sync_policy=read_only`. It does not mutate Hermes memory files.

## Runtime Guidance

Add a short instruction to Hermes/Nimbus so it actually uses the MCP tools:

```markdown
For personal, project, continuity, prior-work, migration, identity, and ops questions, call Gigabrain MCP recall first. After substantial completed work, write a Gigabrain checkpoint. Treat Hermes built-in memory as a compact hot cache and Gigabrain as the shared long-term memory control plane.
```

Do not bulk-copy Gigabrain memories back into `~/.hermes/memories/`; use `sync-hosts --host hermes` to index Hermes native memory into Gigabrain read-only.

## Verify

```bash
hermes mcp test gigabrain
hermes -z "Use gigabrain_doctor and summarize whether project and user stores are healthy"
npx gigabrainctl doctor --config ~/.gigabrain/config.json --target both
npx gigabrainctl sync-hosts status --config ~/.gigabrain/config.json
hermes -z "Call gigabrain_recall with query '779443319 Telegram Nimbus' and answer with the first recalled memory content only."
```
