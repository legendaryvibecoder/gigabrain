# Gigabrain smoke/regression receipt — 2026-03-11

## Scope
Implemented targeted runtime improvements for:
1. recall hygiene (query sanitization at recall/orchestrator entry)
2. duplicate suppression (near-duplicate collapse during recall ranking)
3. quality gating (reject junk-wrapper/system-artifact rows during recall)

## Files changed
- `lib/core/recall-service.js`
- `lib/core/orchestrator.js`
- `tests/integration-native-recall-test.js`

## Validation commands
- `node --input-type=module -e "import('./tests/unit-orchestrator-test.js').then(m=>m.run())"`
- `node --input-type=module -e "import('./tests/unit-native-sync-query-test.js').then(m=>m.run())"`
- `node --input-type=module -e "import('./tests/integration-native-recall-test.js').then(m=>m.run())"`
- `node --input-type=module -e "import('./tests/integration-bridge-contract-routes-test.js').then(m=>m.run())"`
- `node --input-type=module -e "import('./tests/regression-memory-behavior-test.js').then(m=>m.run())"`

## Result
- status: passed
- marker: `SMOKE_OK`

## Notes
- recall now strips exec/untrusted-metadata wrappers before intent/entity detection and retrieval
- recall now filters junk/system-wrapper rows even if older bad data already exists in the registry
- recall now suppresses strong near-duplicate rows after rerank to reduce repeated answer context
- full/adversarial eval suite intentionally not started yet; waiting for owner confirmation
