#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP_NAME="PITCHDECK"

pkill -f "Electron.*${APP_NAME}" 2>/dev/null || true
pkill -f "pitchdeck-local.*electron" 2>/dev/null || true

npm run build
npx electron .
