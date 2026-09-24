#!/bin/sh
# Container entrypoint for the Navide Registry.
#
# The registry refuses private-key files that are not owner-only (0600)
# regular files. Docker/Swarm secrets are mounted read-only and usually 0444
# (or keep the host file's mode for Compose file secrets), so the keys are
# copied into an owner-only directory (a tmpfs in the Compose example) before
# the server starts. The trust config points at the copies.
set -eu
umask 077

src_dir="${REGISTRY_SECRET_SOURCE_DIR:-/run/secrets}"
key_dir="${REGISTRY_KEY_DIR:-/run/navide-keys}"
mkdir -p "$key_dir"
chmod 700 "$key_dir"
for name in navide-registry-root.pem navide-registry-signer.pem; do
  if [ -e "$src_dir/$name" ]; then
    rm -f "$key_dir/$name"
    cat "$src_dir/$name" > "$key_dir/$name"
    chmod 600 "$key_dir/$name"
  fi
done

if [ -n "${REGISTRY_ADMIN_TOKEN_FILE:-}" ]; then
  REGISTRY_ADMIN_TOKEN="$(cat "$REGISTRY_ADMIN_TOKEN_FILE")"
  export REGISTRY_ADMIN_TOKEN
fi

# REGISTRY_ROOT_PATH (e.g. /registry) is applied by the app itself, so a proxy
# may forward the prefix unchanged (AWS ALB) or strip it. Do not also pass
# uvicorn --root-path. One worker: the registry stores its index in SQLite.
exec uvicorn registry.app:app \
  --host "${REGISTRY_HOST:-0.0.0.0}" \
  --port "${REGISTRY_PORT:-8787}" \
  "$@"
