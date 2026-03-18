# OpenClaw Setup Guide

Full setup instructions for running Gigabrain as an OpenClaw plugin.

## Option A: npm install + setup wizard (recommended)

Install:

```bash
openclaw plugins install @legendaryvibecoder/gigabrain
cd ~/.openclaw/extensions/gigabrain
```

Run the one-command setup wizard:

```bash
npm run setup -- --workspace /path/to/your-openclaw-workspace
```

The wizard is safe to rerun. If your OpenClaw config is stale, partial, or comes from older Gigabrain docs, rerun the wizard first and use doctor immediately after.

### What the setup wizard does

- Ensures `plugins.entries.gigabrain` exists in `~/.openclaw/openclaw.json`
- Sets `plugins.slots.memory = "gigabrain"` so OpenClaw uses Gigabrain as the active memory provider
- Sets runtime paths (`workspaceRoot`, `memoryRoot`, `outputDir`, `registryPath`)
- Enables the `v0.6.x` hybrid memory defaults for explicit remember intent, native promotion, and world-model-aware surfaces
- Bootstraps the DB and indexes native memory files
- Enables the Obsidian memory surface by default and builds the first vault unless `--skip-vault`
- Adds or refreshes the AGENTS memory protocol block (unless `--skip-agents`)
- Restarts gateway (unless `--skip-restart`) and now reports restart failures honestly instead of claiming setup success

### Recommended follow-up after setup

1. Install Obsidian if you want the `v0.6.x` memory surface.
2. Open `<workspace>/obsidian-vault/Gigabrain`.
3. Start at `00 Home/Home.md`.
4. If the vault looks sparse at first, that is normal: Gigabrain only shows memories that already exist in native notes or the registry.

### Verify the install

```bash
npx gigabrainctl doctor --config ~/.openclaw/openclaw.json
```

### Wizard help

```bash
npm run setup -- --help
```

### Useful setup flags

```bash
npm run setup -- --workspace /path/to/workspace --vault-path ~/Documents/gigabrainvault
npm run setup -- --workspace /path/to/workspace --skip-vault
```

If doctor reports config drift or stale paths, rerun the setup wizard before editing `openclaw.json` manually.

## Option B: Manual setup (custom environments)

1. Install from source:

```bash
git clone https://github.com/legendaryvibecoder/gigabrain.git
openclaw plugins install -l /absolute/path/to/gigabrain
```

2. Register plugin in `~/.openclaw/openclaw.json`:

```json
{
  "plugins": {
    "slots": {
      "memory": "gigabrain"
    },
    "entries": {
      "gigabrain": {
        "config": {
          "enabled": true
        }
      }
    }
  }
}
```

`plugins.slots.memory = "gigabrain"` is the important part that tells OpenClaw to use Gigabrain as the active memory-slot provider.

Notes:

- Recent OpenClaw builds discover third-party plugins from `~/.openclaw/extensions` or linked paths in `plugins.load.paths`, not from `~/.openclaw/plugins/node_modules`.
- Do not add `plugins.entries.gigabrain.path` manually unless your OpenClaw build explicitly documents that key.

3. Restart gateway:

```bash
openclaw gateway restart
```

4. Run migration once:

```bash
node scripts/migrate-v3.js --apply --config ~/.openclaw/openclaw.json
```

5. Verify the resulting config:

```bash
npx gigabrainctl doctor --config ~/.openclaw/openclaw.json
```

## First-time setup details

Migration creates the core SQLite schema (`memory_events`, `memory_current`, `memory_native_chunks`, `memory_entity_mentions`, optional `memory_fts`, and world-model tables when enabled) and backfills events from any existing data.

A rollback metadata file is written to `output/rollback-meta.json` in case you need to revert.

## Upgrading from older Gigabrain docs

Move to `openclaw plugins install @legendaryvibecoder/gigabrain`, rerun `npm run setup -- --workspace ...`, then run `npx gigabrainctl doctor --config ~/.openclaw/openclaw.json`.

The expected upgrade order across all hosts:

1. Re-run setup for the host surface you use.
2. Run doctor or the generated verify script.
3. Only then troubleshoot custom config by hand if something still looks wrong.
