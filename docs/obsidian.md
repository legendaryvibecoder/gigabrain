# Obsidian Memory Surface

Gigabrain does not require Obsidian for core capture/recall, but you do need Obsidian if you want the visual memory surface introduced in `v0.6.x`.

## Overview

The default `v0.6.x` surface is intentionally curated. When enabled, Gigabrain builds a read-only Obsidian memory surface under `<vault.path>/<vault.subdir>` with:

- `00 Home/Home.md`
- `30 Views/Current State.md`
- `30 Views/What Changed.md`
- `30 Views/Important People.md`
- `30 Views/Important Projects.md`
- `30 Views/Native Notes.md`
- `50 Briefings/Session Brief.md`

Large diagnostic exports, raw review queues, and broad entity dumps are not part of the default curated surface.

## Vault structure

- `10 Native/` — mirrored `MEMORY.md`, daily/session notes, and curated native files
- `20 Entities/` — people, project, organization, and place pages generated from the world model
- `20 Nodes/active/` — one note per active registry memory with provenance fields like `source_layer`, `source_path`, and `source_line`
- `30 Views/` — dashboards such as Active Memories, Relationships, Review Queue, Recent Archives, Native Sources, Promoted Memories, Registry-only Memories, People, Projects, Open Loops, Contradictions, Current Beliefs, Stale Beliefs, and What Changed
- `40 Reviews/` — generated contradiction/open-loop review artifacts
- `50 Briefings/` — session and nightly briefing notes
- `60 Reports/` — deeper synthesis reports such as contradiction/open-loop summaries
- `40 Reports/` — manifest, freshness, latest nightly/native-sync summaries, and the latest vault build summary

`Inbox/` and `Manual/` are reserved human-written folders inside the generated subdir and are never cleaned. The surface is intentionally read-only from Obsidian in `v0.6.x`: the runtime workspace remains the source of truth, and local sync is a one-way pull.

## Quickstart

1. Run `npm run setup -- --workspace /path/to/workspace` or enable `vault.enabled=true` manually.
2. Open the generated folder `<workspace>/obsidian-vault/Gigabrain` in Obsidian.
3. Start in `00 Home/Home.md`, then inspect `10 Native/`, `20 Entities/`, `20 Nodes/active/`, `30 Views/`, and `50 Briefings/`.
4. On a second machine, use `vault pull` and open the pulled `Gigabrain` folder in Obsidian locally.

If you have almost no native notes or remembered facts yet, the initial vault will mostly contain the shell, reports, and empty views. That is expected.

## Pull workflow (multi-machine)

1. Build or refresh the surface on the runtime machine: `npm run vault`
2. Pull it to your laptop: `npm run vault:pull -- --host nimbus --remote-path /path/to/obsidian-vault --target ~/Documents/gigabrainvault`
3. Open `~/Documents/gigabrainvault/Gigabrain` in Obsidian

## Configuration

```json
{
  "vault": {
    "enabled": true,
    "path": "obsidian-vault",
    "subdir": "Gigabrain",
    "clean": true,
    "homeNoteName": "Home",
    "exportActiveNodes": false,
    "exportRecentArchivesLimit": 200,
    "manualFolders": ["Inbox", "Manual"],
    "views": { "enabled": true },
    "reports": { "enabled": true }
  }
}
```

## CLI commands

```bash
# Build the Obsidian memory surface
node scripts/gigabrainctl.js vault build --config ~/.openclaw/openclaw.json

# Inspect freshness and manual-folder health
node scripts/gigabrainctl.js vault doctor --config ~/.openclaw/openclaw.json

# Print the latest surface summary
node scripts/gigabrainctl.js vault report --config ~/.openclaw/openclaw.json

# Pull the generated surface from a remote host to a local vault root
node scripts/gigabrainctl.js vault pull \
  --host memory-host \
  --remote-path /path/to/obsidian-vault \
  --target ~/Documents/gigabrainvault
```
