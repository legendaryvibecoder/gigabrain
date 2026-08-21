# Public security review

Review date: 2026-08-21
Release candidate: `0.11.0`

This is a point-in-time engineering review, not a certification or warranty.

## Automated results

| Check | Result |
| --- | --- |
| Node dependency audit | 0 known vulnerabilities across the installed production dependency graph |
| Python dependency audit | 0 known vulnerabilities after updating `lxml-html-clean` to `0.4.5` and `lxml` to `6.1.1` |
| Gitleaks, current release tree | 0 findings |
| PII/secret scanner, current release tree + npm inventory | 0 findings; the source-private release policy checks blocked identifiers, while the public scanner ships generic path/IP/device/contact/email/secret detectors and synthetic identifier tests. Private identifier hashes and matched values are absent from the public package and failure output |
| Checkpoint and remote-MCP tests | Deterministic tests cover immutable checkpoint records, proposal/decision authority, exact-scope isolation, OAuth JWT/JWKS validation, audience/resource checks, tool discovery, path redaction, rate limits, and read-only defaults. The protected pull request must rerun them before merge |
| Utility-memory hardening tests | Deterministic tests cover opt-in session injection, observational recall, project/personal scope rejection, relevance floors, rank-fused cross-store ordering, one checkpoint per stable session, and clean MCP shutdown on stdin EOF |
| Bandit, optional Python console | 0 high-severity findings |
| Python runtime security tests | Authentication, route coverage, headers, TTL parsing, DNS-pinned SSRF defenses, bounded upload/URL/JSON-body reads, bounded collection fields, token-rotation-resistant rate keys, pagination bounds, scope-id concealment, connection cleanup, loopback-only recall proxying, duplicate-id conflict handling, audit heuristics, hashed document identifiers, and atomic document writes pass |
| CodeQL | The public repository reported zero open alerts before this candidate. Branch protection requires fresh JavaScript/TypeScript and Python analyses on the candidate before merge |

Bandit reports 19 medium-severity and 14 low-severity heuristic findings. One medium finding is the literal `0.0.0.0` in a private-host rejection check, not a server bind. The other medium findings are SQL strings assembled from fixed clause lists, fixed table allowlists, or generated `?` placeholders; user-controlled values remain parameterized. The low findings cover similarly reviewed hardening heuristics. They were reviewed and are retained without suppressing the scanner output.

## Manual review areas

