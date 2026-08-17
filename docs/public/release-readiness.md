# Release readiness contract

A public Gigabrain release is allowed only when every gate below is green on the exact commit and exact npm tarball being published.

## Required gates

1. `npm ci --legacy-peer-deps`
2. full Node test suite
3. Python console runtime security tests on Python 3.12
4. producer-side recall-quality regression gates; private fixtures stay out of the public repository, while the sanitized aggregate and its limitations ship in `docs/public/benchmark-evidence.*`
5. `npm audit` with zero known high/critical vulnerabilities
6. `pip-audit` with zero known vulnerabilities in `memory_api/requirements.txt`
7. PII/secret scan across Git files and the real `npm pack --dry-run` inventory
8. Gitleaks scan of the public worktree and its complete single-commit history
9. exact public-repository and npm-file allowlists
10. internal Markdown/HTML link validation
11. independent review by a different model family, with a machine-readable GO/NO-GO verdict
12. GitHub metadata audit after repository creation and before visibility changes
13. branch protection, secret scanning, push protection, dependency alerts, and private vulnerability reporting enabled
14. post-publish install, local MCP initialization, doctor, recall, package-provenance, and remote-MCP OAuth/scope smoke tests
15. a real-client Claude or ChatGPT connector conformance check before describing that client as production-ready

## Hard stops

- any personal identifier, private path, runtime database, transcript, secret, unknown binary, or internal artifact in the public mirror
- more than one root-history commit
- a public repository derived by changing the visibility of the legacy engineering repository
- a quality or security gate that did not run
- an unresolved independent-review NO-GO
- npm/GitHub version, tag, tarball digest, or source commit mismatch

The build tooling must fail closed. “Probably safe” is not a release state.
