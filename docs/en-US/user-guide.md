# User Guide

English | [繁體中文](../zh-TW/user-guide.md) | [日本語](../ja-JP/user-guide.md) | [Documentation](README.md)

## Product model

Navide is designed for one engineer directing multiple AI agents. The primary interaction is not always editing a file; it is setting an outcome, coordinating sessions, observing progress, handling meaningful exceptions, and accepting verified results.

Daily work moves through three loops:

1. **Genesis** uses a pipeline to turn an idea into a first working prototype.
2. **Evolution** repeatedly develops, tests, fixes, and refines an existing project through one or more agent sessions.
3. **Intervention** lets the engineer inspect or directly change the result through Diff, editor, terminal, diagnostics, Git, and review tools.

The current Pipeline implements the Genesis loop. Manual panes and maintenance mode provide the early Evolution workflow. The editor and review surfaces provide Intervention.

## Runtime mental model

Navide has three levels of work:

1. A **workspace** is the project folder and the boundary for project state, run history, and Git operations.
2. A **pane** is a live terminal session running an agent CLI or a plain shell.
3. A **pipeline** is an ordered set of configurable stages. Each stage contains one or more parallel slots, and each slot chooses an agent and role.

## Workspaces

The welcome screen lists recent workspaces, supports pinning, and marks missing folders. Opening a workspace restores its UI state and eligible sessions. Before switching or closing a workspace, finish or abort active work that must not be interrupted.

Navide stores private, per-user project intelligence under `.agent-team/` inside the workspace. This directory is excluded from Git and must not be treated as shared team state. It can contain task context, session metadata, run history, handoffs, and token information that belong to the individual engineer's local workflow.

Source code and explicitly shared documentation remain the repository's team-visible truth. If information from `.agent-team/` must be shared, turn it into an intentional artifact such as a specification, architecture decision, test report, issue, commit, or pull request.

## Manual agent panes

Use manual spawn for exploration, maintenance, or an Evolution task that does not need a full Genesis pipeline.

- Choose an agent and role.
- Review the launch command before spawning.
- Use a plain Terminal pane when no agent is needed.
- Minimize a pane to keep its PTY alive without occupying the main layout.
- Rebuild or resume only after Navide has detected a reusable session ID.

A new empty Codex pane waits for your input without sending an artificial session-discovery message. Its session ID may become available only after the first real user or configured task turn; until then, Rebuild remains unavailable. The same applies to a fresh rebuild or restore. If Codex asks to review the Navide session hook, review it in Codex; YOLO mode does not approve hooks. Existing shared session homes may need that trusted hook to associate the new conversation with its pane.

Select multiple pane headers with Cmd/Ctrl-click or Shift-click, then right-click a selected pane to open the batch menu. Its groups contain Interrupt/Rebuild, Minimize/Restore/Reclaim, notification controls, and Remove. **Restore selected** also opens selected panes that have not yet been opened or were reclaimed. Pane and project overflow menus stay within the window; long menus scroll so their final actions remain reachable.

**Reclaim selected (N)** shows how many selected panes are eligible, releases their CLI processes, and keeps click-to-resume placeholders. It skips protected panes, including running panes, the focused pane, panes awaiting an answer or holding unsent text, and panes without a resumable session. The action stays visible but is disabled when none of the selected panes can be reclaimed. **Mute selected notifications** mutes the entire selection, including a mix of muted and unmuted panes; when every selected pane is muted, **Unmute selected notifications** restores notifications for all of them. These batch actions affect only the selected panes.

Supported built-in agent keys cover 14 coding CLIs: Aider, Antigravity CLI, Claude Code, Codex, Copilot CLI, Cursor CLI, Droid, Grok CLI, Kilo Code, Kimi Code, Muse Code, OpenCode, Pi, Qwen Code. The exact CLI behavior and provider billing remain controlled by each external tool.

For Kimi Code panes, Navide gives the CLI a 100 ms escape-sequence reassembly window so arrow-key navigation remains reliable through the embedded terminal. An existing `PI_TUI_ESC_TIMEOUT` environment value still takes precedence.

### CLI risk observations

An active agent pane can show one yellow or red risk pill. Open its popover to inspect the backend's evidence and observation times; multiple findings share that popover. Disk findings apply to the vendor's active panes, while network findings belong to the observed pane's process tree, including its CLI, MCP servers and tools. Reclaimed placeholders show no risk pill.

