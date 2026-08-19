# Grok CLI Setup Guide

Standalone setup for Gigabrain with the **Grok CLI** (`grok`, xAI's Grok Build agent). No OpenClaw and no Codex install required — Grok talks to the same local store through the same local MCP server.

Verified against `grok 1.0.5`: `grok mcp list` shows the server, `grok mcp doctor` completes the handshake and discovers the tool set, and a headless session returns real rows from `gigabrain_recall`.

## Install

```bash
npm install -g @legendaryvibecoder/gigabrain
```

If you already run Gigabrain for Codex or Claude Code, skip this — Grok reuses the store you already have. Do **not** create a second store; point Grok at the same `--config`.

## Bootstrap the store (only if you have none yet)

```bash
npx gigabrainctl init
```

This writes `~/.gigabrain/config.json`, creates the shared standalone store under `~/.gigabrain/` plus the user store under `~/.gigabrain/profile/`, and ingests the local host memories it finds. Pass that same `--config` to every later command.

## Register the MCP server

Grok stores MCP servers in `~/.grok/config.toml` (user scope) or `./.grok/config.toml` (project scope). Everything after `--` is passed to the server, not to Grok:

```bash
grok mcp add gigabrain --scope user -- npx gigabrain-mcp --config ~/.gigabrain/config.json
```

To pin an explicit interpreter and checkout instead of resolving through `npx`:

```bash
grok mcp add gigabrain --scope user -- <absolute path to node> <absolute path to gigabrain>/scripts/gigabrain-mcp.js --config ~/.gigabrain/config.json
```

Equivalent hand-written TOML:

```toml
[mcp_servers.gigabrain]
command = "<absolute path to node>"
args = [
    "<absolute path to gigabrain>/scripts/gigabrain-mcp.js",
    "--config",
    "<absolute path to your home>/.gigabrain/config.json",
]
enabled = true
```

Project-scope servers live behind Grok's folder-trust gate — run `/hooks-trust` (or launch with `--trust`) once in that repo, or use `--scope user`.

## Verify

```bash
grok mcp list      # gigabrain must appear with its command line
grok mcp doctor    # connectivity + tool discovery
```

End-to-end, without opening the TUI:

```bash
grok -p "Call gigabrain_recall with query 'deployment gates' target 'both' top_k 3 and print the first result." --max-turns 6
```

A working install returns store rows. If Grok reports the tool is unavailable, see Troubleshooting below.

## What Grok gets

The full local MCP surface — the same tools Codex and Claude Code see, backed by the same SQLite store:

- Recall and inspection — `gigabrain_recall`, `gigabrain_recent`, `gigabrain_entity`, `gigabrain_relationships`, `gigabrain_provenance`, `gigabrain_sources`
- Write — `gigabrain_remember`, `gigabrain_checkpoint`, `gigabrain_export_brief`
- Control plane (v0.10.0) — `gigabrain_checkpoint_list`, `gigabrain_checkpoint_get`, `gigabrain_claim_propose`, `gigabrain_claim_review`, `gigabrain_claim_decide`, `gigabrain_receipt_write`, `gigabrain_receipt_get`
- Arbitration — `gigabrain_arbitrate`, `gigabrain_contradictions`, `gigabrain_adjudications`, `gigabrain_beliefs_as_of`, `gigabrain_review_queue`
- Health — `gigabrain_doctor`, `gigabrain_sync_status`

`grok mcp doctor` prints the count it discovers; an older checkout exposes fewer than the 23 above.

Because the store is shared, a decision Codex captured is recallable in Grok in the same second, with its provenance and host trust label intact. Repo memory stays repo-scoped through `project:<repo>:<hash>`; personal memory is shared through the user store.

## Make Grok actually use it

MCP availability is not usage. Grok reads project rules from `AGENTS.md` (confirmed by `grok inspect`, which lists the discovered instruction files), so put the continuity rule where every Grok session sees it — the same block Codex gets:

```markdown
<!-- gigabrain:begin -->
Before re-deriving prior context (project decisions, people, ongoing work — including from OTHER agents),
call `gigabrain_recall` (target "both"). This workspace's project scope is `project:<repo>:<hash>`.
Store durable decisions with `gigabrain_remember`; run `gigabrain_checkpoint` at the end of substantial work.
<!-- gigabrain:end -->
```

## Known gaps on Grok

Grok is a **first-class MCP client** of Gigabrain, not yet a first-class *host*. Concretely:

| Capability | Codex / Claude Code | Grok CLI |
| --- | :---: | :---: |
| Local MCP tools (recall, remember, checkpoint, …) | ✅ | ✅ verified |
| Shared store, scopes, provenance, trust labels | ✅ | ✅ |
| One-command wiring (`gigabrain-codex-setup` / `-claude-setup`) | ✅ | ⬜ use `grok mcp add` |
| Auto-detection by `gigabrainctl init` | ✅ | ⬜ not detected |
| Session-start brief injected automatically | ✅ | ⬜ use the `AGENTS.md` block above |
| Host sync of the agent's *own* native memory (`sync-hosts`) | ✅ | ⬜ no Grok adapter |

On the last row: `sync-hosts` ships read-only adapters for `codex`, `claude_code`, `openclaw`, and `hermes`. Grok's own cross-session memory (`[memory] enabled` in `~/.grok/config.toml`, experimental and off by default) is **not** ingested. If you enable Grok's native memory, that memory stays private to Grok — the cross-agent bus does not see it. Writing through `gigabrain_remember` is what makes a fact visible to every other agent.

Grok does support `SessionStart` hooks (`~/.grok/hooks/`), which is the natural place to inject a session brief; Gigabrain does not install one today.

## Troubleshooting

- **`unable to open database file` from a `gigabrain_*` call** — the server process is up but cannot open the store. Two things to check. First the config path: the `--config` in your MCP entry must point at an existing store (`npx gigabrainctl doctor --config <path> --target both` prints the resolved root and row counts). Second the sandbox: Gigabrain's SQLite runs in WAL mode and needs **write** access to the store even for reads, so a profile that denies or read-onlys `~/.gigabrain` breaks recall. The built-in `workspace`, `read-only`, and `strict` profiles restrict writes to the CWD, `~/.grok/`, and temp dirs. Isolate it with one run:

  ```bash
  grok -p "call gigabrain_recall for 'test'" --sandbox off
  ```

  If that works and your normal profile does not, grant the store explicitly in `~/.grok/sandbox.toml` (verified to work):

  ```toml
  [profiles.your-profile]
  extends = "workspace"
  read_write = ["<absolute path to your home>/.gigabrain"]
  ```

  The active profile is the `[sandbox] profile` value in `~/.grok/config.toml`, or whatever `--sandbox` / `GROK_SANDBOX` sets for the run. Note that `grok mcp doctor` still reports the server healthy in this state — it starts the process and lists tools, it never opens the store.
- **Tool missing in a session** — `grok mcp list` first. If the server is listed but not loaded, run `grok mcp doctor`; a stdio server that exits immediately is usually a bad `--config` path (the file must exist) or a `node` not on the resolved PATH — use an absolute interpreter path.
- **Empty recalls** — you are probably pointed at a different store. `npx gigabrainctl doctor --config ~/.gigabrain/config.json --target both` prints the resolved store root and row counts; compare with the `--config` in `~/.grok/config.toml`.
- **Project-scope server silently skipped** — folder trust. Run `/hooks-trust` in that repo or move the entry to user scope.

## Related

- [Codex setup](setup-codex.md) · [Claude Code setup](setup-claude.md) · [Remote MCP](setup-remote-mcp.md)
- [Recall behaviour](recall.md) · [Configuration](configuration.md)
