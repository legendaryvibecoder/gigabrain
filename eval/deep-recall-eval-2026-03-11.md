# Gigabrain deep recall eval — 2026-03-11

## Summary
- runs per case: 7
- total cases: 23
- total invocations: 161
- passed cases: 23/23
- case pass rate: 100.0%
- invocation pass rate: 100.0%
- recall latency median/p95: 0.91ms / 1.89ms
- orchestrator latency median/p95: 2.45ms / 4.33ms

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
- orchestrator_strategy_checks: 28/28
- orchestrator_deep_lookup_checks: 14/28

## By group
- dedupe_quality: 1/1 cases, 100.0% case pass, 100.0% invocation pass, p95 1.30ms
- entity: 1/1 cases, 100.0% case pass, 100.0% invocation pass, p95 6.70ms
- identity: 1/1 cases, 100.0% case pass, 100.0% invocation pass, p95 4.21ms
- orchestrator: 4/4 cases, 100.0% case pass, 100.0% invocation pass, p95 4.33ms
- preference: 1/1 cases, 100.0% case pass, 100.0% invocation pass, p95 5.50ms
- privacy: 1/1 cases, 100.0% case pass, 100.0% invocation pass, p95 1.75ms
- provenance: 1/1 cases, 100.0% case pass, 100.0% invocation pass, p95 2.10ms
- sanitization: 11/11 cases, 100.0% case pass, 100.0% invocation pass, p95 1.33ms
- temporal: 2/2 cases, 100.0% case pass, 100.0% invocation pass, p95 4.51ms

## Failures
- none
