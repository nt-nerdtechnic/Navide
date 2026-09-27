#!/usr/bin/env bash
# Print "true" when <tag> may become the Latest release, "false" when a newer
# release is already Latest.
#
# The release run marks its tag Latest on GitHub and replaces the mirror's
# releases/latest/ (the updater's feed). Re-running an old tag's run after a
# newer version shipped would otherwise move both back to the old version and
# offer every client a downgrade. The current Latest is what
# `gh release view` returns without a tag (drafts and prereleases are never
# Latest). No Latest release at all allows the tag; so does an equal tag,
# which is a rerun of the release that is already Latest.
#
# Usage: release-latest-guard.sh <tag>   (GITHUB_REPOSITORY names the repo)
set -Eeuo pipefail

tag="${1:-}"
if [ -z "${tag}" ]; then
  echo "::error::usage: release-latest-guard.sh <tag>" >&2
  exit 2
fi

# vX.Y.Z -> "X Y Z", or fail: release.sh only ever tags plain X.Y.Z, and a
# guard that guessed at anything else could hand the feed to the wrong build.
parse() {
  if [[ ! "$1" =~ ^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
    echo "::error::'$1' is not a vX.Y.Z release tag" >&2
    exit 2
  fi
  echo "${BASH_REMATCH[1]} ${BASH_REMATCH[2]} ${BASH_REMATCH[3]}"
}

# Assigned first: a failed parse inside `read <<<"$(...)"` would not stop the
# script under set -e.
parts="$(parse "${tag}")"
read -r t_major t_minor t_patch <<<"${parts}"

errors="$(mktemp)"
trap 'rm -f "${errors}"' EXIT
if ! latest="$(gh release view --repo "${GITHUB_REPOSITORY}" --json tagName --jq .tagName 2>"${errors}")"; then
  # Any other failure (auth, network) must stop the release rather than be
  # read as "no Latest yet", which would let an old tag through.
  if grep -qi 'release not found' "${errors}"; then
    echo "true"
    exit 0
  fi
  cat "${errors}" >&2
  echo "::error::could not read the current Latest release" >&2
  exit 1
fi

parts="$(parse "${latest}")"
read -r l_major l_minor l_patch <<<"${parts}"

# Numeric, part by part: a string compare would put v0.2.10 before v0.2.9.
if (( t_major != l_major )); then older=$(( t_major < l_major ))
elif (( t_minor != l_minor )); then older=$(( t_minor < l_minor ))
else older=$(( t_patch < l_patch ))
fi

if (( older )); then
  echo "::notice::${tag} is older than the current Latest release ${latest}; it will not be marked Latest" >&2
  echo "false"
else
  echo "true"
fi
