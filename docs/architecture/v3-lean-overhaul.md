# Gigabrain v3.1 Lean Overhaul

## Intent

Gigabrain v3.1 keeps the big-bang simplification and adds native-memory fusion:

- one runtime control plane (`scripts/gigabrainctl.js`)
- one memory truth model (`memory_events` + `memory_current`)
- one native memory sync index (`memory_native_chunks` + `memory_native_sync_state`)
- one entity mention index (`memory_entity_mentions`)
- one v3 grouped config contract
- no wrapper scripts and no deprecated key compatibility layer

## Core Shape

- Thin plugin adapter: `index.ts`
- Runtime core modules: `lib/core/`
- Control plane CLI: `scripts/gigabrainctl.js`
- Migration entrypoint: `scripts/migrate-v3.js`
- Native sync module: `lib/core/native-sync.js`
- Person ranking module: `lib/core/person-service.js`

## Data Model

### `memory_events` (timeline, append-only)

Required event fields:

- `timestamp`
- `component`
- `action`
- `reason_codes`
- `memory_id`
- `cleanup_version`
- `run_id`
- `review_version`
- optional: `similarity`
- optional: `matched_memory_id`

### `memory_current` (projection)

Projection table used for runtime capture/recall/audit decisions.

### `memory_native_chunks` (native note index)

Read-only indexed chunks from `MEMORY.md`, daily notes, and curated shared files.

### `memory_native_sync_state` (incremental sync state)

File fingerprint state to sync only changed native sources.

### `memory_entity_mentions` (person/entity mention graph)

Entity mentions extracted from active projection + native chunks for person-aware retrieval ordering.

## Runtime Responsibilities

- Plugin:
  - hook wiring
  - config normalization/hard-fail
  - HTTP route registration
- Core services:
  - capture
  - recall
  - native memory sync
  - person ranking and entity indexing
  - maintenance
  - audit
  - llm routing
  - metrics
- CLI:
  - `nightly`
  - `maintain`
  - `audit --mode shadow|apply|restore`
  - `inventory`
  - `doctor`

## Instruction-Aware Capture Rules

- Explicit memory saves are expected via `<memory_note>` tags (typically produced by a `memory-note` skill workflow).
- Default production posture is `capture.requireMemoryNote=true`.
- `SOUL.md` can shape voice/personality, but memory safety/capture behavior is controlled by operational instructions (`AGENTS.md`) plus skill contracts.
- If instruction sources conflict, prefer the stricter capture/safety rule and avoid raw insertion.

## API

- `GET /gb/health`
- `POST /gb/bench/recall`
- `GET /gb/memory/:id/timeline`

## Operational Notes

- Archived memories are excluded from default recall and used only as fallback.
- Shared recall never uses private `MEMORY.md`; private scopes can use full native note corpus.
- Backup policy keeps compact snapshots as primary recovery artifacts.
- Deprecated keys are rejected at runtime and must be migrated via `migrate-v3.js`.
