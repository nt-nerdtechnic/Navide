# Changelog

All notable released changes to Navide will be documented in this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow Semantic Versioning where practical during the pre-1.0 period.

## [Unreleased]

## [0.1.49] — 2026-07-21 — unsigned preview

### Added

- Mini-IDE plugin system: a plugin architecture with an install / update / remove lifecycle, an Extensions view in Settings, and per-plugin verification and packaging. The whole surface is gated behind an opt-in flag (`AGENT_TEAM_MINI_IDE_PLUGIN`) and stays hidden until the main process confirms it is enabled.
- Plugin marketplace: a registry service, a publishing flow with a signing and trust model, and a discovery website to browse, search, and view plugin details.
- Kimi Code CLI integration: conversation-log reader and resume support.
- Git History window as a standalone view.
- Unified plan documents: a shared model for HTML and Markdown plans with in-place todo editing, stage snapshots with live refresh, a shared review toolbar, and Plans surfaced as a left-sidebar tab.
- Keybindings: Ctrl+1–5 to quick-select a CLI type, and Cmd+Shift+<n> to switch stage tabs.

### Changed

- Plans move to a left-sidebar tab with drill-down, replacing the pop-out window.
- Grid layout accepts custom column×row presets.
- Refreshed status-badge colors across components.

### Fixed

- Prevent stored XSS in the marketplace by serving plugin assets same-origin.
- Derive the Kimi resume session id from the directory name instead of the file stem, and validate the session exists during resume preflight.
- Stop focus/refit repaints from falsely showing a RUNNING pane badge.
- Plan QA hardening: preserve skipped/unknown todo fields, close panels on ESC, and fix blank todo-only plans.
- Externalize optional `ws` native dependencies (bufferutil, utf-8-validate) so the build does not break.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.48] — 2026-07-20 — unsigned preview

### Added

- Interactive plan documents: agent-authored HTML plans with a todo sidebar, live stage and status updates, comment anchors, and one-click task dispatch from the plan into CLI panes.
- Manual pane sessions for capturing terminal work outside a spawned agent.
- Status bar indicator for lingering CLI processes, with scan and reap actions.

### Changed

- Reduce keystroke echo latency in terminals with an adaptive output-flush fast path and focus-priority scheduling.
- Resolve CLI commands through an interactive login shell so PATH entries written by installers (for example `~/.local/bin` or Homebrew) are visible when the app is launched from Finder or the Dock.
- Refresh PATH from the login shell before spawning so newly installed CLIs are found without restarting the app.
- Improve npm-based dependency install detection during onboarding.

### Fixed

- CLI agents failing to launch in packaged builds because the backend inherited the GUI's restricted PATH.
- Spawn probe now degrades to a warning on timeout or transient errors instead of blocking the launch.
- Reap breakaway PTY processes that escaped group termination, preventing lingering CLI processes from accumulating.
- Agent history log preview reading the wrong path; the real log path is now stored and older entries are matched by filename across day folders.
- De-duplicate pane restore to avoid concurrent restore races.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.47] — 2026-07-17 — unsigned preview

### Added

- Serve XHTML files through the file preview backend.
- Loop auto-continue: loop status indicators (∞) in panes and the agent list, a configurable loop prompt in Settings, and automatic resume when a CLI session hits its usage limit.
- "General" tab and settings group in the Settings modal.

### Changed

- Handle dead WebSocket sessions gracefully in the backend.
- Handle subprocess timeouts in the terminal service.
- Prevent default browser behavior for terminal cursor shortcuts.
- Improve pane restore with rename stub handling.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.46] — 2026-07-16 — unsigned preview

### Changed

- Update rebuild logic to specifically target active tab CLI panes.
- Ensure focus continuity when marking items as seen in the UI.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.45] — 2026-07-16 — unsigned preview

### Changed

- Add `restoreMode` and `replacePaneId` to `spawnPane` to enable atomic pane replacement with focus continuity.
- Update pane rebuild logic to support `keepInList` during `onKill`.
- Refine terminal refit logic with `skipReattach` option for smoother layout transitions.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.44] — 2026-07-15 — unsigned preview

