#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
HOME_DIR=${HOME:-}
if [ -z "$HOME_DIR" ] && command -v python3 >/dev/null 2>&1; then
  HOME_DIR=$(python3 -c 'import os; print(os.path.expanduser("~"))' 2>/dev/null || true)
fi

prepend_path() {
  if [ -n "${1:-}" ] && [ -d "$1" ]; then
    PATH="$1${PATH:+:$PATH}"
  fi
}

prepend_path "/opt/homebrew/bin"
prepend_path "/usr/local/bin"
prepend_path "/opt/local/bin"
if [ -n "$HOME_DIR" ]; then
  prepend_path "$HOME_DIR/.volta/bin"
  prepend_path "$HOME_DIR/.local/bin"
  prepend_path "$HOME_DIR/.fnm"
  prepend_path "$HOME_DIR/.fnm/bin"
  prepend_path "$HOME_DIR/.asdf/bin"
  prepend_path "$HOME_DIR/.asdf/shims"
  for dir in "$HOME_DIR"/.nvm/versions/node/*/bin; do
    if [ -d "$dir" ]; then
      prepend_path "$dir"
    fi
  done
fi
export PATH="${PATH:+$PATH:}/usr/bin:/bin:/usr/sbin:/sbin"

if ! command -v node >/dev/null 2>&1; then
  echo "Gigabrain Claude Desktop launcher could not find Node.js 22+." >&2
  echo "Install Node.js 22+ and ensure PATH includes one of: Homebrew, Volta, ~/.nvm, ~/.fnm, ~/.asdf, or ~/.local/bin." >&2
  exit 127
fi

exec node "$SCRIPT_DIR/gigabrain-mcp.js" "$@"
