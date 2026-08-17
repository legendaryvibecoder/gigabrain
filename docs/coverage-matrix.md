# Surface coverage matrix

Gigabrain exposes its memory engine through four surfaces:

- **Local MCP** — the `gigabrain_*` tools registered for Codex / Claude / Hermes
  (`lib/core/codex-mcp.js`).
- **Remote MCP** — the read-only-by-default Streamable HTTP profile for Claude
  and ChatGPT (`lib/core/remote-mcp.js`).
- **CLI** — the `gigabrainctl` verbs (`scripts/gigabrainctl.js`).
- **HTTP** — the local `/gb/*` JSON API used by the web console and the
  Spark↔Gigabrain bridge (`lib/core/http-routes.js`).

The matrix below maps each capability to the surface(s) that expose it. It is a
deliberate, asymmetric design: write/agent-loop capabilities live on MCP, operator
maintenance lives on the CLI, and read/inspection surfaces are mirrored to HTTP for
the console. A blank cell is an intentional non-goal, not an oversight — the
rationale is in the notes.

Legend: ✅ first-class · 🟡 partial / indirect · ⬜ not exposed (by design or
planned).

| Capability | Local MCP | Remote MCP | CLI | Local HTTP | Notes |
| --- | :---: | :---: | :---: | :---: | --- |
| **capture** | ✅ `gigabrain_remember` | ⬜ | 🟡 `sync-hosts`, `import-openclaw` | 🟡 `POST /gb/suggestions` | Broad remember-intent writes stay local. Remote MCP never exposes `gigabrain_remember`. |
| **recall** | ✅ `gigabrain_recall` | ✅ `gigabrain_recall` | ✅ `orchestrator explain` | ✅ `POST /gb/recall`, `POST /gb/recall/explain` | Remote authorization runs before ranking, exact server/token scopes are intersected, paths are redacted, and a receipt is recorded. |
| **checkpoint write** | ✅ `gigabrain_checkpoint` | 🟡 opt-in `gigabrain:checkpoint` | ⬜ | ⬜ | New checkpoints are immutable episodes. Durable candidates create proposals, not memories. |
| **checkpoint list/get** | ✅ | ✅ | ⬜ | ⬜ | Exact pagination and direct reads repeat scope checks; semantic recall is not used as enumeration. |
| **claim propose/review/decide** | ✅ | 🟡 review by default; propose/decide require narrow scopes | ⬜ | ⬜ | Terminal decisions are append-only. Authenticated authority cannot be supplied by a tool argument. |
| **receipt write/get** | ✅ | 🟡 get by default; write requires `gigabrain:receipt` | ⬜ | ⬜ | Recall receipts hash queries and remote responses omit local paths. |
| **adjudications** | ✅ `gigabrain_adjudications` | ⬜ | ✅ `review adjudications` | ✅ `GET /gb/adjudications` | Existing arbitration inspection is not in the initial remote allowlist. |
| **beliefs-as-of** | ✅ `gigabrain_beliefs_as_of` | ⬜ | ✅ `review beliefs-as-of --at <iso>` | ✅ `GET /gb/beliefs-as-of?at=<iso>` | Existing bitemporal inspection remains local in the first remote profile. |
| **review-queue** | ✅ `gigabrain_review_queue` | ⬜ | ✅ `review queue` | ✅ `GET /gb/review-queue` | Existing global queue is not exposed remotely; typed claim review is the remote review surface. |
| **watch** | ⬜ | ⬜ | ✅ `watch` (`watch --install-hook`) | ⬜ | Filesystem lifecycle is operator-only. |
| **handoff** | 🟡 `gigabrain_export_brief` | ⬜ | ✅ `handoff` | ⬜ | Full reports and exports stay outside the remote connector. |
| **legacy checkpoint migration** | ⬜ | ⬜ | ✅ `migrate legacy-checkpoints` | ⬜ | Deterministic, idempotent, zero-promotion backfill; dry-run creates no tables. |
| **legacy table drop** | ⬜ | ⬜ | ✅ `migrate legacy-drop` | ⬜ | Guarded operator lifecycle action. |
| **vault** | 🟡 via recall | 🟡 via authorized recall | ✅ `vault sync`, `vault status` | 🟡 via recall | Vault chunks remain read-only evidence and never become beliefs. |

## Read across, write narrowly

Two patterns explain the shape of the matrix:

1. **Local inspection capabilities are mirrored.** `adjudications`, `beliefs-as-of`, and
   `review-queue` are read everywhere — agents inspect them via MCP, operators via
   the CLI, and the console via HTTP. These are the trust-control-plane surfaces and
   benefit from being uniformly reachable.

2. **Writes and lifecycle stay on their owner surface.** Broad memory capture
   stays local; remote writes require a feature flag plus a narrow OAuth scope;
   `watch` and migrations are CLI-only;
   raw `capture` is an MCP write while the CLI only *imports* and HTTP only *ingests
   structured suggestions*. This keeps the blast radius of each mutating path
   aligned with the actor that owns it.

When you add a new capability, record its row here in the same PR so the asymmetry
stays a deliberate, documented choice rather than drift.
