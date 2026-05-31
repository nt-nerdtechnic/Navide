# Agent-Team Technical Design

Status: v1 draft  
Date: 2026-05-26  
Related specs: `docs/product-spec.md`, `docs/development-workflow.md`

## 1. Architecture Summary

Agent-Team v1 is a macOS-only Electron desktop app with an embedded web terminal UI and a Python local backend. The app controls local PTY sessions running Claude Code, Codex, and Gemini CLI. It persists task, terminal, orchestration, Git, checkpoint, and settings records in SQLite.

V1 does not support SSH, remote containers, server deployment, multi-user collaboration, or non-macOS platforms.

## 2. Runtime Components

### 2.1 Electron Main Process

Responsibilities:

- start and supervise Python local backend
- open application window
- manage app lifecycle
- expose backend endpoint to renderer
- handle macOS packaging/runtime paths
- restart backend if it crashes, after user confirmation

### 2.2 Electron Renderer

Responsibilities:

- render fixed 2x2 terminal grid
- host xterm.js panes
- render Control pane
- send input/resize/control events to backend
- display route messages, Git status, task state, and logs
- keep global Stop Orchestration / Kill Task controls visible

### 2.3 Python Local Backend

Responsibilities:

- create and manage PTY sessions
- launch `claude`, `codex`, `gemini`
- stream terminal output to renderer
- receive terminal input from renderer
- implement CLI adapter lifecycle
- run Git preflight/checkpoint/diff/commit commands
- run route engine
- run secret redaction
- persist records to SQLite

### 2.4 SQLite

Responsibilities:

- durable local task history
- settings and workspace configs
- terminal session/event persistence
- route message persistence
- orchestration run persistence
- Git snapshot/checkpoint/change persistence
- intervention event persistence

## 3. Process Model

```text
Electron Main
  -> starts Python Backend
  -> opens Renderer Window

Electron Renderer
  <-> Python Backend over local WebSocket/HTTP

Python Backend
  -> PTY: claude
  -> PTY: codex
  -> PTY: gemini
  -> git commands
  -> SQLite
```

## 4. Frontend Layout

V1 fixed 2x2:

- top-left: Claude Code terminal
- top-right: Codex terminal
- bottom-left: Gemini CLI terminal
- bottom-right: Control pane

Control pane sections:

1. Global controls
2. Prompt composer / inject message
3. Route messages and current round
4. Git status
5. Test/diff summary
6. History/log search

## 5. Backend Services

### 5.1 TerminalService

- create PTY session
- write input
- resize PTY
- send Ctrl-C
- kill process group
- emit terminal output events
- persist terminal events

### 5.2 CliAgentService

- manage `claude`, `codex`, `gemini` adapters
- launch agent by workspace
- track run status
- detect waiting/running/failure states
- expose agent output buffers to route engine

### 5.3 OrchestrationService

- manage route engine
- apply max round / timeout / no-progress rules
- generate handoff prompt
- run redaction before route send
- persist route messages
- stop/pause/resume orchestration

### 5.4 GitService

- Git preflight
- task branch creation
- protected branch checks
- snapshots/checkpoints
- changed-file tracking
- diff summary
- commit suggestion and user-confirmed commit

### 5.5 StorageService

- SQLite connection
- migrations
- repositories for tables
- transaction boundaries

### 5.6 RedactionService

- scan handoff/route/summary text
- redact secrets
- trigger Stop Orchestration for severe findings

## 6. Task Lifecycle

1. Create task.
2. Select workspace.
3. Run Git preflight.
4. Create/confirm task branch.
5. Create pre-task snapshot.
6. Launch CLI agent panes.
7. Send initial task prompt.
8. Route agent output through handoff prompts.
9. Track Git changes and terminal events.
10. Stop on completion/blocker/no-progress/user action.
11. Show result, diff, tests, commit suggestion.
12. Commit only after user confirmation.

## 7. Failure Handling

- Backend crash: renderer shows disconnected state and offers restart.
- PTY crash: mark terminal session exited/error, mark CLI run failed.
- CLI command missing: show setup error and let user override executable path.
- Git preflight fail: block automatic modification flow.
- Snapshot fail: block automatic modification flow.
- Route send fail: retry or allow manual edit/resend.
- Secret severe finding: Stop Orchestration.
- Kill Task fail: mark partial termination and show remaining child processes if detectable.

## 8. Security Boundary

V1 is a local desktop app. It is not a sandbox. CLI agents may directly edit local repo files only after Git preflight passes. Safety is provided by Git boundaries, visible terminal output, secret redaction, route limits, Stop Orchestration, Kill Task, snapshots, and user-confirmed commit.

## 9. Packaging

V1 targets macOS only.

Packaging must include:

- Electron app
- Python backend runtime strategy
- SQLite database location
- app log location
- backend log location
- settings location

Exact packaging mechanism is deferred until implementation scaffold.

