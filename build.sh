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
  echo "Synced all version files to $NEW"
fi

echo ""
echo "=== [1/3] Building Python backend ==="
cd backend
uv run pyinstaller agent_team_backend.spec
cd ..

echo ""
echo "=== [2/3] Packaging Electron app ==="
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm dist

echo ""
echo "=== [3/3] Done ==="
open dist-release
