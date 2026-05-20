# Cross-Memory Pivot, 2026-04-24

Gigabrain is now positioned as the local-first Memory Passport and control plane for agents, not as a replacement for native product memory. Native memories have become useful, but they remain siloed by product, account, region, plan, admin policy, or local machine. Gigabrain's job is to make memory inspectable, portable, auditable, deduplicated, and usable across Codex, Claude Code, OpenClaw, Hermes-style bridges, Cursor, Windsurf, and explicit manual imports from closed cloud products.

## Core Claim

Gigabrain is the local-first Memory Passport for agents.

It connects local memory surfaces where hosts expose files, records provenance, deduplicates equivalent memories across agents, redacts obvious secrets, audits stale/provenance/contradiction risks, and exports safe host-specific briefs. It does not claim hidden or automated synchronization with closed cloud memory systems.

## Why This Matters

| Native host memory | Gigabrain |
| --- | --- |
| Convenient inside one product | Works across multiple local agents |
| Product-owned and often account-bound | Local, inspectable SQLite + native files |
| Region, plan, or admin controlled | User-controlled store and export policy |
| Hard to audit across tools | Memory Passport with source links, provenance, sync status, and export briefs |
| Duplicates drift across agents | Exact fingerprint dedupe with multiple provenance links |
| Closed clouds require product UI | Manual import/export only, no scraping claims |

## Host Policy

| Host | Adapter policy |
| --- | --- |
| Codex | Read-only local import from `~/.codex/memories/` when present |
| Claude Code | Read-only local import from `~/.claude/projects/<project>/memory/` when present |
| OpenClaw | Existing native memory slot remains first-class |
| Hermes | MCP/HTTP bridge integration; no invented private local protocol |
| Cursor/Windsurf | Optional read-only local rules/memories import when visible in the workspace |
| ChatGPT, Claude.ai, Gemini, Microsoft Copilot | Manual export/import only; marked `bidirectional_disallowed` |

## Source Metadata

Imported and native host memories carry additive metadata:

- `source_host`: `codex`, `claude_code`, `openclaw`, `hermes`, `chatgpt_manual`, `gemini_manual`, `copilot_manual`, `claude_manual`, `windsurf`, or `cursor`
- `source_kind`: `native_memory`, `instruction`, `checkpoint`, `manual_import`, `rule`, or `chat_history_hint`
- `source_path` and `source_line`: local provenance when available
- `sync_policy`: `read_only`, `manual_export`, or `bidirectional_disallowed`

Existing stores continue to work without migration. Missing metadata defaults to `gigabrain`, `registry`, and `read_only`.

## User Flows

### Multi-Agent Setup

Use the maintained setup guides for command-level instructions:

- [Codex setup: Using Gigabrain across multiple agents](setup-codex.md#using-gigabrain-across-multiple-agents)
- [Claude setup: Using Gigabrain across multiple agents](setup-claude.md#using-gigabrain-across-multiple-agents)
- [OpenClaw setup](setup-openclaw.md)

### Manual Cloud Import

Manual cloud imports are always tagged as `manual_import` and `bidirectional_disallowed`.

### Safe Export Brief

Use `gigabrain_export_brief` or `gigabrainctl sync-hosts export-brief` to generate AGENTS.md, CLAUDE.md, or manual cloud-product briefs.

### Memory Passport

Use `gigabrainctl passport` to generate the launch-facing report:

```bash
gigabrainctl passport --config ~/.gigabrain/config.json --output-dir ./gigabrain-passport
```

The Passport writes a static Markdown/HTML report with source inventory, host readiness, dedupe audit, contradiction audit, stale-memory audit, provenance gaps, and secret-risk flags. It also writes handoff briefs for `AGENTS.md`, `CLAUDE.md`, ChatGPT, Claude.ai, Gemini, and Microsoft Copilot manual paste/import.

## MCP Surface

- `gigabrain_sources`: source freshness, host counts, and optional local discovery
- `gigabrain_sync_status`: host-by-host diagnostics
- `gigabrain_export_brief`: safe host-specific memory brief

Stable tools remain unchanged: `gigabrain_recall`, `gigabrain_remember`, `gigabrain_checkpoint`, `gigabrain_provenance`, `gigabrain_recent`, and `gigabrain_doctor`.

## Research Basis

- Codex Memories and Chronicle are useful but product-scoped and opt-in/local in important ways: [Codex Memories](https://developers.openai.com/codex/memories), [Chronicle](https://developers.openai.com/codex/memories/chronicle)
- ChatGPT memory is account/project scoped: [OpenAI Memory FAQ](https://help.openai.com/en/articles/8590148-memory-faq), [ChatGPT Projects](https://help.openai.com/en/articles/10169521-using-projects-in-chatgpt)
- Claude Code has local memory files and auto memory, not a neutral cross-agent bus: [Claude Code memory](https://code.claude.com/docs/en/memory)
- Claude.ai, Gemini, and Microsoft 365 Copilot personalization are product/account/admin controlled: [Claude personalization](https://support.claude.com/en/articles/10185728-understanding-claude-s-personalization-features), [Gemini personalization](https://support.google.com/gemini/answer/15637730), [Microsoft 365 Copilot memory](https://learn.microsoft.com/en-us/microsoft-365/copilot/copilot-personalization-memory)
- Coding agents such as Windsurf expose workspace/project memory concepts but not a neutral multi-agent memory plane: [Windsurf Memories & Rules](https://docs.windsurf.com/plugins/cascade/memories)
