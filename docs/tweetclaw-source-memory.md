# TweetClaw Public Signal Memory Workflow

Use this workflow when an OpenClaw agent needs public X/Twitter context from TweetClaw and durable memory from Gigabrain. TweetClaw collects the public signal. Gigabrain stores the reviewed summary, provenance, decisions, and follow-up checks that should survive between agent sessions.

The goal is not to archive every tweet. The useful memory is the operator-reviewed answer to: what was searched, what mattered, what decision changed, which public sources support it, and what should be checked next.

## Fit

This workflow fits:

- product discovery from public tweets and tweet replies
- support themes from public mentions and search results
- campaign or launch monitoring
- competitor and ecosystem watchlists
- giveaway draw notes that need a later audit trail
- influencer or community account monitoring

Use a separate export, data lake, or evidence folder for raw datasets. Use Gigabrain for durable summaries that help future agents reason and hand off work.

## Install

Install Gigabrain as the memory provider:

```bash
openclaw plugins install @legendaryvibecoder/gigabrain
cd ~/.openclaw/extensions/gigabrain
npm run setup -- --workspace /path/to/workspace
npx gigabrainctl doctor --config ~/.openclaw/openclaw.json
```

Install TweetClaw in the same OpenClaw workspace:

```bash
openclaw plugins install @xquik/tweetclaw
```

Configure TweetClaw with the setup path documented by its package. Keep API keys, cookies, export files, and approval records outside Gigabrain memory notes.

## Capture Model

TweetClaw should be treated as a source, not a memory store.

| Stage | TweetClaw role | Gigabrain role |
| --- | --- | --- |
| Search | Search tweets, tweet replies, accounts, media, followers, or monitor results | Recall previous searches, decisions, exclusions, and watchlists |
| Review | Return public evidence and fields useful to the operator | Store the reviewed summary and source identifiers |
| Decide | Support an action such as reply drafting, campaign adjustment, or monitoring | Store the decision, rationale, and next check |
| Handoff | Provide fresh public data for the current session | Preserve an audit-friendly handoff for the next session |

Save compact, reviewed memory notes. Do not save bulk exports.

## What to Save

Store:

- search query, timestamp, and public source type
- public tweet URLs or tweet IDs used as evidence
- account handles only when they are public and relevant
- reviewed theme, risk, decision, or follow-up action
- confidence level and reviewer context
- exclusion rules, such as ignored spam patterns or blocked keywords

Do not store:

- API keys, cookies, tokens, or session material
- raw direct message bodies
- raw follower exports or bulk personal data
- unreviewed post text that could later be sent by mistake
- private notes copied from unrelated systems
- screenshots or exports that include private runtime details

## OpenClaw Prompt Pattern

Ask the agent to separate collection, review, and memory capture:

```text
Use TweetClaw to search public tweet replies for "pricing issue" from the last 7 days.
Summarize repeated support themes with public tweet URLs as evidence.
Then store only the reviewed themes, source tweet IDs, and next monitoring action in Gigabrain.
Do not store raw exports, credentials, direct messages, or draft replies.
```

After review, save memory with explicit notes:

```xml
<memory_note type="CONTEXT" confidence="medium">TweetClaw public reply search on 2026-05-23 for "pricing issue" found repeated confusion about plan limits. Evidence: tweet IDs 1111111111111111111 and 2222222222222222222. Next check: rerun after the pricing FAQ update ships.</memory_note>
```

```xml
<memory_note type="DECISION" confidence="high">For launch monitoring, ignore giveaway-only replies unless they mention billing, API limits, account login, or data export. This filter came from the 2026-05-23 TweetClaw public search review.</memory_note>
```

Use `CONTEXT` for observations, `DECISION` for changed behavior, and `ENTITY` for stable public account or ecosystem facts.

## Recall Before Acting

Before a follow-up search, reply draft, export, or campaign decision, ask Gigabrain for the stored source memory:

```text
Use gigabrain_recall for prior TweetClaw public signal reviews about pricing issues, ignored reply patterns, and launch monitoring decisions. Then run a fresh TweetClaw search and compare only the changed themes.
```

This keeps the agent from repeating stale searches, reusing excluded evidence, or losing the reason a filter was created.

## Suggested AGENTS.md Block

Add a short local instruction block when the workspace uses both plugins:

```markdown
## TweetClaw Source Memory

- Use TweetClaw for fresh public X/Twitter collection.
- Use Gigabrain for reviewed summaries, provenance, decisions, and follow-up checks.
- Save public tweet URLs or tweet IDs only when they support the reviewed summary.
- Never save TweetClaw credentials, cookies, direct messages, raw exports, raw follower lists, or unreviewed post text in memory.
- Before posting or replying, recall prior campaign decisions and require explicit operator approval.
```

## Validation Checklist

Before merging this workflow into a workspace:

- `npx gigabrainctl doctor --config ~/.openclaw/openclaw.json` passes
- TweetClaw can run a public search without printing credentials
- the first memory note contains reviewed evidence, not raw export content
- a later `gigabrain_recall` query returns the saved TweetClaw summary
- posting, replies, direct messages, and media upload stay behind explicit operator approval

## Related Docs

- [OpenClaw setup](setup-openclaw.md)
- [Memory protocol](memory-protocol.md)
- [Sharing model](sharing.md)
- [Memory Passport](memory-passport.md)
