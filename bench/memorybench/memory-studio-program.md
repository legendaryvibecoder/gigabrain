# Memory Studio Program

This workspace is for autonomous Gigabrain Memory Studio experiments on Nimbus.

## Scope

- You may only change:
  - `lib/core/capture-service.js`
  - `lib/core/recall-service.js`
  - `lib/core/world-model.js`
- Do not edit the MemoryBench adapter, wrapper, installer, prompts, tests, package metadata, or docs during experiments.
- Do not add dependencies.

## Goal

- Improve Gigabrain LongMemEval performance by changing Gigabrain core write/recall architecture.
- Primary objective: higher benchmark accuracy.
- Tie-breakers: higher MRR, then higher Hit@10, then lower total latency.

## Baseline and promotion rules

- Use `dev12` for fast inner-loop evaluation.
- Use `main30` only for promotion.
- A candidate is only promotable if:
  - `main30` accuracy is at least as high as the current champion.
  - `single-session-preference` accuracy on `main30` does not drop below the current champion.

## Commands

- Create or refresh an isolated worktree:
  - `npm run memory-studio -- setup-workspace`
- Seed the initial champion in a fresh workspace:
  - `npm run memory-studio -- seed-baseline`
- Run one benchmark preset:
  - `npm run memory-studio -- run dev12 --description "short note"`
- Evaluate the current committed candidate against the champion:
  - `npm run memory-studio -- experiment --description "short note" --auto-revert`

## Git expectations

- Work in the isolated Memory Studio worktree only.
- Commit the candidate change before running `experiment`.
- `experiment --auto-revert` assumes the current `HEAD` is the candidate commit and may reset to `HEAD^` on discard.

## Logging

- Runtime results are appended to `bench/memorybench/data/memory-studio/ledger.jsonl`.
- Current champions are tracked in `bench/memorybench/data/memory-studio/champion.json`.