### Added

- Add log preview modal and improve terminal session handling.
- Add force option to kill terminal sessions.
- Add test scripts to simulate terminal input (`test_bp.exp`, `test_bp.js`, `test_pt.py`).

### Changed

- Improve PTY output handling with backpressure.
- Remove session check in `_drain` method for terminal sessions.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.43] — 2026-07-15 — unsigned preview

### Added

- Add inline pane renaming functionality to the UI.

### Changed

- Update test mocks to include `onResize` method for terminal tests.
- Fix CI build OOM issues by adjusting `NODE_OPTIONS`.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.42] — 2026-07-15 — unsigned preview

### Changed

- Refactor terminal UI: update terminal methods, fit logic, and temporarily disable auto-rebuild on resize to prevent unexpected CLI resumes.
- Update `spawnHistory` custom name logic to support session home normalization.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.41] — 2026-07-15 — unsigned preview

### Added

- Add a complete Japanese path for the public product and core user documentation.
- Add focused backend coverage for Claude hook installation and stop-hook payload forwarding.

### Changed

- Preserve Agent History custom titles when session-home paths require normalization.
- Support Command–Equal as an additional terminal zoom-in shortcut.
- Organize English, Traditional Chinese, and Japanese documentation under symmetric locale navigation.
- Update all supported-language download guidance to the v0.1.41 preview.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

## [0.1.40] — 2026-07-15 — unsigned preview

### Added

- Publish the first directly downloadable macOS arm64 preview through GitHub Releases.
- Add a complete Traditional Chinese path for the public product and core user documentation.
- Add regression coverage for token checkpoint rotation, persistence batching, shutdown ordering, and workspace replay.

### Changed

- Batch token metric persistence and serialize journal recovery so shutdown and lifecycle saves cannot be overwritten by older snapshots.
- Reset Codex and Grok ingestion checkpoints when their underlying log generation changes.
- Include recent rendered terminal context alongside durable CLI transcript references during handoff.
- Refine terminal zoom shortcuts and pane drag affordances.
- Update English and Traditional Chinese installation guidance with direct downloads and safe Gatekeeper instructions.

### Distribution note

- This release is an unsigned, non-notarized Apple silicon preview. It is published as a prerelease and is not part of the stable in-app update channel.

### Documentation

- Reposition Navide as the engineering instrument for the Agent era: an AI-native environment for one engineer directing an AI engineering force.
- Add the Navide Manifesto and Product Vision.
- Define Genesis, Evolution, and Intervention as the three engineering loops.
- Define management by exception as the human-agent operating philosophy.
- Define `.agent-team/` as the local, per-user, Git-excluded Project Intelligence Layer.
- Replace the control-plane-only roadmap with a path toward complete professional IDE replacement through an Agent-era interaction model.
- Align supported agents with the current registry: Claude Code, Codex, Antigravity CLI, and Grok CLI.
- Replace fixed-stage claims with the configurable pipeline model and included workflow.
- Add and align the documentation index, getting-started guide, user guide, architecture, privacy and data flows, troubleshooting, and phased long-term roadmap.
- Correct repository clone commands, contribution checks, privacy claims, credential-storage statements, and release expectations.

## Development version history

The source tree reached package version `0.1.39` before the public release history was established. GitHub currently has no published Navide release, so versions in that range must not be represented as downloadable releases retroactively.

Future release entries should be added when a signed GitHub Release is published. Do not invent missing release notes from package-version bumps alone; reconstruct notable changes from commits and verification evidence as part of the first release preparation.

## [0.1.8] — 2026-06-01 — historical development snapshot

### Added

- Configurable SDLC pipeline with parallel agent slots
- Manager coordination protocol
- Local LLM analyzer and optional automatic answers
- Token usage tracking from supported CLI logs
- Context7 document injection
- Pipeline resume and workspace-scoped state
- Recent-workspace entry screen
- History timeline
- Role and stage management
- Claude Code lifecycle hooks
- Initial MIT-licensed open-source repository

`0.1.8` records a development milestone and was not a published GitHub Release.
