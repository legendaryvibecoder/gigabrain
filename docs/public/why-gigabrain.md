# Why Gigabrain when agents already have memory?

The honest answer is that native memory has improved quickly. Gigabrain is useful only where its boundary is different.

This comparison was checked against official product documentation on 2026-08-06. Product behavior can change; follow the linked source for the current contract.

## Native memory is the first layer

| Product | Documented native behavior | Boundary Gigabrain addresses |
| --- | --- | --- |
| [Codex](https://learn.chatgpt.com/docs/customization/memories) | Local Codex clients can generate and use local memory files. The local store is separate from ChatGPT web memory, off by default, and controlled per chat. | Cross-vendor provenance, deterministic arbitration, explicit project/user stores, and deliberate movement between hosts. |
| [Claude Code](https://code.claude.com/docs/en/memory) | Auto memory is on by default, project-scoped, plain Markdown, and shared across worktrees of one repo. Anthropic documents it as machine-local and not shared across machines or cloud environments. | A shared MCP/CLI store for configured local agents, source attribution, bi-temporal validity, and portable export/import. |
| [Cursor](https://docs.cursor.com/en/context/memories) | Memories are generated from chat, require approval, and are scoped to a project. | Read-only import into a vendor-neutral ledger; no claim of native write-back or account synchronization. |
| [OpenClaw](https://docs.openclaw.ai/concepts/memory) | Markdown memory plus a strong per-agent memory engine with lexical/vector search, promotion, and optional advanced backends. | Cross-product/host governance and a portable event/adjudication layer. OpenClaw users may not need Gigabrain if one native store already covers their workflow. |

MCP makes one tool surface available to multiple clients, but MCP by itself does not merge databases, resolve contradictions, define trust, or synchronize two machines. Gigabrain uses MCP as an access protocol; the memory policy remains explicit and inspectable. The optional remote profile adds OAuth-protected access for a self-hosted Claude or ChatGPT connector, but it remains read-only by default and does not turn Gigabrain into a managed cloud service.

## The problem it is built for

Consider one repo used from a laptop and a workstation:

- Codex remembers a debugging insight on the laptop.
- Claude Code stores a newer deployment convention on the workstation.
- OpenClaw has an older durable claim in its own workspace.
- a manual export contains a conflicting preference with weak provenance.

The problem is no longer “does any agent remember?” It is:

- which store said what?
- which fact applies to this repo, this user, and this time?
- is the newer statement actually more trustworthy?
- what was superseded, and can the decision be audited?
- which checkpoint candidates were merely proposed, and who was authorized to accept them as durable claims?
- how can another client recall the result without copying a giant prompt file?

Gigabrain models those questions directly with scoped event records, immutable checkpoint episodes, defeasible claim proposals, source links, validity windows, contradiction slots, policy-versioned receipts, and bounded recall.

## When it is useful

- you actively use two or more local agent products on the same work
- you need project memory and personal preferences to have different scopes
- you need source attribution or a reviewable contradiction trail
- you move deliberately between computers or isolated environments
- you need an MCP and CLI contract independent of one vendor's UI
- you need checkpoints to remain reviewable evidence instead of silently becoming remembered facts
- you want an operator-controlled OAuth connector for remote reads without exposing broad memory writes
- you want local deterministic recall even when no model provider is configured

## When it is probably unnecessary

- one product's native memory already covers your workflow
- you do not want to operate or review a local memory database
- you need a managed multi-tenant cloud memory service
- you need encrypted secrets storage or compliance certification
- you expect automatic account-level synchronization without configuring transport

Gigabrain should earn its operational cost. If native memory is enough, use native memory.
