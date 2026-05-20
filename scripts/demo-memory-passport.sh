#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-$(mktemp -d "${TMPDIR:-/tmp}/gigabrain-passport-demo.XXXXXX")}"
PROJECT_ROOT="$ROOT/project"
HOME_ROOT="$ROOT/home"
CODEX_HOME="$HOME_ROOT/.codex"
CLAUDE_HOME="$HOME_ROOT/.claude"
PASSPORT_DIR="$ROOT/passport"

mkdir -p "$PROJECT_ROOT" "$CODEX_HOME/memories" "$CLAUDE_HOME/projects/demo/memory"
printf '{"name":"gigabrain-passport-demo","private":true}\n' > "$PROJECT_ROOT/package.json"
cat > "$CODEX_HOME/memories/preferences.md" <<'EOF'
- User prefers launch notes with concrete verification evidence.
- API_KEY=sk-demo-passport-redacted-1234567890
EOF
cat > "$CLAUDE_HOME/projects/demo/memory/preferences.md" <<'EOF'
- User prefers launch notes with concrete verification evidence.
- Demo handoffs should be short enough to paste manually.
EOF

export HOME="$HOME_ROOT"
export CODEX_HOME

node scripts/gigabrain-codex-setup.js --project-root "$PROJECT_ROOT" >/dev/null
CONFIG_PATH="$HOME_ROOT/.gigabrain/config.json"

node scripts/gigabrainctl.js sync-hosts \
  --config "$CONFIG_PATH" \
  --codex-home "$CODEX_HOME" \
  --claude-home "$CLAUDE_HOME" \
  --host codex,claude_code \
  --scope profile:user >/dev/null

node scripts/gigabrainctl.js passport \
  --config "$CONFIG_PATH" \
  --codex-home "$CODEX_HOME" \
  --claude-home "$CLAUDE_HOME" \
  --scope profile:user \
  --output-dir "$PASSPORT_DIR"

printf '\nMemory Passport demo written to:\n%s\n' "$PASSPORT_DIR"
