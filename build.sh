#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# ── Version bump ──────────────────────────────────────────────────────────────
CURRENT=$(node -p "require('./package.json').version")
PATCH=$(node -p "const v='$CURRENT'.split('.').map(Number); \`\${v[0]}.\${v[1]}.\${v[2]+1}\`")
MINOR=$(node -p "const v='$CURRENT'.split('.').map(Number); \`\${v[0]}.\${v[1]+1}.0\`")
MAJOR=$(node -p "const v='$CURRENT'.split('.').map(Number); \`\${v[0]+1}.0.0\`")
echo "Current version: $CURRENT"
echo "  [1] patch  ($CURRENT → $PATCH)"
echo "  [2] minor  ($CURRENT → $MINOR)"
echo "  [3] major  ($CURRENT → $MAJOR)"
echo "  [Enter]    keep $CURRENT"
printf "Choose [1/2/3 or Enter]: "
read -r choice

case "$choice" in
  1) NEW="$PATCH" ;;
  2) NEW="$MINOR" ;;
  3) NEW="$MAJOR" ;;
  "")
    NEW="$CURRENT"
    ;;
  *)
    NEW="$choice"
    ;;
esac

if [ "$NEW" != "$CURRENT" ]; then
  if ! [[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    echo "ERROR: invalid version '$NEW' (expected X.Y.Z)" >&2
    exit 1
  fi
  echo "Bumping $CURRENT → $NEW"
  # Update package.json
  node -e "
    const fs=require('fs'), p=JSON.parse(fs.readFileSync('package.json','utf8'))
    p.version='$NEW'
    fs.writeFileSync('package.json', JSON.stringify(p, null, 2)+'\n')
  "
  # Sync backend/__init__.py
  sed -i '' "s/__version__ = \".*\"/__version__ = \"$NEW\"/" backend/agent_team_backend/__init__.py
  # Sync backend/pyproject.toml
  sed -i '' "s/^version = \".*\"/version = \"$NEW\"/" backend/pyproject.toml
  # Sync backend/uv.lock with the new pyproject version
  uv --project backend lock
  echo "Synced all version files to $NEW"
fi

echo ""
echo "=== [1/4] Building Python backend ==="
cd backend
uv run pyinstaller agent_team_backend.spec
cd ..

echo ""
echo "=== [2/4] Packaging Electron app ==="
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm dist

echo ""
echo "=== [3/4] Installing to /Applications ==="
APP_PATH=$(find dist-release -maxdepth 2 -name "*.app" -type d | head -n1)
if [ -n "$APP_PATH" ]; then
  APP_NAME=$(basename "$APP_PATH")
  rm -rf "/Applications/$APP_NAME"
  cp -R "$APP_PATH" "/Applications/"
  echo "Installed: /Applications/$APP_NAME"
else
  echo "WARNING: no .app found under dist-release; skipping install"
fi

echo ""
echo "=== [4/4] Committing version bump ==="
if [ "$NEW" != "$CURRENT" ]; then
  # Pathspec commit: only these files, regardless of what else is staged
  git commit -m "chore: bump version to $NEW" -- \
    package.json \
    backend/agent_team_backend/__init__.py \
    backend/pyproject.toml \
    backend/uv.lock
  git tag "v$NEW"
  echo "Tagged: v$NEW"
else
  echo "Version unchanged; nothing to commit"
fi

echo ""
echo "Done."
open dist-release
