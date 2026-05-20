# Destination Audit, 2026-05

Gigabrain v0.7.1 validates each destination as an integration surface, not just a doc claim. The product posture remains: local-first Memory Passport plus control plane, with native host memories treated as sources or hot caches rather than replaced wholesale.

## Destination Matrix

| Destination | Install path | Runtime path | Memory policy | E2E status | Gaps |
| --- | --- | --- | --- | --- | --- |
| OpenClaw | `openclaw plugins install @legendaryvibecoder/gigabrain` | Plugin slot `plugins.slots.memory = "gigabrain"` | First-class provider, registry, native sync, legacy import | Covered by setup docs, doctor, OpenClaw hooks, legacy registry import, live smoke gate | Revalidate optional Active Memory adapter after OpenClaw provider APIs settle |
| Hermes / Nimbus | `gigabrain-hermes-setup --install --test` | Hermes stdio MCP plus read-only `~/.hermes/memories` sync | Hermes `MEMORY.md`/`USER.md` stay hot cache; Gigabrain is long-term control plane | Covered by Hermes setup, Nimbus bridge contract, MCP smoke, host sync status | Native Hermes memory-provider plugin is future work if MCP pre-turn recall is insufficient |
| Codex App / CLI | `gigabrain-codex-setup` | Stdio MCP and generated `.codex/actions` helpers | Project/user stores plus explicit checkpoints | Covered by setup, packaged install, MCP integration, doctor, recall, provenance | Chronicle and Codex native memories remain read-only/local-source inputs, not rules storage |
| Claude Code | `gigabrain-claude-setup` | Shared standalone store and generated Claude MCP wiring | Shared project/user stores plus read-only Claude memory sync | Covered by setup and packaged setup tests | Validate against current Claude Code release before any marketplace claim |
| Claude Desktop | `npm run claude:desktop:bundle` | Desktop extension bundle wrapping same MCP server | Same store and tools as Claude Code | Covered by packaged desktop bundle test | Manual Desktop import remains user-driven |
| MCP clients | `gigabrain-mcp` | Official MCP SDK stdio transport | Tool-mediated recall/write/audit/status | All 12 tools are called in integration tests; text fallback and structured output are checked | Remote Streamable HTTP MCP is not yet shipped |
| Cursor / Windsurf | `gigabrainctl sync-hosts --host cursor,windsurf` | Read-only workspace `.cursor` / `.windsurf` rules and memories | Source inventory and provenance links only | Covered by host discovery/sync tests | Host formats are best-effort because these tools expose workspace conventions unevenly |
| Manual cloud imports | `sync-hosts --manual-import ...` | Explicit user-provided text exports | `bidirectional_disallowed`; no scraping; safe handoff export | Covered by manual import, Passport, secret-risk omission, handoff brief tests | No hidden ChatGPT/Claude.ai/Gemini/Copilot sync by design |
| Memory Passport | `gigabrainctl passport` | Static Markdown/HTML/JSON report plus handoffs | Audit layer above native memories | Covered by packaged Passport and demo tests | Needs encrypted portable bundle for vault-grade portability |

## State Of The Art Check

- MCP: aligned with current structured output expectations. Tools return `structuredContent` plus serialized JSON text fallback, and v0.7.1 adds risk annotations for read-only vs additive-write tools.
- Codex: aligned with current guidance that memories are local recall and required rules belong in `AGENTS.md` or checked-in docs.
- Hermes: aligned with the core/hot-cache plus external-provider pattern. Gigabrain currently runs as MCP and host sync; a native provider plugin remains optional future work.
- OpenClaw: aligned with plugin-slot memory provider semantics. Active Memory is adjacent, not a replacement, and should be tested as an optional pre-reply adapter later.
- Cloud products: aligned with explicit import/export only. Gigabrain does not scrape closed cloud memories or claim bidirectional sync.

## OnePassword For Memory Status

Gigabrain is now a Memory Passport and control-plane MVP:

- Works today: inventory, provenance, dedupe, recall, MCP tools, host sync, audit reports, safe handoff briefs, OpenClaw import, Hermes bridge, Codex/Claude setup.
- Needed for a stronger vault-grade "OnePassword for Memory": encrypted portable bundle, signed export manifest, delete/tombstone workflows, review/approval UI, trust labels, stronger secret governance, and optional remote/team sync.

## Release Verdict

v0.7.1 is a release-hardening audit, not a breaking architecture change. Keep npm/package-lock for this release. Revisit pnpm only as a separate package-manager migration when there is a workspace or monorepo reason.
