#!/usr/bin/env bash
# Publish assets to a GitHub release, one upload call per file.
#
# v0.2.5's Linux job failed twice on a single `gh release upload` carrying the
# AppImage (222 MB) and the .deb (198 MB) together, and a manual retry of the
# same pair failed a third time — HTTP 400, then 404, then 500, all from
# uploads.github.com. Uploading the same two files one at a time succeeded on
# the first attempt each. macOS and Windows were unaffected because their large
# files travel with small blockmaps, so no single call carried two of that size.
#
# One script rather than the same loop pasted into each publish step: four
# copies drift, and this repo has watched comments rot apart that way before.
#
# Every asset is attempted even after one fails, and the names that did not
# make it are listed together at the end. That list is what somebody reads
# when a release publishes half-finished — the manifests are up, the binaries
# they name are not, and clients are already finding an update they cannot
# download. Stopping at the first failure would mean rerunning the job just to
# learn what else is missing.
#
# Usage: publish-release-assets.sh <tag> <asset>...
set -Eeuo pipefail

tag="${1:-}"
if [ -z "${tag}" ]; then
  echo "::error::usage: publish-release-assets.sh <tag> <asset>..." >&2
  exit 2
fi
shift

if [ "$#" -eq 0 ]; then
  echo "::error::no assets were given to publish for ${tag}" >&2
  exit 2
fi

# The release is created empty; assets join it one at a time below. A rerun
# finds it already there and goes straight to uploading.
if ! gh release view "${tag}" >/dev/null 2>&1; then
  gh release create "${tag}" --verify-tag --generate-notes --title "Navide ${tag}"
fi

# A plain string, not an array: the macOS runner's /bin/bash is 3.2, where
# expanding an empty array under `set -u` is itself an error.
failed=""

for asset in "$@"; do
  name="$(basename "${asset}")"
  attempt=1
  while : ; do
    # --clobber replaces an asset of the same name, so a rerun of this job
    # refreshes what is there instead of failing or duplicating it.
    if gh release upload "${tag}" "${asset}" --clobber; then
      break
    fi
    if [ "${attempt}" -ge 3 ]; then
      echo "upload of ${name} failed after 3 attempts" >&2
      failed="${failed} ${name}"
      break
    fi
    echo "upload of ${name} failed (attempt ${attempt}); retrying" >&2
    sleep $((attempt * 20))
    attempt=$((attempt + 1))
  done
done

if [ -n "${failed}" ]; then
  echo "::error::these assets are missing from ${tag}:${failed}" >&2
  exit 1
fi