- Every FastAPI data route declares `require_token`; scoped tokens are filtered before row return or proxy recall, and inaccessible per-id memories return the same `404` as missing ids.
- Automatic session recall injection and synthesized session preludes are disabled by default. Explicit project scopes exclude shared and personal-profile stores, observational recall cannot trigger sync or world-model rebuilds, and explicit scope/target mismatches fail closed.
- Cross-store recall uses reciprocal-rank fusion with an absolute-quality factor instead of comparing backend-specific raw scores. Queries below the configured lexical or dense-similarity floor return no result.
- Checkpoint writes group native sections atomically and deduplicate by stable session id, preventing repeated teardown events from rewriting the same checkpoint.
- Node HTTP data routes use timing-safe token checks, bounded bodies, input validation, bounded per-peer rate-limit state, and authentication-failure limits for every registered protected route. Expensive benchmark, recall, control, and suggestion routes have explicit budgets. Landing and health routes contain no memory data. The unsafe `GB_ALLOW_NO_AUTH=1` development bypass is explicit, warned, and documented as loopback-only.
- Uploads read at most `MAX_UPLOAD_BYTES + 1`; stored raw-file extensions are allowlisted; PDF page and extracted-text limits are enforced.
- JSON and multipart bodies are rejected above configurable hard byte caps before validation or multipart parsing; duplicate Content-Length headers fail closed; and document metadata, tag collections, and merge-id collections have count or per-item bounds.
- URL import is disabled by default. Enabling it also requires an exact host allowlist. Redirects and ambient proxy variables are disabled, nonstandard ports and userinfo are rejected, private/unverifiable peers fail closed, one validated public address is pinned for the request socket, TLS still verifies the original hostname, and response bytes are streamed through a cap.
- The recall-diagnostics proxy accepts only literal loopback hosts and disables ambient proxy variables, so the console or gateway token is never forwarded to an operator-supplied off-host URL.
- Networked LLM and remote-bridge endpoints reject remote plaintext HTTP; Ollama accepts only canonical loopback hosts. Cloud audit review skips credential-risk rows before transport, masks supported PII shapes locally, and strips the original memory scope.
- Remote MCP binds to loopback by default, is read-only by default, and requires an exact server-side memory-scope allowlist. Production tokens are verified against a configured issuer/JWKS and checked for expiry, subject, audience/resource, OAuth permissions, and memory scopes. Host and browser Origin controls, request-size limits, per-peer/per-subject rate limits, and response path redaction are applied before authorized tools return data. `--allow-no-auth` remains a loopback-only development mode.
- Sensitive local inputs use no-follow regular-file reads with explicit size limits. Generated state and reports use exclusive unpredictable staging files, private modes, flush-before-rename behavior, and atomic replacement.
- The optional Obsidian findings inbox is disabled by default, restricts note targets to bounded relative paths, accepts only verified loopback HTTPS, and supports an operator-provided CA instead of disabling certificate validation.
- Security headers deny framing, MIME sniffing, referrer leakage, and unnecessary browser permissions.
- The browser console has no third-party runtime assets; its graph is rendered with local SVG. CSP authorizes the console's single inline script and style blocks by their exact SHA-256 hashes, without `unsafe-inline`, while restricting connections, fonts, and images to the same origin (plus data images). Dynamic memory text is inserted through escaping or text-only DOM APIs.
- The pinned CodeQL workflow analyzes both JavaScript/TypeScript and Python; a fresh hosted run with no unresolved actionable alert remains a pre-visibility external gate.
- UTC normalization fixes silent failures when comparing legacy naive timestamps with aware current time.
- Public source is built from an explicit allowlist into a fresh root commit; the legacy private engineering repository is not made public in place.
- Repository-only test inventory and private release-builder scripts are omitted from the public package. The reproducible GitHub metadata auditor and a self-contained runtime smoke test remain public, and the checker verifies the exact package-script transform before packing.

## Privacy-release architecture

The private engineering repository contains non-public plans, raw development artifacts, and legacy GitHub metadata that fail the public-surface gate. Rewriting only `main` would not remove pull-request refs, issue edit history, release metadata, or other GitHub objects.

The release process therefore creates a new repository history containing only reviewed files, uses a noreply author identity, scans the exact npm payload, and audits GitHub metadata before visibility changes. A public release must never be produced by toggling the legacy repository from private to public.

## Residual risks

- Local memory content is not an encrypted vault; another process or account with filesystem access can read it.
- A memory can be wrong, malicious, or privacy-sensitive without matching a secret signature.
- Optional models and remote bridges expand the trust boundary to infrastructure chosen by the operator.
- A remote MCP deployment adds the operator's TLS ingress, OAuth provider, connector configuration, and network perimeter to the trust boundary. Gigabrain does not supply or certify those components.
- Passing the protocol tests does not replace a real-client conformance test in Claude or ChatGPT; product connector behavior can change independently of this release.
- URL allowlisting plus address pinning blocks the reviewed rebinding path but cannot make an operator-controlled remote site or its response trustworthy.
- SQLite is not a distributed multi-writer database; external file sync must not create concurrent writers.
- Dependencies and advisories change after this dated review.
- Generated reports and bundles can disclose memory if the operator shares them.

See [SECURITY.md](../../SECURITY.md) for private vulnerability reporting and [privacy-model.md](privacy-model.md) for the complete data boundary.
