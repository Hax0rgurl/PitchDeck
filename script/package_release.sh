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
ZIP_PATH="$ROOT/release/$APP_NAME-$VERSION-mac-$ARCH.zip"
CHECKSUM_PATH="$ZIP_PATH.sha256"
CLEAN_BUILD_ROOT="$(mktemp -d /private/tmp/pitchdeck-clean-build.XXXXXX)"
STAGING_ROOT="$(mktemp -d /private/tmp/pitchdeck-release.XXXXXX)"
PACKAGE_DIR="$STAGING_ROOT/$APP_NAME-$VERSION-mac-$ARCH"
STAGED_ZIP="$STAGING_ROOT/$APP_NAME-$VERSION-mac-$ARCH.zip"
VALIDATION_ROOT="$STAGING_ROOT/fresh-extraction"
APP_PATH="$CLEAN_BUILD_ROOT/release/mac-$ARCH/$APP_NAME.app"
ASAR_PATH="$APP_PATH/Contents/Resources/app.asar"
ASAR_TOOL="$CLEAN_BUILD_ROOT/node_modules/.bin/asar"
FINDER_DUPLICATE_PATTERN='(^|/)[^/]+ 2(\.[^/]*)?$'

export ELECTRON_CACHE="${ELECTRON_CACHE:-$PITCHDECK_CACHE_ROOT/electron}"
export ELECTRON_BUILDER_CACHE="${ELECTRON_BUILDER_CACHE:-$PITCHDECK_CACHE_ROOT/electron-builder}"
mkdir -p "$ELECTRON_CACHE" "$ELECTRON_BUILDER_CACHE"

for relative_path in \
  package.json \
  package-lock.json \
  vite.config.js \
  index.html \
  src \
  server \
  electron \
  resources \
  script \
  test
do
  ditto --norsrc --noextattr --noacl \
    "$ROOT/$relative_path" \
    "$CLEAN_BUILD_ROOT/$relative_path"
done

(
  cd "$CLEAN_BUILD_ROOT"
  npm ci --no-audit --no-fund
  npm run check
  npm run package:mac
)

if [[ ! -d "$APP_PATH" ]]; then
  echo "Expected app was not created: $APP_PATH" >&2
  exit 1
fi

if [[ ! -x "$ASAR_TOOL" || ! -f "$ASAR_PATH" ]]; then
  echo "Clean build did not produce the expected app.asar tooling or archive." >&2
  exit 1
fi

validate_asar() {
  local app_path="$1"
  local archive_path="$app_path/Contents/Resources/app.asar"
  local archive_listing="$STAGING_ROOT/app-asar-list.txt"
  local duplicate_report="$STAGING_ROOT/app-asar-finder-duplicates.txt"

  if [[ ! -f "$archive_path" ]]; then
    echo "Expected app.asar was not found: $archive_path" >&2
    exit 1
  fi

  "$ASAR_TOOL" list "$archive_path" > "$archive_listing"

  if LC_ALL=C grep -E "$FINDER_DUPLICATE_PATTERN" "$archive_listing" \
    > "$duplicate_report"
  then
    echo "Release blocked: app.asar contains Finder-style duplicate filenames:" >&2
    sed -n '1,80p' "$duplicate_report" >&2
    exit 1
  fi
}

validate_asar "$APP_PATH"

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
validate_asar "$VALIDATION_ROOT/$APP_NAME-$VERSION-mac-$ARCH/$APP_NAME.app"
codesign --verify --deep --strict --verbose=2 \
  "$VALIDATION_ROOT/$APP_NAME-$VERSION-mac-$ARCH/$APP_NAME.app"

if [[ -e "$ZIP_PATH" ]]; then
  mv "$ZIP_PATH" "$STAGING_ROOT/previous-$APP_NAME-$VERSION-mac-$ARCH.zip"
fi
cp "$STAGED_ZIP" "$ZIP_PATH"

ZIP_BASENAME="$(basename "$ZIP_PATH")"
(
  cd "$(dirname "$ZIP_PATH")"
  shasum -a 256 "$ZIP_BASENAME" > "$(basename "$CHECKSUM_PATH")"
  shasum -a 256 -c "$(basename "$CHECKSUM_PATH")"
)

echo "$ZIP_PATH"
echo "$CHECKSUM_PATH"
