# Architecture

This document describes stable ownership boundaries in the current Navide application. For historical implementation milestones, see [spec.md](spec.md). For future direction, see [roadmap.md](roadmap.md).

## System context

Navide is a desktop control plane around external coding-agent CLIs. It does not host the foundation models used by those CLIs and does not replace their authentication, billing, sandbox, or data policy.

```text
User and workspace
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ Navide desktop application                               │
│                                                          │
│ Electron main ── IPC ── Vue renderer ── WS/HTTP ── Python│
│                                                          │
└──────────────────────────────────────────────────────────┘
        │ PTY, files, Git, local logs, MCP, model requests
        ▼
External agent CLIs, local models, cloud providers, and Git hosts
```

## Process boundaries

### Electron main process

The Electron main process owns operating-system integration:

- Application and window lifecycle
- Preload bridge and renderer IPC
- Python backend process startup and health supervision
- Native file dialogs, menus, permissions, and dock behavior
- Separate editor and management windows
- In-app update state and release checks

The renderer must not receive unrestricted Node.js access. Native operations should cross the preload boundary through narrow, typed APIs.

### Vue renderer

The renderer owns interactive application state and workflow presentation:

- Workspace entry and recent-workspace UI
- Pane layouts, terminal rendering, and user input
- Pipeline state machine and stage activation
- Manager/worker protocol parsing and routing
- Settings, roles, pipelines, MCP, and analyzer controls
- Explorer, Monaco editor, Git, issues, review, AI Chat, history, and token views

Renderer composables communicate with the backend through correlated WebSocket requests and broadcast events. Terminal display state is distinct from the underlying PTY state.

### Python FastAPI backend

The backend owns long-running local services and persistence:

- PTY creation, input buffering, resize, output batching, and session registry
- Workspace project state and recent workspaces
- File, Git, issue, review, and editor services
- Agent CLI log readers, session attribution, activity events, and token usage
- Local analyzer and optional model-provider calls
- MCP lifecycle and Context7 document injection
- Claude Code hooks and backend event ingestion
- Run history, UI settings, roles, and pipeline definitions

The backend listens on loopback and is supervised by Electron. It is not intended to be exposed as a network service.

## Runtime workflow

### Manual pane

```text
User selects workspace, agent, and role
  → renderer builds spawn request
  → backend starts PTY with CLI command
  → renderer waits for CLI readiness
  → role and task are injected
  → log reader binds the provider session when available
  → output, activity, history, and token events update the UI
```

### Pipeline

```text
Task description
  → load configurable stages and slots
  → pre-spawn eligible agent panes
  → activate current stage with prior-stage context
  → run slots in parallel
  → collect questions, analyzer signals, and completion sentinels
  → manager routes work when configured
  → persist handoff and advance
  → finish in completed or maintenance mode
```

Completion is a workflow signal, not proof that generated code is correct. Git review and explicit verification remain quality gates.

## Persistence boundaries

### Workspace-scoped

`.agent-team/` contains project state such as pipeline progress, run history, and token summaries. Files under this directory can include task descriptions and agent output; treat them as project data.

### Application-scoped

The application data directory contains registries and preferences such as roles, pipeline definitions, recent workspaces, analyzer settings, token attribution metadata, and optional AI Chat credentials.

### Provider-owned

Claude Code, Codex, Antigravity, Grok, Git clients, model runtimes, and MCP servers retain their own configuration, sessions, credentials, logs, and caches. Navide reads selected provider-owned logs or databases for session attribution and usage reporting.

## Agent integration boundary

An agent integration currently spans:

- Frontend agent key and launch specification
- CLI readiness and session-marker behavior
- Resume-command syntax
- Backend whitelist and onboarding dependency
- Provider log or database reader
- Session attribution and token display
- CLI-specific concurrency or home-directory handling when required

See the [CLI Extension Guide](cli-extension-guide.md). A capability-based adapter contract is a roadmap goal because the current integration surface is distributed across several modules.

## Trust boundaries

- External agents can execute commands with the current user's permissions.
- YOLO mode can remove external CLI approval or sandbox gates.
- Cloud providers and MCP servers receive data according to the selected feature and configuration.
- Cross-agent handoffs can propagate sensitive text.
- Local API-key file permissions are defense in depth, not a secret vault.
- Git history and run artifacts can preserve data after a working file is deleted.

See [Privacy and Data Flows](privacy.md) and [SECURITY.md](../SECURITY.md).

## Architectural direction

Long-term architecture work should strengthen the existing control-plane boundary instead of duplicating complete IDE or model-provider platforms. The primary seams are:

1. A declarative agent-adapter contract
2. A durable orchestration event and artifact model
3. Policy-controlled tool execution and workspace isolation
4. Dependency-graph scheduling beyond a fixed linear pipeline
5. Connectors that turn external work items into reviewable delivery runs
