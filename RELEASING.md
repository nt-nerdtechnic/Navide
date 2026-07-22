# Releasing Navide

Navide ships as a signed + notarized macOS app. Users receive updates through
the in-app updater (electron-updater), which downloads only the changed bytes
(blockmap delta), so patches land in seconds.

We use a **two-tier** model.

| Tier | When | Command | Extra steps |
|------|------|---------|-------------|
| **Patch / hotfix** | small fixes, no new user-facing feature | `./release.sh patch` | none — auto-update delivers it |
| **Minor / major** | new features, notable changes | `./release.sh minor` (or `major`) | update README download links + announce |

Every release — patch or major — is fully built, signed, notarized, and
published to GitHub Releases (with `latest-mac.yml`). There is no "hot patch"
that skips the build; the difference between the tiers is only the **ceremony**
around it, not the build itself.

## Prerequisites

- Clean `main`, in sync with `origin/main` (`release.sh` enforces this).
- Signing assets present and GitHub secrets set. See `~/navide-signing/README.md`
  (5 secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`).
- `node`, `pnpm`, `uv`, `git` on PATH.

## Patch / hotfix flow

```bash
./release.sh patch      # e.g. 0.1.50 -> 0.1.51
```

`release.sh` bumps the version across all version files, runs the gates
(typecheck + frontend + backend tests), builds locally, commits, tags, and
(after you confirm) pushes `main` + the tag. The tag push triggers the
**Release macOS** CI workflow, which signs, notarizes, and publishes the GitHub
Release. Existing users' apps auto-check (startup + every 4h), download the
delta in the background, and prompt "Restart to update".

That's the whole hotfix flow. **Do not** touch the README download links for a
patch — they intentionally keep pointing at the last feature release for new
users downloading a DMG.

## Minor / major flow

```bash
./release.sh minor      # e.g. 0.1.50 -> 0.2.0
# or
./release.sh major      # e.g. 0.1.50 -> 1.0.0
```

Same as above, **plus** after the GitHub Release is published:

1. Update the download links + version in `README.md`, `README.zh-TW.md`,
   `README.ja-JP.md` to the new version, then commit + push. (The
   `latest-release` badge updates itself; only the direct DMG/ZIP/tag links are
   hard-coded.)
2. Announce as appropriate (release notes, etc.).

## Explicit version

The classic form still works unchanged:

```bash
./release.sh 0.3.0
```

## Notes

- **Bump keywords** (`patch`/`minor`/`major`) compute the next version from the
  current `package.json`. Never hand-edit version numbers — always go through
  `release.sh`, or the version files desync and the script refuses to run.
- **Delta updates** are automatic: because CI publishes the `.zip` + `.blockmap`,
  electron-updater downloads only the diff.
- **Channels** (stable/beta) are an orthogonal, user-facing choice in
  Settings → Updates — unrelated to the patch/major tiers. A beta CI publishing
  feed is not wired yet; the App side is ready for it.
- **First run after upgrade**: the backend backs up its JSON stores
  (`<app-data>/store-backups/<version>/`, last 2 kept) and forward-migrates the
  schema, so an upgrade never corrupts saved settings.
- **Rollback**: users can download an older DMG from the Releases page; to pull
  a bad auto-update, remove/replace its `latest-mac.yml` on the release.