- **Yellow network:** a sampled numeric IP and port fall outside a complete, current expected-address snapshot. The count is from the last sample, and “observed since” describes sampled observations, not connection duration. Legitimate tools, proxies and different DNS answers can produce a mismatch.
- **Yellow disk:** after a successful baseline, a file first observed following prior absence qualifies within 24 hours if it exceeds 100 MiB and bounded content inspection does not recognize its format. Files already in the baseline are excluded; timestamps and familiar extensions alone do not establish that a file is new or recognized.
- **Red disk:** a previously flagged path was successfully observed present, then absent, then present again with opaque content in the same 100 MiB size class. This does not identify who removed or recreated it, or establish that its contents are the same.

**Ignore** persists for the displayed vendor/IP across all ports, or vendor/canonical file path, including later severity changes. **Allow this IP** adds only the displayed exact IP for that vendor across all ports; it does not allow an inferred hostname or certify the destination. Both decisions apply across that vendor's panes and survive restart. Disk **Reveal in folder** opens the existing native folder action so you can inspect the file.

Observations use existing resource requests: normally every 30 seconds, or every 2 seconds while the resource panel is open. Disk attempts, including failed attempts, are throttled to once per five minutes per active vendor. Work finishes in the backend and appears in a later response; opening Storage is unnecessary. Descendant discovery and polling can delay network evidence, and short-lived connections or file replacement between samples can be missed.

Default network declarations currently cover Claude Code and Codex; other vendors have no expected-address comparison. Captured proxy or provider-endpoint overrides disable that comparison. Network observation covers established TCP on macOS and Linux; Windows network observation and UDP/QUIC are unsupported. Disk roots are declared per vendor, with Aider unsupported; symlinks beneath a resolved data root are skipped. Roots use the captured pane home and declared environment overrides; later changes inside CLI settings, command arguments or shell startup scripts can fall outside that snapshot. Failed or incomplete collection, unavailable declarations and expired DNS must not be read as a clean result. Historical findings can remain visible as stale evidence. **No pill is not an assurance of safety.**

