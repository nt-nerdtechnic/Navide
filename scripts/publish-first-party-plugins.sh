#!/usr/bin/env bash
# Build, pack, sign and publish the first-party v2 plugins to a Registry.
#
#   NAVIDE_REGISTRY_URL=https://server.navide.dev/registry \
#   NAVIDE_PUBLISHER_KEY=~/navide-signing/plugin_publisher.key \
#   NAVIDE_PLUGIN_TOKEN=<navide publisher bearer token> \
#   scripts/publish-first-party-plugins.sh [--skip-build] [--only git|plans]
#
# navide.git is frontend-only and is published once as `universal`.
# navide.plans ships a PyInstaller backend, so its package is built for, and
# published as, the current host target only (`<platform>-<arch>`, e.g.
# darwin-arm64). Other targets must be built and published from a machine of
# that platform/architecture with the same command; the Registry keeps one
# artifact per target of the same version and 409s a target published twice.
#
# Packing and signing reuse the Registry's own `navide-plugin` CLI
# (marketplace/registry/registry/cli.py). The publisher key path and the token
# are read from the environment and never printed; the token reaches the CLI
# through NAVIDE_PLUGIN_TOKEN rather than argv.
#
# The `navide` publisher must be registered on the Registry first (one-off
# admin step, see marketplace/registry/README.md "Publishing first-party
# plugins").
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SKIP_BUILD=0
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --skip-build) SKIP_BUILD=1 ;;
    --only) ONLY="${2:?--only needs git or plans}"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
case "$ONLY" in
  ""|git|plans) ;;
  *) echo "--only must be git or plans" >&2; exit 2 ;;
esac

: "${NAVIDE_REGISTRY_URL:?set NAVIDE_REGISTRY_URL (e.g. https://server.navide.dev/registry)}"
: "${NAVIDE_PUBLISHER_KEY:?set NAVIDE_PUBLISHER_KEY to the navide publisher private key path}"
: "${NAVIDE_PLUGIN_TOKEN:?set NAVIDE_PLUGIN_TOKEN to the navide publisher bearer token}"
export NAVIDE_PLUGIN_TOKEN
if [ ! -f "$NAVIDE_PUBLISHER_KEY" ]; then
  echo "NAVIDE_PUBLISHER_KEY does not point at a file" >&2
  exit 1
fi

OUT_DIR="$ROOT/dist-plugins/publish"
mkdir -p "$OUT_DIR"
HOST_TARGET="$(node -p "process.platform + '-' + process.arch")"

navide_plugin() {
  uv --project "$ROOT/marketplace/registry" run --quiet navide-plugin "$@"
}

# publish_dir <built plugin dir> <registry target>
publish_dir() {
  local src="$1" target="$2"
  local id version vsix sig
  id="$(node -p "require('$src/manifest.json').id")"
  version="$(node -p "require('$src/manifest.json').version")"
  vsix="$OUT_DIR/$id-$version-$target.vsix"
  sig="$vsix.sig"
  echo "==> Packing $id $version ($target)"
  navide_plugin pack "$src" --out "$vsix"
  echo "==> Signing $(basename "$vsix")"
  navide_plugin sign "$vsix" --key "$NAVIDE_PUBLISHER_KEY" --out "$sig"
  echo "==> Publishing $id $version ($target) to $NAVIDE_REGISTRY_URL"
  navide_plugin publish "$vsix" --registry "$NAVIDE_REGISTRY_URL" \
    --signature "$sig" --target "$target"
}

if [ "$ONLY" != "plans" ]; then
  if [ "$SKIP_BUILD" -eq 0 ]; then
    pnpm run build:git:v2
  fi
  publish_dir "$ROOT/dist-plugins/navide-git" universal
fi

if [ "$ONLY" != "git" ]; then
  if [ "$SKIP_BUILD" -eq 0 ]; then
    pnpm run build:plans:v2
    pnpm run build:plans:backend
  fi
  backend="$ROOT/dist-plugins/navide-plans/backend/navide-plans"
  case "$HOST_TARGET" in win32-*) backend="$backend.exe" ;; esac
  if [ ! -x "$backend" ]; then
    echo "missing Plans backend executable: $backend (run without --skip-build)" >&2
    exit 1
  fi
  echo "==> Plans backend: $(file -b "$backend" 2>/dev/null || echo unknown)"
  publish_dir "$ROOT/dist-plugins/navide-plans" "$HOST_TARGET"
fi
