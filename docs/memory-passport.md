# Memory Passport

Gigabrain's launch product surface is the Memory Passport: the governance/audit artifact of the broader memory **trust control plane**. It is a local-first report that shows what your AI agents remember, where those memories came from, what needs review, and what can be safely handed to another host.

The Passport is a **report + safe handoff pack**, not a portable re-importable bundle and not another hidden RAG store. It is the audit/trust layer above native memories:

- source inventory by host
- exact duplicate groups with retained provenance
- contradiction review items from the world model
- stale or expired memories
- provenance gaps
- secret-like memory risks with redacted previews
- a readiness verdict that separates launch blockers from cleanup work
- Markdown handoff briefs for `AGENTS.md`, `CLAUDE.md`, ChatGPT, Claude.ai, Gemini, and Microsoft Copilot, with secret-risk rows omitted entirely

For the current host-by-host integration status, see the [Destination Audit](audits/destination-audit-2026-05.md). v0.7.1 ships the Passport as a governance/audit + safe-handoff layer. The vault-grade pieces people associate with a "1Password for memory" — encrypted portable bundles, signed manifests, a re-importable round-trip, delete/tombstone flows, trust labels, and a review UI — are explicitly **future work, not shipped today**.

## Quickstart

```bash
npm install @legendaryvibecoder/gigabrain
npx gigabrain-codex-setup --project-root /path/to/repo
npx gigabrain-claude-setup --project-root /path/to/repo
npx gigabrainctl sync-hosts --config ~/.gigabrain/config.json --host codex,claude_code,cursor,windsurf
npx gigabrainctl passport --config ~/.gigabrain/config.json --output-dir ./gigabrain-passport
```

Open `./gigabrain-passport/memory-passport.md` or `./gigabrain-passport/memory-passport.html`. Handoff briefs are written under `./gigabrain-passport/handoffs/`.

## Manual Cloud Imports

Closed cloud products are explicit manual flows. Gigabrain does not scrape ChatGPT, Claude.ai, Gemini, or Microsoft Copilot memory, and it does not claim bidirectional sync with those systems.

```bash
npx gigabrainctl sync-hosts --config ~/.gigabrain/config.json \
  --manual-import ./chatgpt-memory-export.md \
  --manual-source-host chatgpt_manual \
  --scope profile:user

npx gigabrainctl passport --config ~/.gigabrain/config.json \
  --scope profile:user \
  --output-dir ./gigabrain-passport
```

Manual imports are tagged as `manual_import` with `bidirectional_disallowed` sync policy.

## CLI

```bash
npx gigabrainctl passport \
  --config ~/.gigabrain/config.json \
  --scope profile:user \
  --stale-days 180 \
  --output-dir ./gigabrain-passport
```

Useful flags:

| Flag | Purpose |
| --- | --- |
| `--output-dir <path>` | Directory for `memory-passport.md`, `memory-passport.html`, `memory-passport.json`, and `handoffs/` |
| `--format all\|markdown\|html\|json\|handoffs` | Limit written artifacts |
| `--scope <scope>` | Limit report and handoff memories to one scope |
| `--limit <n>` | Max rows per audit section |
| `--handoff-limit <n>` | Max memories per handoff brief |
| `--stale-days <n>` | Mark memories stale after this many days without update |
| `--host <list>` | Optional source discovery filter |
| `--skip-handoffs` | Write only the Passport report files |

## Report Sections

| Section | What it checks |
| --- | --- |
| Source Inventory | Synced source paths, host counts, sync policy, and freshness |
| Host Readiness | Local sources detected, last sync status, manual-only hosts, and bridge hosts |
| Readiness Verdict | A launch score, blocker list, and next actions based on Passport audit findings |
| Dedupe Audit | Active exact duplicate groups by normalized fingerprint |
| Contradiction Audit | Open contradiction-review loops from the world model |
| Stale Memory Audit | Memories past `valid_until` or not updated within `--stale-days` |
| Provenance Audit | Memories with registry-only or missing source provenance |
| Secret Risk Audit | Secret-like content using redacted previews only |

Handoff briefs never include secret-risk rows, not even with redacted text. If the Passport finds credentials, tokens, or API-key-shaped memory, the brief records how many rows were omitted and points you back to the Secret Risk Audit.

## Demo

Run the local launch demo script from the repo root:

```bash
npm run demo:passport
```

The script creates a temporary standalone app, seeds fake Codex and Claude Code memory files, syncs them into Gigabrain, then writes a Passport report and handoff briefs. It is safe to run because it uses a temporary `HOME` and `CODEX_HOME`.
