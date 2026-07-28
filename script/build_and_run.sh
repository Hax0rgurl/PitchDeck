#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_NAME="PITCHDECK"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  for candidate in \
    "$HOME/pinokio/bin/miniforge/bin" \
    "/opt/homebrew/bin" \
    "/usr/local/bin"
  do
    if [[ -x "$candidate/node" && -x "$candidate/npm" ]]; then
      export PATH="$candidate:$PATH"
      break
    fi
  done
fi

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "PITCHDECK needs Node.js and npm to run from source." >&2
  exit 1
fi

pkill -f "Electron.*${APP_NAME}" 2>/dev/null || true
pkill -f "pitchdeck-local.*electron" 2>/dev/null || true

npm run build
npx electron .
