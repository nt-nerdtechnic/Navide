#!/usr/bin/env bash
# Check for open GitHub issues and notify when new ones appear.
#
# Usage:
#   scripts/check-issues.sh           # print open issues; notify on new ones
#   scripts/check-issues.sh --all     # also list already-seen open issues
#   scripts/check-issues.sh --quiet   # no macOS notification, exit code only
#
# Exit codes: 0 = no open issues, 1 = open issues exist, 2 = error (e.g. gh/auth).
#
# Seen-issue state lives in ~/.cache/navide-issue-check/seen so repeat runs only
# notify about issues that appeared since the last run. Wire it into cron/launchd
# to poll automatically (see the block at the bottom of this file).

set -euo pipefail

NOTIFY=1
SHOW_ALL=0
for arg in "$@"; do
  case "$arg" in
    --quiet) NOTIFY=0 ;;
    --all)   SHOW_ALL=1 ;;
    -h|--help)
      sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

if ! command -v gh >/dev/null 2>&1; then
  echo "error: gh CLI not found" >&2
  exit 2
fi

REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null)" || {
  echo "error: not a GitHub repo or gh not authenticated (try: gh auth switch)" >&2
  exit 2
}

# number<TAB>title, one per open issue
ISSUES="$(gh issue list --state open --limit 100 --json number,title \
  -q '.[] | "\(.number)\t\(.title)"' 2>/dev/null)" || {
  echo "error: failed to fetch issues for $REPO" >&2
  exit 2
}

if [ -z "$ISSUES" ]; then
  echo "No open issues in $REPO."
  exit 0
fi

STATE_DIR="$HOME/.cache/navide-issue-check"
STATE_FILE="$STATE_DIR/seen"
mkdir -p "$STATE_DIR"
touch "$STATE_FILE"

open_count=0
new_count=0
new_titles=""
while IFS=$'\t' read -r num title; do
  [ -n "$num" ] || continue
  open_count=$((open_count + 1))
  if grep -qx "$num" "$STATE_FILE"; then
    [ "$SHOW_ALL" -eq 1 ] && echo "  #$num  $title"
  else
    new_count=$((new_count + 1))
    new_num="$num"
    echo "NEW #$num  $title"
    new_titles="${new_titles}#${num} ${title}"$'\n'
    echo "$num" >>"$STATE_FILE"
  fi
done <<<"$ISSUES"

echo "---"
echo "$REPO: $open_count open issue(s), $new_count new since last check."

if [ "$new_count" -gt 0 ] && [ "$NOTIFY" -eq 1 ]; then
  # Click target: the single new issue when there's exactly one, else the
  # repo's issue list. $REPO and $new_num both come from gh's JSON (a
  # nameWithOwner string and an integer), so the URL needs no escaping.
  if [ "$new_count" -eq 1 ]; then
    open_url="https://github.com/$REPO/issues/$new_num"
  else
    open_url="https://github.com/$REPO/issues"
  fi

  if command -v terminal-notifier >/dev/null 2>&1; then
    # terminal-notifier shows under its own identity (not Script Editor) and,
    # unlike osascript's `display notification`, supports a click action via
    # -open. Titles are attacker-controllable but pass as argv, so they're
    # treated as data, never shell-interpolated.
    terminal-notifier \
      -title "Navide: $new_count new issue(s)" \
      -message "$new_titles" \
      -open "$open_url" \
      >/dev/null 2>&1 || true
  elif command -v osascript >/dev/null 2>&1; then
    # Fallback (no click action): pass titles via env vars and read them with
    # `system attribute` so AppleScript treats them as data, not code.
    NAVIDE_BODY="$new_titles" NAVIDE_TITLE="Navide: $new_count new issue(s)" \
      osascript -e 'display notification (system attribute "NAVIDE_BODY") with title (system attribute "NAVIDE_TITLE")' \
      >/dev/null 2>&1 || true
  fi
fi

exit 1

# --- Automate with cron (every 30 min) ---------------------------------------
# Run `crontab -e` and add (adjust the path):
#   */30 * * * * cd /Users/neillu/Desktop/Agent-Team && /bin/bash scripts/check-issues.sh --quiet >> /tmp/navide-issues.log 2>&1
#
# Note: cron has a minimal PATH; if gh isn't found, use its full path
# (run `which gh`) or add `PATH=/opt/homebrew/bin:/usr/bin:/bin` at the top of
# the crontab. gh auth uses your keychain, which cron jobs can access when run
# as your user.
