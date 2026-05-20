# X Launch Posts

## Launch Thread

1. AI agents now remember things. The problem is that teams usually cannot see the whole memory surface.

Codex has one set of notes. Claude has another. Cursor/Windsurf rules drift. Cloud assistants have manual memory controls.

So I built Gigabrain Memory Passport.

2. It is not another hidden RAG store.

Gigabrain inventories visible local host memories, keeps provenance, deduplicates equivalent memories, flags stale facts, flags secret-risk rows, and writes safe handoff briefs for the next agent.

3. The key idea: before your agents act, know what they remember.

The Passport gives you:

- source inventory
- host readiness
- duplicate audit
- contradiction audit
- stale memory audit
- provenance gaps
- secret-risk audit
- handoff briefs

4. Secret handling was the launch bar.

If a memory looks like it contains a token, API key, password, or credential, it appears only in the audit with a redacted preview.

It is omitted entirely from AGENTS.md/CLAUDE.md/ChatGPT/Claude.ai/Gemini/Copilot handoff briefs.

5. Closed cloud memories are manual-only.

Gigabrain does not scrape ChatGPT, Claude.ai, Gemini, or Copilot.

It creates explicit import/export briefs so the user stays in control.

6. Why this matters:

Memory is becoming identity-like infrastructure for agents.

It can contain preferences, customer context, repo decisions, stale assumptions, private paths, and secrets.

That needs a control plane.

7. Install:

```bash
npm install @legendaryvibecoder/gigabrain
npx gigabrainctl sync-hosts --config ~/.gigabrain/config.json --host codex,claude_code,cursor,windsurf
npx gigabrainctl passport --config ~/.gigabrain/config.json --output-dir ./gigabrain-passport
```

8. I am looking for 10 design partners using two or more AI coding agents in the same repo.

I will help you run your first Memory Passport and turn the findings into a cleaner agent handoff workflow.

DM "passport".

## Short Posts

AI memory is useful until nobody knows what the agents remember.

Gigabrain Memory Passport inventories local agent memories, flags stale/duplicate/secret-risk rows, and writes safe handoff briefs across Codex, Claude, Cursor/Windsurf, and manual cloud exports.

---

The next security question for AI teams:

"What do your agents remember?"

Not prompts. Not credentials. Memory.

Gigabrain gives you a local Passport: source inventory, provenance gaps, stale facts, secret-risk flags, and safe handoffs.

---

I do not want one more hidden memory store.

I want a control plane above all the memory surfaces agents already use.

That is the Gigabrain pivot: Memory Passport for AI coding teams.

---

If you use Codex + Claude Code + Cursor/Windsurf on the same repo, your agent memory is already distributed.

Gigabrain turns that into an inspectable Passport instead of an invisible pile of context drift.

## Founder Note

I am building Gigabrain as the 1Password-style control plane for AI memory.

Not credential storage. Memory trust.

The wedge is simple: run a local Passport, see what agents remember, clean what is risky, hand off only what is safe.

