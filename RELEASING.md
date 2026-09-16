# Releasing Navide

Navide ships as a signed + notarized macOS app, unsigned Windows x64 and
arm64 installers, and a Linux x64 AppImage and `.deb`. Users receive updates through
the in-app updater (electron-updater; the `.deb` updates through `apt`), which
downloads the full zip for every update — see "Updates are full downloads"
below for why.

We use a **two-tier** model.

| Tier | When | Command | Extra steps |
|------|------|---------|-------------|
| **Patch / hotfix** | small fixes, no new user-facing feature | `./release.sh patch` | none |
| **Minor / major** | new features, notable changes | `./release.sh minor` (or `major`) | announce (release notes, etc.) |

`release.sh` updates the README download links to the new version on **every**
release (patch included), so the download point always reflects the latest
version — no manual README edit is needed for any tier.

Every release — patch or major — is fully built, signed, notarized, and
published to GitHub Releases (with `latest-mac.yml`, `latest.yml` and
`latest-linux.yml`). There is no "hot patch"
that skips the build; the difference between the tiers is only the **ceremony**
around it, not the build itself.

## Prerequisites

- Clean `main`, in sync with `origin/main` (`release.sh` enforces this).
- Signing assets present and GitHub secrets set. See `~/navide-signing/README.md`
  (5 secrets: `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_TEAM_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`).
- `node`, `pnpm`, `uv`, `git` on PATH.

## Pre-release checklist

CI proves that every platform compiles, passes its unit tests and packages. It
does not prove the installed app works: v0.2.3's arm64 build passed every job
and still could not open a terminal pane until a VM run caught an event-loop
stall (#102). Walk this list before `./release.sh`; nothing here is automated.

1. **`main` is green on all three platforms** — the last CI run on `origin/main`
   passed Frontend and Backend checks for macOS, Linux and Windows. A PR whose
   Windows job was skipped or rerun-to-green does not count.
2. **Dry-run the release workflow** — trigger `Release` with
   `workflow_dispatch` on `main`. It builds every platform (macOS, Linux x64,
   Linux arm64, Windows x64, Windows arm64) without publishing. All jobs must
   pass, including the Windows `--self-check conpty` and `check-pe-machine`
   steps; download the Windows artifacts from the run for step 3.
3. **Smoke-test the installers on a real OS** — on a clean Windows and a clean
   Linux machine or VM (restore a snapshot; never test over an old install):
   install the dry-run artifact, launch, open one Terminal pane and type into
   it, open one CLI pane and reach its login prompt.
   Read `backend.log` for `loop_watchdog` stalls while doing so. Windows on Arm
   must run the arm64 build natively — verify with
   `GetProcessInformation(ProcessMachineTypeInfo)` and the absence of
   `xtajit64.dll`, not `IsWow64Process2`, which reports x64 emulation as native.
4. **Dependency audit warnings** — the Windows-on-Arm pass of the Dependency
   audit job only warns. Read its output; the `cryptography` pin for win_arm64
   is a known, accepted item until upstream ships newer wheels.
5. **What's New and CHANGELOG** — add the `whatsNew.ts` entry (below) and the
   `CHANGELOG.md` section for the new version. `release.sh` bumps versions and
   README download links but writes neither of these.
6. **Signing status** — macOS signs and notarizes in CI; Windows is unsigned
   and shows SmartScreen's "Unknown publisher" prompt. Do not describe a Windows
   build as signed anywhere until that changes.

After the tag push: watch all four release jobs, then confirm the Release
carries every asset listed under "Rollback" below plus a single `latest.yml`
whose `files` list names both `win-x64` and `win-arm64`.

## Pre-release step: Update What's New announcement

Before running `./release.sh`, add a new entry to `src/renderer/src/lib/whatsNew.ts` for the target version (e.g. `0.1.70`). Include title and bullet points in both `'zh-TW'` and `'en-US'`. This ensures that when users launch the newly updated app, the in-app What's New modal (`WhatsNewModal`) automatically pops up with the new features and fixes.

## Patch / hotfix flow

```bash
./release.sh patch      # e.g. 0.1.50 -> 0.1.51
```

`release.sh` bumps the version across all version files, runs the gates
(typecheck + frontend + backend tests), builds locally, commits, tags, and
(after you confirm) pushes `main` + the tag. The tag push triggers the
**Release** CI workflow: its macOS job signs, notarizes, and publishes the
GitHub Release, then the Linux x64 and Windows x64 jobs add their installers,
and the Windows arm64 job adds its installer and merges both Windows entries
into one `latest.yml`.
Existing users' apps auto-check (startup + every 30 min), download the
update in the background, and prompt "Restart to update".

That's the whole hotfix flow. `release.sh` already repointed the README
download links (and the `latest-release` badge tracks the newest release), so
new users downloading an installer always get the latest version too.

## Minor / major flow

```bash
./release.sh minor      # e.g. 0.1.50 -> 0.2.0
# or
./release.sh major      # e.g. 0.1.50 -> 1.0.0
```

Same as above (the README download links are updated by `release.sh`
automatically), **plus** announce as appropriate (release notes, etc.) after
the GitHub Release is published.

## Explicit version

The classic form still works unchanged:

```bash
./release.sh 0.3.0
```

## Git recovery switch

If a release needs the retained Git recovery bundle, launch the application
from its main-process environment with `NAVIDE_GIT_RECOVERY=legacy`. Normal
startup omits the variable: a verified Marketplace package is preferred, then
the removable factory `navide.git` package tries v2. A durable user opt-out
leaves Git absent until **Restore** is selected in Extensions. Load, mount, or
ready failure may select legacy for that process; trust and permission failures
must remain fail closed. Verify the Git left and window surfaces open against
an existing workspace, the Extensions entry reports the expected source and
version, and existing Git preferences and repository selection are still
present. To retry v2, quit the application, remove the variable, and relaunch.
Recovery does not edit Plugin Storage or legacy seed data.

## Notes

- **Bump keywords** (`patch`/`minor`/`major`) compute the next version from the
  current `package.json`. Never hand-edit version numbers — always go through
  `release.sh`, or the version files desync and the script refuses to run.
- **Updates are full downloads**, not deltas. `scripts/fix-mac-update-zip.mjs`
  re-zips the signed app with `ditto` and deliberately leaves the now-stale
  `.zip.blockmap` alone; since `latest-mac.yml` carries no `blockMapSize`,
  electron-updater never consults the blockmap and fetches the whole `.zip`.
- **Channels** (stable/beta) are an orthogonal, user-facing choice in
  Settings → Updates — unrelated to the patch/major tiers. A beta CI publishing
  feed is not wired yet; the App side is ready for it.
- **First run after upgrade**: the backend backs up its JSON stores
  (`<app-data>/store-backups/<version>/`, last 2 kept) and forward-migrates the
  schema, so an upgrade never corrupts saved settings.
- **Rollback**: users can download an older installer from the Releases page; to
  pull a bad auto-update, remove/replace its `latest-mac.yml` / `latest.yml` /
  `latest-linux.yml` on the release. A complete release carries
  `Navide-<v>-arm64.dmg` + `.zip` (+ `.blockmap`), `Navide-<v>-win-x64.exe`,
  `Navide-<v>-win-arm64.exe` (+ `.blockmap`), `Navide-<v>-x86_64.AppImage`,
  `Navide-<v>-amd64.deb`, and the three manifests.
