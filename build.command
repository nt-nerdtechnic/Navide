#!/bin/bash
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

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
