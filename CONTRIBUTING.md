# Contributing to Gigabrain

Thanks for contributing to Gigabrain.

Gigabrain is the long-term memory layer for OpenClaw agents. The project mixes product behavior, memory quality policy, and operational workflows, so small changes can have outsized user impact. This guide is here to make outside contributions easier and safer.

## Good First Contribution Areas

- Docs, setup UX, and onboarding
- Tests for memory behavior, recall quality, and vault generation
- Web console usability fixes
- Performance improvements with benchmarks
- Small bug fixes with clear reproduction steps

If you want to work on a larger behavior change, open an issue or discussion first so we can align on product intent before you spend time implementing it.

## Before You Start

1. Read the main [README](README.md) for the current architecture and workflows.
2. Check [SECURITY.md](SECURITY.md) if your change touches auth, recall injection, file access, or the web console.
3. Look for existing issues or discussions before starting duplicate work.

## Development Setup

Prerequisites:

- Node.js 22 or newer
- OpenClaw only if you want to test the plugin end-to-end
- Python 3.10+ only if you want to run the optional `memory_api`

Typical local setup:

```bash
git clone https://github.com/legendaryvibecoder/gigabrain.git
cd gigabrain
npm install
npm test
```

Useful commands:

```bash
npm test
npm run setup -- --help
node scripts/gigabrainctl.js doctor --config ~/.openclaw/openclaw.json
node scripts/gigabrainctl.js vault report --config ~/.openclaw/openclaw.json
```

## Change Guidelines

- Keep changes narrow and reversible when possible.
- Prefer config- and test-backed changes over behavior drift hidden in prompts.
- Preserve the intentional memory contract:
  - native markdown is the human-readable layer
  - registry memory is the structured recall layer
  - explicit remember intent is treated as meaningful product behavior
- Avoid introducing user- or machine-specific paths, hostnames, or private runtime artifacts into docs, fixtures, tests, or release notes.

## Tests

Run the baseline before opening a PR:

```bash
npm test
```

If your change is focused, mention exactly what you tested in the PR description. For example:

- unit tests only
- full `npm test`
- manual Nimbus/OpenClaw verification
- vault build / recall smoke test

## Pull Requests

Please include:

- what changed
- why it changed
- how you verified it
- any behavior, migration, or rollout risk

Small PRs are easier to review than large mixed refactors.

## Security

Do not open public issues for vulnerabilities. Use the private reporting flow in [SECURITY.md](SECURITY.md).

## Questions

- Use GitHub Discussions for ideas, design questions, or usage help
- Use Issues for concrete bugs, regressions, or scoped feature requests
