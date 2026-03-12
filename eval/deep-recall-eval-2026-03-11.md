# Gigabrain deep recall eval — 2026-03-11

## Summary
- runs per case: 7
- total cases: 23
- total invocations: 161
- passed cases: 20/23
- case pass rate: 87.0%
- invocation pass rate: 87.0%
- recall latency median/p95: 0.87ms / 1.82ms
- orchestrator latency median/p95: 2.55ms / 8.96ms

## Key metrics
- sanitization_exact_rate: 84/84 (100% )
- top_fact_hit_rate: 84/84
- duplicate_leak_rows_total: 0
- instruction_leaks: 0
- junk_wrapper_leaks: 0
- transcript_leaks: 0
- memory_md_privacy_leaks: 0
- provenance_leaks: 0
- temporal_january_hits: 7
- temporal_march_top_hits: 7
- temporal_february_leaks: 0
- stale_relative_markers: 7
- orchestrator_strategy_checks: 21/28
- orchestrator_deep_lookup_checks: 14/28

## By group
- dedupe_quality: 1/1 cases, 100.0% case pass, 100.0% invocation pass, p95 1.40ms
- entity: 1/1 cases, 100.0% case pass, 100.0% invocation pass, p95 6.46ms
- identity: 0/1 cases, 0.0% case pass, 0.0% invocation pass, p95 2.55ms
- orchestrator: 3/4 cases, 75.0% case pass, 75.0% invocation pass, p95 8.96ms
- preference: 0/1 cases, 0.0% case pass, 0.0% invocation pass, p95 1.82ms
- privacy: 1/1 cases, 100.0% case pass, 100.0% invocation pass, p95 1.71ms
- provenance: 1/1 cases, 100.0% case pass, 100.0% invocation pass, p95 2.02ms
- sanitization: 11/11 cases, 100.0% case pass, 100.0% invocation pass, p95 1.16ms
- temporal: 2/2 cases, 100.0% case pass, 100.0% invocation pass, p95 4.64ms

## Failures
- recall-atlas-identity: 7/7 failed runs
  - run 1: In January 2026, Jordan and Atlas worked on gigabrain architecture.
  - run 2: In January 2026, Jordan and Atlas worked on gigabrain architecture.
  - run 3: In January 2026, Jordan and Atlas worked on gigabrain architecture.
- recall-season-preference: 7/7 failed runs
  - run 1: 
  - run 2: 
  - run 3: 
- orch-timeline-brief: 7/7 failed runs
  - run 1: In March 2026, Jordan completed the vault sync stabilization.
  - run 2: In March 2026, Jordan completed the vault sync stabilization.
  - run 3: In March 2026, Jordan completed the vault sync stabilization.
