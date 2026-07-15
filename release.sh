#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\n\t'

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

VERSION="${1:-}"
VERSION="${VERSION#v}"
TAG="v${VERSION}"
VERSION_FILES=(
  package.json
  backend/agent_team_backend/__init__.py
  backend/pyproject.toml
  backend/uv.lock
)

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

if [[ $# -ne 1 || ! "$VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  fail "usage: ./release.sh X.Y.Z"
fi

for command in git node pnpm uv; do
  command -v "$command" >/dev/null || fail "required command not found: $command"
done

[[ "$(git branch --show-current)" == "main" ]] || fail "releases must be prepared from main"
[[ -z "$(git status --porcelain --untracked-files=all)" ]] || \
  fail "working tree is not clean; commit or stash all changes first"

echo "Fetching release refs..."
git fetch origin main --tags
git merge-base --is-ancestor origin/main HEAD || \
  fail "local main has diverged from origin/main; synchronize it before releasing"

git rev-parse "$TAG" >/dev/null 2>&1 && fail "local tag already exists: $TAG"
if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  fail "remote tag already exists: $TAG"
fi

pnpm release:check

CURRENT="$(node -p "require('./package.json').version")"
echo ""
echo "Release: $CURRENT -> $VERSION"
echo "Source:  $(git rev-parse --short HEAD)"
echo "Target:  nt-nerdtechnic/Navide"
printf "Prepare %s? [y/N]: " "$TAG"
read -r confirmed || confirmed=""
if [[ ! "$confirmed" =~ ^[Yy]$ ]]; then
  echo "Release cancelled."
  exit 0
fi

version_changed=false
rollback_version_files() {
  status=$?
  if [[ $status -ne 0 && "$version_changed" == true ]]; then
    echo "Release preparation failed; restoring version files." >&2
    git restore -- "${VERSION_FILES[@]}"
  fi
  exit "$status"
}
trap rollback_version_files EXIT

version_changed=true
node scripts/set-release-version.mjs "$VERSION"
uv --project backend lock
pnpm release:check "$TAG"

echo ""
echo "=== Release gates ==="
pnpm typecheck
pnpm test:run
uv --project backend run pytest backend/tests

echo ""
echo "=== Building release artifacts ==="
(
  cd backend
  uv run pyinstaller --noconfirm agent_team_backend.spec
)
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm dist

unexpected_changes="$(
  git status --porcelain --untracked-files=all \
    | sed -E 's/^.. //' \
    | grep -Ev '^(package.json|backend/agent_team_backend/__init__\.py|backend/pyproject\.toml|backend/uv\.lock)$' \
    || true
)"
[[ -z "$unexpected_changes" ]] || \
  fail "unexpected source changes appeared during release preparation:\n$unexpected_changes"

git add -- "${VERSION_FILES[@]}"
git diff --cached --check
git commit -m "chore: release $TAG" -- "${VERSION_FILES[@]}"
version_changed=false
git tag -a "$TAG" -m "Navide $TAG"
trap - EXIT

echo ""
echo "Prepared $TAG at $(git rev-parse --short HEAD)."
printf "Push main and %s to GitHub to publish it? [y/N]: " "$TAG"
read -r publish || publish=""
if [[ "$publish" =~ ^[Yy]$ ]]; then
  git push origin main
  git push origin "$TAG"
  echo "Published source and tag. GitHub Actions will create the signed release:"
  echo "https://github.com/nt-nerdtechnic/Navide/actions"
else
  echo "Release remains local. Publish later with:"
  echo "  git push origin main"
  echo "  git push origin $TAG"
fi
