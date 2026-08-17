# Checkpoint control plane

Gigabrain treats a checkpoint as evidence about a session, not as a set of
facts that should automatically enter durable memory.

The control plane adds three append-only records:

1. `checkpoint.1` - an immutable episode with stable identity, session
   lineage, scope, source, repository state, typed items, and evidence links.
2. `claim.1` - a typed proposal derived from an episode or created explicitly.
   A proposal is not recallable until a terminal review event accepts it.
3. `receipt.1` - a policy-versioned record of a checkpoint, proposal, review,
   recall, or answer operation. Recall receipts store a query hash, not the raw
   query.

The published schemas are [`checkpoint.1`](schemas/checkpoint.1.schema.json),
[`claim.1`](schemas/claim.1.schema.json), and
[`receipt.1`](schemas/receipt.1.schema.json).

## Invariants

- Checkpoint, checkpoint-item, proposal, proposal-event, and receipt rows are
  append-only at the SQLite boundary. Update and delete triggers fail closed.
- A checkpoint write may create `agent_inference` proposals, but never a
  durable memory.
- Legacy Markdown migration creates `legacy_untyped` episodes and zero
  proposals.
- Exactly one terminal event may exist for a proposal.
- Accepted proposals use the existing explicit remember path. Rejected and
  superseded proposals never become recallable.
- Authorization is checked before semantic ranking and repeated for direct
  object reads, parent links, checkpoint-item references, cursors, and receipt
  reads.
- An authenticated authority claim cannot be overridden by a tool argument.
- Remote responses omit local repository and source paths.
- A copied checkpoint is not an independent witness. Ancestry and evidence
  references remain visible instead of being converted into vote count.

## MCP tools

The local STDIO server exposes the existing tools plus:

- `gigabrain_checkpoint_list`
- `gigabrain_checkpoint_get`
- `gigabrain_claim_propose`
- `gigabrain_claim_review`
- `gigabrain_claim_decide`
- `gigabrain_receipt_write`
- `gigabrain_receipt_get`

Remote MCP intentionally exposes a smaller read allowlist. Optional writes are
split across the narrow OAuth scopes documented in
[`setup-remote-mcp.md`](setup-remote-mcp.md); the broad legacy
`gigabrain_remember` tool is never exposed remotely.

## Promotion rules

`gigabrain_claim_decide` requires a non-empty reason and applies evidence-class
preconditions:

| Evidence class | Acceptance requirement |
| --- | --- |
| `owner_assertion` | Authenticated `owner` or `delegated_owner` authority |
| `project_decision` | Claim type must be `DECISION` |
| `operational_observation` | At least one evidence reference |
| `evaluation_result` | At least one evidence reference |
| `external_reference` | At least one evidence reference |
| `agent_inference` | Owner authority when no evidence reference exists |

These are minimum safety checks, not a claim-quality classifier. Automatic
promotion remains disabled.

## Legacy checkpoint migration

Preview the migration first:

```bash
npx gigabrainctl migrate legacy-checkpoints \
  --config ~/.gigabrain/config.json \
  --dry-run
```

Apply the same deterministic backfill:

```bash
npx gigabrainctl migrate legacy-checkpoints \
  --config ~/.gigabrain/config.json
```

The migration:

- considers only daily Markdown files containing a Gigabrain session marker;
- skips the current day unless `--include-today` is explicit;
- rejects symlinks, paths outside the configured root, and files over 5 MB;
- groups historical content by exact scope;
- derives deterministic checkpoint IDs from source file identity and group ordinal,
  while storing a content hash for drift detection;
- is idempotent and detects later source drift;
- creates no proposal or durable memory from legacy text.

Dry-run does not create control-plane tables.

## Verification

Run the control-plane engineering evaluation:

```bash
npm run eval:control-plane
```

The sealed synthetic fixture currently checks 13 property groups: authorized
recall; cross-project, project-database profile, user-store profile, and shared
overlay isolation; direct-ID isolation; exact recent and checkpoint reads;
cross-scope checkpoint denial; proposal non-promotion; authority-spoof
rejection; receipt query hashing; and local-path redaction.

This is engineering verification only. It is not a human-memory benchmark, a
claim-promotion accuracy result, or a state-of-the-art comparison. Before
enabling automatic promotion, Gigabrain still needs a frozen human-labeled
checkpoint corpus with source-stratified precision, recall, temporal update,
contradiction, and abstention measures.

## Failure and retry semantics

Claim acceptance uses the established memory write path and then appends the
terminal proposal event. If a process stops between those steps, retrying is
safe: the memory write deduplicates to the committed memory ID and the proposal
event can be appended once. This is recoverable at-least-once behavior, not a
cross-database atomic transaction. Operators should investigate a proposal that
remains `proposed` while an equivalent durable memory already exists.
