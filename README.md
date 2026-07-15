# Navide

> **The engineering instrument for the Agent era.**
>
> One engineer. An entire AI engineering force.

Navide is an AI-native software engineering environment for one person directing multiple coding agents. It combines agent and session orchestration, private project memory, configurable development pipelines, testing and review, Git workflows, terminal control, and precision editing in one local-first application.

Navide is not being built as another chat panel inside the traditional IDE. Its ambition is to become the environment that comes after it.

[English](README.md) | [繁體中文](README.zh-TW.md) | [Manifesto](docs/manifesto.md) | [Documentation](docs/README.md)

[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron)](https://www.electronjs.org/)
[![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vue.js)](https://vuejs.org/)
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python)](https://python.org/)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey?logo=apple)](https://www.apple.com/macos/)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## Why Navide?

The traditional IDE was designed for an engineer who personally performs most implementation work. AI changes that premise. One engineer can now direct multiple agents to research, plan, implement, test, review, and refine software in parallel.

AI models provide the power. Navide provides the engineering system required to direct it: roles, sessions, coordination, memory, visibility, intervention, and evidence.

```text
Traditional IDE
Engineer → edits files and operates tools → software

Navide
Engineer → directs goals, agents, decisions, and evidence → software
```

The engineer remains responsible for intent, architecture, judgment, risk, and final acceptance. Agents take on repeatable execution. Navide keeps the work synchronized, visible, interruptible, and recoverable.

Read [The Navide Manifesto](docs/manifesto.md) and [Product Vision](docs/vision.md).

## The engineering model

### Genesis — idea to working prototype

Start a new project with a configurable pipeline covering requirements, planning, design, implementation, security review, and testing. Multiple agent slots can work in parallel while context moves between stages.

### Evolution — continuous development

Develop features, fix defects, run tests, tune behavior, and maintain an existing project through coordinated agent sessions. This repeated evolution loop—not a one-time pipeline—is the center of daily work.

### Intervention — precise human control

Inspect and modify results through Diff, Monaco editor, terminal, diagnostics, Git, tests, and review tools. Direct editing remains first-class, but it is used when human judgment or precision adds value rather than being the only way to develop software.

## Current capabilities

- **Multi-agent workspaces:** run Claude Code, Codex, Antigravity CLI, Grok CLI, or a plain terminal in independent panes.
- **Session lifecycle:** detect, persist, rebuild, and resume supported CLI sessions.
- **Configurable pipelines:** define stages, parallel slots, agents, roles, kickoff prompts, questions, documentation queries, and completion sentinels.
- **Manager coordination:** route structured dispatches and worker questions and carry cross-stage context.
- **Automation controls:** combine terminal activity, provider logs, hooks, and optional local analysis with Manual, Strict, Continuous, Full Auto, and YOLO modes.
- **Private project history:** retain workspace-scoped state, run events, handoffs, and token summaries under `.agent-team/`.
- **Engineering surfaces:** explore files, edit with Monaco, inspect plans and diffs, resolve conflicts, use Git and multi-repository workflows, handle issues, review changes, and use AI Chat.
- **Observability:** track History and compatible CLI token usage by workspace, stage, pane, and run.

## Private Project Intelligence

Every engineer has a private understanding of a project: active sessions, prior attempts, task context, decisions, handoffs, and evidence. Navide stores this local engineering memory under `<workspace>/.agent-team/`.

`.agent-team/` is excluded from Git and is not intended as human-team synchronization. Source code and shared project documents remain the repository's shared truth; `.agent-team/` is the individual engineer's local intelligence layer for coordinating AI sessions.

## Management by exception

Navide aims for agents to continue through reversible, visible work without asking for approval at every step. The engineer's attention should return when ambiguity, risk, conflicting decisions, external impact, or irreversible action requires human judgment.

The long-term standard is:

> Highly autonomous, continuously visible, immediately interruptible, and accountable through evidence.

Current automation controls are an early implementation of this direction and do not yet provide the complete policy or isolation model described in the roadmap.

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

The onboarding wizard checks runtimes, detects agent CLIs, and explains relevant macOS permissions. Continue with [Getting Started](docs/getting-started.md) and the [User Guide](docs/user-guide.md).

## Privacy and safety

Navide's orchestration process, private project intelligence, and workspace state run locally. Navide does not operate a project telemetry service or require a Navide account. It is not universally offline: external agent CLIs, cloud AI providers, Context7, search, Git hosting, MCP servers, and update checks may communicate with third parties when used.

Agents normally inherit the current user's operating-system permissions, and Navide does not yet provide a complete workspace sandbox. Read [Privacy and Data Flows](docs/privacy.md) and the [Security Policy](SECURITY.md) before using sensitive code, credentials, YOLO, or Full Auto.

## Direction

Navide's goal is not to reproduce the traditional IDE screen by screen. It is to provide the complete professional capability to understand, create, navigate, edit, run, debug, test, review, version, and deliver software through an interaction model built around human intent and coordinated AI execution.

See the [Product Roadmap](docs/roadmap.md) for the path from today's working system to a complete AI-native engineering environment.

## License

MIT © Navide Team
