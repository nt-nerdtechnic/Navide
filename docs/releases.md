# Versioning and In-App Releases

> **Current distribution status:** Navide does not yet have a published GitHub Release. Until the first signed release completes this process, public documentation must describe source installation rather than offering a downloadable build.

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

Add these Actions secrets in the GitHub repository settings:

| Secret | Value |
| --- | --- |
| `MAC_CSC_LINK` | Base64-encoded Developer ID Application `.p12` certificate |
| `MAC_CSC_KEY_PASSWORD` | Password used when exporting that certificate |
| `APPLE_API_KEY_BASE64` | Base64-encoded App Store Connect `.p8` API private key |
| `APPLE_API_KEY_ID` | App Store Connect API key ID |
| `APPLE_API_ISSUER` | App Store Connect API issuer ID |

The release job deliberately uses `forceCodeSigning=true`: missing or invalid
credentials fail the release instead of silently shipping an app that cannot
update. Secrets are never required for local development and must never be
committed.

## Creating a release

1. Finish and verify the intended changes. Update `CHANGELOG.md`.
2. Run `./build.sh`, select patch/minor/major, and verify the local app. The
   script synchronizes version files, builds, creates the version commit, and
   creates the local `vX.Y.Z` tag.
3. Confirm the repository is clean and run `pnpm release:check vX.Y.Z`.
4. Push the commit first: `git push origin main`.
5. Push the exact tag: `git push origin vX.Y.Z`.
6. Watch the **Release macOS** Actions workflow. It installs locked
   dependencies, verifies versions, runs frontend/backend tests, builds the
   backend, signs and notarizes Navide, validates every update asset, and only
   then creates the public GitHub Release.
7. Install the release DMG on a test Mac. Publish a newer patch release and use
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

`pnpm dist` remains suitable for local unsigned packaging. It now creates both
DMG and ZIP outputs and updater metadata because those formats are part of the
production contract. An unsigned local build is for local testing only and
must not be attached to a public release.
