# User Guide

## Mental model

Navide has three levels of work:

1. A **workspace** is the project folder and the boundary for project state, run history, and Git operations.
2. A **pane** is a live terminal session running an agent CLI or a plain shell.
3. A **pipeline** is an ordered set of configurable stages. Each stage contains one or more parallel slots, and each slot chooses an agent and role.

## Workspaces

The welcome screen lists recent workspaces, supports pinning, and marks missing folders. Opening a workspace restores its UI state and eligible sessions. Before switching or closing a workspace, finish or abort active work that must not be interrupted.

Navide stores project-scoped data under `.agent-team/` inside the workspace. Do not commit generated run state unless your team has intentionally chosen to version it.

## Manual agent panes

Use manual spawn for exploration, maintenance, or one-off work that does not need a full pipeline.

- Choose an agent and role.
- Review the launch command before spawning.
- Use a plain Terminal pane when no agent is needed.
- Minimize a pane to keep its PTY alive without occupying the main layout.
- Rebuild or resume only after Navide has detected a reusable session ID.

Supported built-in agent keys are Claude Code, Codex, Antigravity CLI, and Grok CLI. The exact CLI behavior and provider billing remain controlled by each external tool.

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

## History and token tracking

History is an append-only timeline for pipeline, stage, pane, question, analyzer, handoff, and warning events. Run history is stored under `.agent-team/runs/` and can be filtered or exported.

Token Stats parses compatible local CLI logs and attributes usage to workspaces, panes, stages, and runs. It is an observability feature, not a provider invoice. Provider-side usage and billing remain authoritative.

## Git and review

The Git view supports repository discovery, working-tree inspection, staging, commits, branches, remotes, issues, and related workflows. Multi-repository workspaces can switch between discovered repositories.

Review changes before committing, especially after automated or parallel runs. Navide does not make an agent-generated change safe merely because it appears in the Git panel.

## Editor and AI chat

The editor uses Monaco and provides file editing, diagnostics, plan rendering, diffs, conflicts, and AI-assisted workflows. AI Chat can use a local model or configured cloud providers. Provider-specific API keys and model settings are optional and are stored locally when entered.

These tools support the orchestration workflow; Navide's primary role remains coordinating and observing agents rather than replacing every feature of a general-purpose IDE.

## Settings and portability

Settings cover roles, pipelines, MCP servers, analyzer behavior, AI providers, appearance, and keyboard shortcuts. Exported settings redact API keys and tokens. Review MCP commands and environment variables before enabling third-party servers.
