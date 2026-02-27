# Gigabrain MemoryBench Overlay

This folder provides a reproducible benchmark harness for Gigabrain vNext.

## What it does

- Calls `POST /gb/bench/recall` using the same recall path as the plugin runtime.
- Reuses `eval/cases.jsonl` for entity, identity, temporal, and correction checks.
- Supports repeated runs and median scoring.
- Supports side-by-side compare (`vCurrent` vs `vNext`).

## Run single benchmark

```bash
node bench/memorybench/run.js \
  --base-url http://127.0.0.1:18789 \
  --token "$GB_UI_TOKEN" \
  --cases eval/cases.jsonl \
  --topk 8 \
  --runs 3
```

## Compare two environments

```bash
node bench/memorybench/compare.js \
  --base-a http://host-a:18789 \
  --token-a "$TOKEN_A" \
  --label-a vCurrent \
  --base-b http://host-b:18789 \
  --token-b "$TOKEN_B" \
  --label-b vNext \
  --runs 3
```

## Compare run artifacts (baseline vs candidate)

```bash
node bench/memorybench/compare.js \
  --base "data/runs/*baseline*.json" \
  --cand "data/runs/*vnext*.json" \
  --label-a baseline \
  --label-b vNext
```

## Run official MemoryBench compare (optional)

```bash
node bench/memorybench/run-official-memorybench.js \
  --memorybench-dir ~/ext-memorybench \
  --benchmark longmemeval \
  --providers mem0,zep \
  --judge gpt-4o \
  --sample 5
```

## Output

- Per-run reports are written under `bench/memorybench/data/runs/<run-id>/report.json`.
- Exit code `2` can be used as gate when `--fail-below` is set in `run.js`.
