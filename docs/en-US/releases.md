# Versioning and In-App Releases

> **Current distribution status:** v0.1.50 is the latest signed and notarized macOS arm64 stable release, built and published by GitHub Actions and eligible for the in-app updater. (v0.1.49 was a one-off manual unsigned preview published while the signing key was being set up; v0.1.26–v0.1.48 were unsigned previews.) Every stable release from v0.1.50 onward goes through the signed workflow described below.

Navide uses semantic versions (`MAJOR.MINOR.PATCH`) and Git tags prefixed with
`v`. `package.json` is the application version source of truth. The local build
script synchronizes these four files when a version changes:

- `package.json`
- `backend/pyproject.toml`
- `backend/agent_team_backend/__init__.py`
- `backend/uv.lock`

Run `pnpm release:check` at any time to verify that they still match. The
release workflow also checks that the pushed tag exactly matches the version.

## Update architecture

Packaged builds contain an `app-update.yml` generated from the `publish`
configuration in `package.json`. Five seconds after startup, the Electron main
process checks the stable releases in `nt-nerdtechnic/Navide`. The renderer can
also start a manual check from the refresh button in the left sidebar.

The application does not download or install silently. A user chooses
**Update**, watches download progress, and then chooses **Restart**. The main
process owns the updater state, so every open window sees the same result and a
window opened later receives the current snapshot.

GitHub Releases must contain all of these assets from the same signed build:

- `Navide-<version>-arm64.dmg`
- `Navide-<version>-arm64.zip`
- DMG and ZIP `.blockmap` files
- `latest-mac.yml`

The ZIP and `latest-mac.yml` are required for the macOS updater. Do not publish
only the DMG.

## One-time GitHub setup

### Release authorization

Running `release.sh` locally is not a security boundary: anyone with a source
checkout can run or modify a local script. GitHub must enforce who can create
an official release:

1. Create a `production` Environment under **Settings → Environments**.
2. Add the release maintainers as required reviewers and enable prevention of
   self-review.
3. Restrict the Environment's deployment refs to tags matching `v*.*.*`.
4. Create an active tag ruleset under **Settings → Rules → Rulesets** for
   `v*.*.*`; restrict tag creation and put only the release-maintainer team in
   its bypass list.
5. Store the five signing/notarization secrets listed below. They are
   **currently repository secrets** on `nt-nerdtechnic/Navide` (readable by the
   `production` Environment job); moving them into the protected Environment and
   removing the repository copies is a recommended hardening step.

The release workflow declares the `production` Environment. A tag push starts
the workflow; if required reviewers are configured, the signing/publish job
waits for approval.

The workflow reads these secrets (matching `.github/workflows/release.yml`):

| Secret | Value |
| --- | --- |
| `CSC_LINK` | Base64-encoded Developer ID Application `.p12` (**legacy** format) |
| `CSC_KEY_PASSWORD` | Password for that `.p12` |
| `APPLE_ID` | Apple ID used for notarization |
| `APPLE_TEAM_ID` | Developer Team ID (`Q5988V8U8D`) |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password from account.apple.com |

The first two sign the app; the last three notarize it (`mac.notarize: true` in
`package.json`). The certificate, private key, password, and the exact commands
to (re)generate the `.p12` and (re)apply the secrets live **outside the repo**
in `~/navide-signing/` — see that folder's `README.md`, and run its
`./set-secrets.sh` to reset `CSC_LINK` / `CSC_KEY_PASSWORD` (add `--dry-run` to
also trigger a signing test run). The `.p12` must use OpenSSL's `-legacy`
format or CI's `security import` fails with a misleading "MAC verification
failed … (wrong password?)".

Missing or invalid credentials fail the release at the **signature &
notarization verify step** (`codesign` / `spctl` / `stapler`) instead of
silently shipping an app that cannot update. Secrets are never required for
local development and must never be committed.

## Creating a release

1. Finish and verify the intended changes. Update `CHANGELOG.md`.
2. Commit every intended source change and confirm the repository is clean.
3. Run `./release.sh X.Y.Z` (or `pnpm release:prepare -- X.Y.Z`). The script
   validates that the requested version is newer, synchronizes all version
   files, runs the release gates, builds the unsigned local artifacts, and
   creates the release commit and annotated `vX.Y.Z` tag.
4. Review the result, then answer the script's publish prompt. If you defer the
   push, publish later with `git push origin main` followed by
   `git push origin vX.Y.Z`.
5. Watch the **Release macOS** Actions workflow. It installs locked
   dependencies, verifies versions, runs frontend/backend tests, builds the
   backend, signs and notarizes Navide, validates every update asset, and only
   then creates the public GitHub Release.
6. Install the release DMG on a test Mac. Publish a newer patch release and use
   the in-app flow to verify check, download, restart, and the resulting app
   version.

For the first public release, also verify the documented clean-machine install path, onboarding flow, privacy statements, and supported-agent matrix. Add the actual release entry to `CHANGELOG.md` only after the GitHub Release and assets exist.

Never move an existing version tag or replace assets on an existing release.
Clients and caches may already trust its metadata. Fix a bad release with a new
patch version.

## Rollback and emergency response

GitHub's updater selects a version newer than the installed version, so
republishing an older release is not a rollback. If a release is broken:

1. Mark the bad GitHub Release as a pre-release or delete it to stop new update
   checks from selecting it.
2. Fix or revert the defect on `main`.
3. Publish a higher patch version through the normal signed workflow.
4. Users who already installed the bad version receive that higher patch;
   users unable to launch must reinstall from the new DMG.

If signing credentials may be compromised, remove the Actions secrets, revoke
the certificate/API key with Apple, and do not publish again until replacement
credentials are configured.

## Local packaging

Run `./build.sh` (or `pnpm package:local`) for a fast local unsigned `.app`
without changing the version, creating a commit, or creating a tag. Add
`--install` to replace the local copy under `/Applications` after quitting the
running app. Local output is written to `dist-local/`.

`pnpm dist` creates the full unsigned DMG, ZIP, blockmaps, and updater metadata.
Those formats are part of the production contract. Unsigned preview releases
must remain prereleases, and their assets must never be represented as signed
or notarized. Formal stable versions
are prepared only with `./release.sh X.Y.Z`, and signed artifacts are produced
only by GitHub Actions after `production` Environment approval.