These observations help you inspect local activity; they do not prove exfiltration or unlawful intent. Navide does not automatically block a connection, pause a CLI or delete a file. See [Privacy and Data Flows](privacy.md#cli-risk-observation-data) for local reads, retained metadata and DNS requests.

## Pipelines

The included pipeline covers requirements, planning, design, implementation, security review, and testing. Stages, slots, roles, kickoff prompts, questions, and completion sentinels are configurable in Settings.

A stage can run multiple slots in parallel. Navide advances based on configured completion signals and agent state. Always review generated changes and test results; automated completion indicates workflow progress, not correctness.

## Manager and worker coordination

One slot can act as the global manager. The manager receives cross-stage context, delegates work to workers, handles worker questions, and signals stage completion through Navide's routing protocol.

Use a manager when a task benefits from decomposition or parallel ownership. For small tasks, a single-agent stage is usually cheaper and easier to inspect.

## Automation modes

- **YOLO** passes CLI-specific flags that bypass approval or trust prompts where supported. Some CLIs may already execute tools without a confirmation gate.
- **Full Auto** lets the analyzer answer agent questions from available task context.
- **Strict** asks for confirmation at selected timeout or progression boundaries.
- **Continuous** keeps the pipeline moving according to its configured automation behavior.
- **Local Analyzer** enables local intent classification and related automation.

Start conservatively. YOLO and Full Auto can cause agents to modify files or execute commands without another user confirmation.

## Management by exception

Navide's long-term operating philosophy is to let agents continue through reversible, observable work and return attention to the engineer only when human judgment adds value. Current automation modes are early controls, not a complete policy engine.

Intervene when:

- Requirements have materially different valid interpretations
- Architecture or product choices have lasting consequences
- Sessions conflict over ownership, files, or technical direction
- Tests and stated acceptance criteria disagree
- Credentials, payments, deployment, publication, destructive operations, or external systems are involved
- The result requires subjective product or quality judgment

Routine exploration, reversible edits, local tests, diagnostics, and repairs should eventually proceed without approval noise while remaining visible and interruptible.

## History and token tracking

History is an append-only timeline for pipeline, stage, pane, question, analyzer, handoff, and warning events. Run history is stored under `.agent-team/runs/` and can be filtered or exported.

Token Stats parses compatible local CLI logs and attributes usage to workspaces, panes, stages, and runs. It is an observability feature, not a provider invoice. Provider-side usage and billing remain authoritative.

### Token Monitor

Open **Window → Token Monitor** for a separate window showing local Claude turn history over 14, 30, or 90 days. Reopening the command focuses the existing monitor. The existing **Turn Stats** modal remains available for inspecting one pane. Model filters, per-turn trends, and per-turn averages and medians summarize the selected local records.

Transcript records have **unknown account attribution**: a shared local Claude history cannot establish which signed-in account produced a turn. Other devices, web conversations, and subagent logs are outside this view. Missing history is not zero usage; partial scan coverage and errors are shown. Large histories are bounded, and refresh can reuse a scan for 60 seconds.

Quota history records successful observations for the active Claude account slot through the existing usage polling service. It starts accumulating when those observations are available; it cannot reconstruct earlier quota windows. Disabled polling and an empty history are displayed explicitly. Opening the monitor does not make extra provider requests. Observed tokens and quota percentages do not establish an official token allowance, throttling, effort level, or separate thinking-token usage.

## Git and review

Navide includes a removable factory installation of the official Git package until Marketplace installation is available. Its active package version supplies both the embedded left view and the dedicated Git window. Removing Bundled Git in Extensions persists across restarts; use **Restore** there to install the factory copy again. A verified Marketplace version takes precedence when present. The view supports repository discovery, working-tree inspection, staging, commits, branches, remotes, issues, and related workflows; multi-repository workspaces can switch between discovered repositories. Discovery scans run without blocking the backend and return partial results after a bounded scan period on slow filesystems. Repository operations stay local to Navide's Host/backend boundary, and GitHub/GitLab issue detection uses the configured `gh` or `glab` CLI when available. If the selected v2 package cannot load, mount, or report ready, Navide labels and uses the retained legacy Git renderer for that process. Security, trust, or permission denials do not trigger fallback.

Review changes before committing, especially after automated or parallel runs. Navide does not make an agent-generated change safe merely because it appears in the Git panel.

## Editor and AI terminal

The editor uses Monaco and provides file editing, diagnostics, plan rendering, diffs, conflicts, and AI-assisted workflows. The right-side AI panel embeds a real coding-agent CLI terminal (the same agents as the main window) and injects editor context when it starts.

These tools are the Intervention surface of the wider engineering environment. Navide's goal is eventually to provide the complete professional workflow without requiring a traditional IDE as the user's primary environment.

## Skills through Navide MCP

An authorized agent can use the same library as **Settings → Skills**:

1. Call `skills_list`, then pass a returned ID to `skills_inspect` for instructions, files, ownership, provenance and the current `delivery_revision`.
2. Call `skills_prepare_install` with `owner/repo`, an HTTPS `github.com/owner/repo` URL, or an absolute local skill folder (`~` is expanded). For GitHub, pass `ref` and `subdir` separately; `subdir: "."` selects the repository root. Multiple candidates return `selection_required` and `candidates` without an installable preview ID. Choose a path and prepare again. Private repositories, arbitrary URLs and GitHub tree URLs are unsupported.
3. Review the full instructions, file inventory, script warnings, source and digest. Call `skills_install` with the preview ID, exact digest and explicit targets. The first shared-root write also requires the user's permission through `consent`; a digest or agent-supplied boolean does not establish that permission. Installation rejects any same-name managed, user-owned or native skill. It exclusively creates the destination and publishes `SKILL.md` after attachments and metadata, so discovery does not see an incomplete package; this is not an atomic directory rename.
4. For later delivery changes, call `skills_set_delivery` with the skill ID and latest `delivery_revision`. Stale revisions fail without replacing another client's decision. This workflow adds skills; it does not update or refetch an existing installation.

Prepared bytes belong to the authenticated caller and expire after 15 minutes or backend restart. Installation uses those bytes without rereading the local source or fetching GitHub again. A permission retry can reuse an unexpired preview. While its retry receipt remains available, replay returns the original result without writing again. There are at most eight active preparations plus a separate cache of at most eight lightweight completed retry receipts. Successful installation releases package bytes and the active slot. Receipts expire at the original preview deadline; when the cache fills, the oldest successful installation receipt is evicted first. Retry after expiry or eviction returns missing/expired without reinstalling. GitHub downloads are capped at 10 MiB compressed, 32 MiB expanded and 4,096 entries; a selected skill is limited to 64 files, 256 KiB per file and 512 KiB total. Unsafe paths, links, special files, reserved metadata and invalid manifests are rejected rather than omitted.

For shared skills, `targets: null` selects all wired vendors and `targets: []` stops Navide's extra delivery. For native skills, targets opt other CLIs in; an empty list or `null` clears those extra routes. CLIs that read the shared root themselves may discover a skill regardless of Navide's targets or enabled switch. These settings are not an isolation boundary.

`materialized_in_current_session: null` and `loaded_in_current_session: null` mean current-session materialization and loading are unknown. The compatibility field `delivered_to_me` also describes configuration. Start a new CLI session after changing delivery and verify loading there; an installation or routing response is not evidence that a running CLI loaded new content.

A local provenance receipt records the source, prepared digest and timestamps, survives edits, toggles and restart, and is available through inspection. Its digest describes the installed snapshot, not any subsequent local edits. The management marker and provenance are excluded from existing export and Skills sync; provenance is not preserved across devices. With Skills sync enabled, eligible content and delivery decisions can still propagate through the existing sync flow. Matching package limits do not prove that synchronization completed.

Open Skills views refresh after successful backend mutations and reconnects, preserving unsaved content and its original revision so stale saves still conflict. Direct edits by other filesystem tools require manual refresh. Preparation and installation never run bundled scripts or plugin hooks; later skill use remains subject to the CLI's tools and authorization.

## Settings and portability

**Settings → Language** is a separate page after Appearance in the sidebar. Choose Traditional Chinese or English; this user-level preference applies to every workspace.

Settings cover roles, pipelines, MCP servers, analyzer behavior, AI providers, appearance, keyboard shortcuts, and the separate **Execution Policy** tab. That tab shows the read-only Host default, lets you create or edit one global `full`, `allowlist`, or `denylist` user policy, and keeps first-level system namespaces separate from top-level shell executable names. Full mode requires an explicit high-risk confirmation. For an open workspace it also shows the untrusted repository recommendation and lets you explicitly choose the Host default, user policy, or an accepted repository policy. Corrupt global policy state has a separately confirmed rebuild that preserves workspace source selections; an unsafe or unavailable policy directory instead requires manual remediation. The Extensions view shows a package's Manifest Permissions and exact package-version Grant separately from the selected agent Execution Policy.

**Settings → CLI Agents** presents one card per agent. Use search and the All, Enabled, or Needs attention filters to find an agent, or toggle its enabled state. To reorder agents, choose **All** and clear the search, then drag cards or use their up/down buttons. Reordering is disabled while a filter or search is active. At least one agent must stay enabled. Choose **Manage** to open that agent’s drawer, with Overview, Launch, Permissions, Push, and Install tabs. Changes use the existing automatic persistence; there is no separate Save step. Close the drawer, or press Escape, to return to the cards before closing Settings.

The Install tab manages the installed coding CLIs: version, install method, duplicate installations, the result of the CLI's own last update, and buttons that run that CLI's official update and diagnostic commands in a terminal. Resume on Open can restore one CLI, the first Grid page, or the active tab; the Grid-page choice follows the Grid preset even when the saved layout was not Grid. Navide surfaces and runs vendor commands; it never updates a CLI itself. Exported settings redact API keys and tokens. Review MCP commands and environment variables before enabling third-party servers.

**Accounts** keeps one card per CLI account. Besides the CLI's own sign-in, a card can hold a **portable credential**: the value the vendor documents for use on any machine (Claude Code's `claude setup-token`, for example). Paste it once; new panes of that CLI receive it in their environment and the CLI's own login files are left alone. One credential per CLI is the one *in use*; the card says which, and warns when a local login file would take precedence over it. Removing a credential removes it from this device only.

The **Sync** section (Settings → Sync) can carry those credentials to your other devices. The **Credentials** switch is off by default. When it is on, the Accounts cards show a cloud line per credential — in sync, on this device only, in the cloud but not used here, or waiting on a decision — and a credential pasted on another machine can be taken into use here with one click. Removing a credential here never removes it from the cloud or from other devices. The same section shows the sync key's id and offers to rotate it if you suspect it leaked: every record is re-sealed and paired devices receive the new key.

`.agent-team/` is not currently a portability mechanism. Any future migration between machines should use an explicit local export/import flow with redaction and retention controls rather than Git synchronization.
