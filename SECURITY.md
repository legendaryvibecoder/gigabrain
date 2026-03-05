# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.3.x   | :white_check_mark: |
| < 0.3   | :x:                |

## Reporting a Vulnerability

**Please do not open public issues for security vulnerabilities.**

Instead, use [GitHub Security Advisories](https://github.com/legendaryvibecoder/gigabrain/security/advisories/new) to report vulnerabilities privately.

When reporting, please include:

- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (if any)

You will receive an acknowledgment within 48 hours and a detailed response within 7 days.

## Security Measures

Gigabrain enforces the following security controls:

- **Authentication**: Token-based auth on all HTTP endpoints (fail-closed)
- **Timing-safe comparison**: All token checks use `crypto.timingSafeEqual` / `hmac.compare_digest`
- **Input sanitization**: Query parameters are XML-escaped before injection into recall context
- **Path traversal guards**: Document operations validate paths against directory traversal
- **SSRF protection**: URL fetcher in web console restricts target hosts
- **No secrets in repo**: `.gitignore` covers `*.db`, `*.sqlite`, `*.pem`, `*.key`, credentials
