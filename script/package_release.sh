#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ensure_node_toolchain() {
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    return
  fi

  local candidate
  for candidate in \
    "$HOME/pinokio/bin/miniforge/bin" \
    "/opt/homebrew/bin" \
    "/usr/local/bin"
  do
    if [[ -x "$candidate/node" && -x "$candidate/npm" ]]; then
      export PATH="$candidate:$PATH"
      return
    fi
  done

  echo "PITCHDECK packaging needs Node.js and npm." >&2
  exit 1
}

ensure_node_toolchain

APP_NAME="PITCHDECK"
VERSION="$(node -p "require('./package.json').version")"
ARCH="arm64"
PITCHDECK_CACHE_ROOT="${PITCHDECK_CACHE_ROOT:-/private/tmp/pitchdeck-build-cache-${UID:-local}}"
APP_PATH="$ROOT/release/mac-$ARCH/$APP_NAME.app"
ZIP_PATH="$ROOT/release/$APP_NAME-$VERSION-mac-$ARCH.zip"
STAGING_ROOT="$(mktemp -d /private/tmp/pitchdeck-release.XXXXXX)"
PACKAGE_DIR="$STAGING_ROOT/$APP_NAME-$VERSION-mac-$ARCH"
STAGED_ZIP="$STAGING_ROOT/$APP_NAME-$VERSION-mac-$ARCH.zip"
VALIDATION_ROOT="$STAGING_ROOT/fresh-extraction"

export ELECTRON_CACHE="${ELECTRON_CACHE:-$PITCHDECK_CACHE_ROOT/electron}"
export ELECTRON_BUILDER_CACHE="${ELECTRON_BUILDER_CACHE:-$PITCHDECK_CACHE_ROOT/electron-builder}"
mkdir -p "$ELECTRON_CACHE" "$ELECTRON_BUILDER_CACHE"

npm run package:mac

if [[ ! -d "$APP_PATH" ]]; then
  echo "Expected app was not created: $APP_PATH" >&2
  exit 1
fi

mkdir -p "$PACKAGE_DIR"
ditto --norsrc --noextattr --noacl "$APP_PATH" "$PACKAGE_DIR/$APP_NAME.app"
cp "$ROOT/RELEASE_README.md" "$PACKAGE_DIR/README-FIRST.md"

xattr -cr "$PACKAGE_DIR/$APP_NAME.app"
codesign --force --deep --sign - --timestamp=none "$PACKAGE_DIR/$APP_NAME.app"
codesign --verify --deep --strict --verbose=2 "$PACKAGE_DIR/$APP_NAME.app"

(
  cd "$STAGING_ROOT"
  /usr/bin/zip -q -X -r -y "$STAGED_ZIP" "$(basename "$PACKAGE_DIR")"
)

if zipinfo -1 "$STAGED_ZIP" | grep -E '(^|/)__MACOSX/|(^|/)\._' >/dev/null; then
  echo "Release ZIP contains AppleDouble metadata." >&2
  exit 1
fi

mkdir -p "$VALIDATION_ROOT"
unzip -q "$STAGED_ZIP" -d "$VALIDATION_ROOT"
codesign --verify --deep --strict --verbose=2 \
  "$VALIDATION_ROOT/$APP_NAME-$VERSION-mac-$ARCH/$APP_NAME.app"

if [[ -e "$ZIP_PATH" ]]; then
  mv "$ZIP_PATH" "$STAGING_ROOT/previous-$APP_NAME-$VERSION-mac-$ARCH.zip"
fi
cp "$STAGED_ZIP" "$ZIP_PATH"

echo "$ZIP_PATH"
