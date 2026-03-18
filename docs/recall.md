# How Recall Works

Before each prompt, Gigabrain automatically retrieves relevant context through its recall pipeline.

## Recall pipeline

1. **Sanitizes the user query** — strips prior `<gigabrain-context>` blocks, metadata lines, bootstrap injections, and markdown noise to extract the real question
2. **Entity coreference resolution** — detects pronoun follow-ups (e.g. "was weisst du noch über sie?") and enriches the query with the entity from prior messages in the conversation
3. Uses the recall orchestrator to choose between quick context, entity brief, timeline brief, relationship brief, or verification-oriented recall
4. Searches the SQLite registry and native markdown files (`MEMORY.md`, daily notes) for the right supporting context behind that strategy
5. **Recall hygiene** — strips persisted recall artifacts and transcript-style control lines out of native recall so old `<gigabrain-context>`, `query:`, `Source:`, or `user:` / `assistant:` lines do not feed back into future answers
6. **Entity answer quality scoring** — for "who is" / "wer ist" queries, penalizes instruction-like memories ("Add to profile: ...") and boosts direct factual content
7. **Deduplication** — removes duplicate memories by normalized content before ranking
8. **Temporal safety** — older memories that say `today` / `heute` / `currently` are marked with their recorded date instead of being treated as if they refer to the current day
9. **World-model synthesis** — where possible, prefers entity/timeline syntheses over raw snippet piles
10. Applies class budgets (core / situational / decisions) and token limits
11. Injects the results as a system message placed before the last user message in the conversation, without exposing internal provenance like file paths or memory ids

The agent doesn't need to do anything special for recall — it happens automatically via the gateway plugin hooks.

If you also use OpenClaw's separate `memory_search` / `memory_get` tools, note that their visible `Source:` behavior is controlled by OpenClaw's own `memory.citations` setting, not by Gigabrain.

## Orchestrator strategies

The orchestrator automatically selects the best recall strategy based on query analysis:

| Strategy | When used |
|----------|-----------|
| `quick_context` | Simple follow-ups and short queries |
| `entity_brief` | "Who is X?" / entity-focused questions |
| `timeline_brief` | "What happened with X?" / temporal queries |
| `relationship_brief` | "How are X and Y related?" |
| `verification` | Source verification, exact dates/wording |
| `deep_lookup` | Only when `allowDeepLookup` is enabled and trigger conditions are met |

## Configuration

See [configuration.md](configuration.md#recall) for recall and orchestrator config options.
