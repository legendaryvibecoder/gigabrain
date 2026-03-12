# Gigabrain deep eval summary — 2026-03-11

## Scope
Broadened post-patch evaluation for recall hygiene, duplicate suppression, and runtime quality gating.

Two layers were run:
1. **Custom deep recall eval** against a seeded local fixture with adversarial/noisy queries and repeated runs
2. **Full executable repo suite** via `node tests/run-all.js`

## Deep recall eval
Artifact inputs/outputs:
- harness: `eval/run-deep-recall-eval.js`
- report: `eval/deep-recall-eval-2026-03-11.json`
- report summary: `eval/deep-recall-eval-2026-03-11.md`

### Coverage
- 23 cases
- 7 repeated runs per case
- 161 total invocations

### Headline numbers
- overall cases passed: **20 / 23**
- overall invocation pass rate: **140 / 161 = 86.96%**
- recall latency: **0.87ms median**, **1.82ms p95**, **6.46ms max**
- orchestrator latency: **2.55ms median**, **8.96ms p95**, **10.03ms max**

### Patch-focused metrics
These are the metrics directly tied to the landed recall hardening work.

- sanitization exactness on noisy query cases: **84 / 84 = 100%**
- top-fact retrieval on Novara entity/noisy cases: **84 / 84 = 100%**
- near-duplicate leak rows after recall ranking: **0**
- instruction-text leaks in entity hints: **0**
- junk-wrapper leaks in entity hints: **0**
- transcript-artifact leaks in entity hints: **0**
- shared-scope `MEMORY.md` privacy leaks: **0**
- visible provenance leaks (`src=`): **0**
- January temporal native-hit cases: **7 / 7**
- March top-hit temporal specificity cases: **7 / 7**
- out-of-window February leakage in March query: **0 / 7**
- stale-relative-date marker inclusion for Tria case: **7 / 7**

### Exploratory misses outside the exact patch target
The remaining 3 failing cases were exploratory probes, not regressions in the patched hygiene/dedupe/quality goals:
- `recall-atlas-identity` — identity recall prioritization gap in this synthetic fixture
- `recall-season-preference` — preference recall gap in this synthetic fixture
- `orch-timeline-brief` — generic month-only query stayed `quick_context` instead of `timeline_brief`

## Full repo suite
Command:
- `node tests/run-all.js`

Result:
- **20 / 20 executable tests passed**
- exit code: **0**

Included suites:
- 12 unit tests
- 7 integration/regression tests before performance
- 1 performance/nightly test

Named tests passed:
- `unit-config-test.js`
- `unit-policy-test.js`
- `unit-projection-store-test.js`
- `unit-capture-service-test.js`
- `unit-memory-actions-test.js`
- `unit-native-promotion-test.js`
- `unit-person-service-test.js`
- `unit-world-model-test.js`
- `unit-orchestrator-test.js`
- `unit-llm-router-test.js`
- `unit-native-sync-query-test.js`
- `unit-vault-mirror-test.js`
- `integration-audit-maintenance-test.js`
- `integration-setup-first-run-test.js`
- `integration-vault-cli-test.js`
- `integration-migration-and-api-test.js`
- `integration-native-recall-test.js`
- `integration-bridge-contract-routes-test.js`
- `regression-memory-behavior-test.js`
- `performance-nightly-test.js`

## Assessment
The shipped patch goals are validated strongly:
- hygiene is materially stronger and now robust to the user-provided metadata shape tested here
- duplicate suppression is holding in ranked recall
- runtime quality gating prevents junk/system-wrapper recall leakage
- broad repo regression coverage stayed green

## Follow-up candidates
Not required for this patch, but exposed by the expanded eval:
1. improve agent-identity recall selection for self-referential prompts
2. improve preference recall for short preference questions
3. reconsider whether generic month-only prompts should escalate to `timeline_brief`
