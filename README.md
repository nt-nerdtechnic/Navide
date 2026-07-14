# Navide

> Stop chatting with one agent. Start leading a team.

Navide is a local-first macOS desktop control plane for running and coordinating multiple AI coding agents. It brings agent terminals, configurable delivery pipelines, manager/worker routing, run history, token accounting, Git workflows, review tools, and an AI-assisted editor into one workspace.

[English](README.md) | [繁體中文](README.zh-TW.md) | [Documentation](docs/README.md)

[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron)](https://www.electronjs.org/)
[![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vue.js)](https://vuejs.org/)
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python)](https://python.org/)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey?logo=apple)](https://www.apple.com/macos/)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## Why Navide?

AI coding tools are powerful, but complex work still requires users to coordinate prompts, wait on sequential tasks, carry context between sessions, review edits, and recover stuck agents. Navide turns those isolated tools into an observable engineering workflow.

| Challenge | Navide capability |
|---|---|
| Sequential waiting | Run multiple agent slots in parallel within a stage |
| Context loss | Build and inject handoffs between pipeline stages |
| Coordination overhead | Assign a manager agent to delegate work and handle worker questions |
| Unclear agent state | Combine terminal activity, CLI logs, hooks, and optional local analysis |
| Hard-to-audit runs | Keep workspace-scoped history, session metadata, diffs, and token usage |
| Vendor lock-in | Use several agent CLIs and extend the adapter surface |

## Current capabilities

### Multi-agent workspaces

Run Claude Code, Codex, Antigravity CLI, Grok CLI, or a plain terminal in independent panes. Choose layouts, minimize live panes without stopping their PTYs, and resume supported sessions after detection.

### Configurable SDLC pipelines

The included pipeline covers requirements, planning, design, implementation, security review, and testing. Stages are configurable: each can define parallel slots, agents, roles, kickoff prompts, questions, documentation queries, and completion sentinels.

### Manager and worker coordination

Designate one slot as the manager. Navide routes structured dispatches and worker questions, carries prior-stage context forward, and lets the manager coordinate stage completion.

### Local perception and automation

Use Ollama or a compatible local GGUF model to classify intent, detect questions or stalled work, and optionally answer from task context. Manual, strict, continuous, Full Auto, and YOLO controls let users choose the level of automation.

### Development control surface

Navide includes workspace and file exploration, Monaco-based editing, plan and diff views, diagnostics, Git and multi-repository workflows, issue handling, code review, AI Chat, run history, and token tracking derived from compatible CLI logs.

## Quick start

Navide currently supports macOS 13+ and is installed from source. A signed public download has not yet been released.

### Prerequisites

- Node.js 22+ and pnpm 10+
- Python 3.12+ and uv 0.11+
- At least one supported coding CLI
- Optional: Ollama or a local GGUF model for analysis

### Install and run

```bash
git clone https://github.com/nt-nerdtechnic/Navide.git
cd Navide
pnpm install
uv --project backend sync
pnpm dev
```

The onboarding wizard checks runtimes, detects agent CLIs, and explains relevant macOS permissions. Continue with the [Getting Started guide](docs/getting-started.md).

## Architecture

Navide uses three local application layers:

```text
Electron main process
  └─ window lifecycle, backend process, updates, native integration
       ↕ IPC
Vue renderer
  └─ workspaces, panes, pipelines, editor, Git, history, and settings
       ↕ WebSocket / HTTP on loopback
Python FastAPI backend
  └─ PTYs, persistence, CLI logs, Git, analyzer, MCP, and AI services
       ↕
External agent CLIs and optional local or cloud services
```

See [Architecture](docs/architecture.md) for ownership boundaries and data flow.

## Privacy and safety

Navide's orchestration process and workspace state run locally. Navide does not operate a project telemetry service or require a Navide account. It is not universally offline: external agent CLIs, cloud AI providers, Context7, search, Git hosting, MCP servers, and update checks may communicate with third parties when used.

Cloud AI keys entered in Navide are stored locally with restrictive file permissions. Agents normally inherit the current user's operating-system permissions, and Navide does not yet provide a complete workspace sandbox. YOLO and Full Auto modes should only be enabled in trusted, version-controlled workspaces.

Read [Privacy and Data Flows](docs/privacy.md) and the [Security Policy](SECURITY.md) before using sensitive code or credentials.

## Documentation

- [Documentation index](docs/README.md)
- [User guide](docs/user-guide.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Architecture](docs/architecture.md)
- [Product roadmap](docs/roadmap.md)
- [Contributing](CONTRIBUTING.md)

## Direction

Navide's long-term direction is a local-first multi-agent development control plane: reliable orchestration, capability-based agent adapters, stronger isolation and secret handling, reproducible run artifacts, dependency-graph workflows, GitHub delivery automation, reusable pipeline templates, and cross-platform support.

The roadmap is directional rather than a delivery promise. See [Product Roadmap](docs/roadmap.md) for phases, boundaries, and exit criteria.

## License

MIT © Navide Team
