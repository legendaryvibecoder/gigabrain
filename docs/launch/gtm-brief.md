# Gigabrain GTM Brief

Date: 2026-05-10

## Thesis

Gigabrain should not compete as "another memory layer." That market is already crowded with memory APIs, MCP servers, context graphs, and native assistant memory. The bigger wedge is trust control:

> Gigabrain is the local-first Memory Passport for AI agents. It shows what agents remember, where those memories came from, what is risky, and what is safe to hand off.

The 8-figure valuation path is an enterprise trust story, not a pure developer utility story. Agent memory is becoming identity-like infrastructure: durable, cross-tool, sensitive, and hard to audit. Teams will pay for memory inventory, provenance, redaction, policy, and handoff controls before they trust autonomous agents in production.

## Market Signals

1Password is moving into agent security with Unified Access, positioning around discovery, securing, and auditing access for human, machine, and AI agent identities. That validates the "control plane for agent trust" category. Source: https://1password.com/press/2026/mar/1password-unified-access

OpenAI memory is mainstream and user-controlled, with saved memories, chat history reference, deletion, and memory-off controls. That validates end-user demand for inspectable AI memory controls. Source: https://help.openai.com/en/articles/8983136-what-is-memory

Mem0 and Supermemory sell persistent memory through MCP and APIs across Claude, Codex, Cursor, Windsurf, VS Code, and similar clients. That validates cross-client memory as a live market, but their public surface is mostly "store and retrieve memory." Sources: https://docs.mem0.ai/platform/mem0-mcp and https://supermemory.ai/docs/supermemory-mcp/introduction

Zep/Graphiti and Letta validate more sophisticated memory models: temporal knowledge graphs, context engineering, and shareable memory blocks. That raises the bar for retrieval quality, but still leaves a gap for local host-memory inventory, risk audit, and safe handoff. Sources: https://help.getzep.com/graph-overview and https://docs.letta.com/guides/agents/memory-blocks/

## Differentiation

| Market category | Typical promise | Gigabrain wedge |
| --- | --- | --- |
| Memory API | Add/search/update memories | Audit memories already scattered across tools |
| MCP memory server | Persistent context across clients | Local-first source inventory, provenance, and safe handoffs |
| Temporal graph memory | Better retrieval and invalidation | Passport report for trust, compliance, and operator review |
| Native assistant memory | Personalized assistant behavior | Control plane above native memories without scraping closed clouds |
| Agent identity/security | Credentials and access controls | Memory trust controls before memories become operational risk |

## ICP

- AI-forward founders and staff engineers using Codex, Claude Code, Cursor/Windsurf, and ChatGPT in the same codebase.
- Devtools teams shipping agentic coding workflows and needing a memory governance story.
- Security-conscious teams piloting internal agents where memory may include secrets, customer context, or stale operational facts.
- Agencies building repeatable AI workflows for clients and needing handoff artifacts.

## Product Packaging

Open-source core:

- Local sync for visible host memory files
- Memory Passport report
- Handoff briefs
- CLI/MCP tools
- Basic audit and redaction

Paid/enterprise path:

- Team Passport dashboard
- Policy packs for secret classes, PII, regulated data, and retention windows
- GitHub/GitLab pull-request Passport checks
- SSO and signed Passport attestations
- Fleet sync status for many repos and hosts
- Admin review queues and remediation tracking
- Managed bridge for approved cloud exports without scraping

## Launch Wedge

Ship v0.7 as "Memory Passport for AI coding teams."

Landing page promise:

> Before your agents act, know what they remember.

Primary CTA:

```bash
npm install @legendaryvibecoder/gigabrain
npx gigabrainctl passport --config ~/.gigabrain/config.json --output-dir ./gigabrain-passport
```

Pilot offer:

- "We will run your first AI memory audit in 20 minutes."
- Output: source inventory, risk score, secret-risk rows, stale facts, duplicate memories, and AGENTS/CLAUDE handoff briefs.
- Qualification: teams using at least two AI coding agents in one repo.

## 30-Day Launch Plan

Week 1:

- Fix launch blockers: omit secret-risk rows from handoffs, enforce audit limits, and document GitHub alert status.
- Publish a demo Passport from a synthetic repo.
- Launch landing page and X thread.

Week 2:

- Recruit 10 design partners from AI coding, devtools, and security communities.
- Add signed Passport JSON and CI check mode.
- Record a 90-second demo.

Week 3:

- Add team dashboard prototype backed by Passport JSON.
- Add policy presets: "solo dev", "startup", "security review".
- Publish comparison post: "Memory API vs Memory Passport."

Week 4:

- Convert 3 pilots into paid annual design partners.
- Package enterprise roadmap: admin review queue, Passport attestations, SSO, hosted policy packs.
- Prepare v0.8 launch with a security-first headline.

## Release Gates

- Local `npm test` green.
- Local `npm run audit:high` green.
- Local `npm audit --json` green.
- Package dry-run includes Passport and host-sync files.
- GitHub Dependabot/code/secret alerts are checked after push/merge; local fixes alone do not close remote alerts.
- No raw secrets or redacted secret markers in generated handoff briefs.

