# Navide (Agent-Team)

> **Run Claude Code, Codex, and Gemini CLI simultaneously — orchestrated across an SDLC pipeline with automated handoffs and multi-agent coordination.**

[English](README.md) | [繁體中文](README.zh-TW.md)

[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron)](https://www.electronjs.org/)
[![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vue.js)](https://vuejs.org/)
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python)](https://python.org/)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey?logo=apple)](https://www.apple.com/macos/)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## Why Navide (Agent-Team)?

A single AI coding agent has its limits — complex tasks require waiting, context is finite, and a single role can only cover so much.
**Navide (Agent-Team) lets you run multiple agents in parallel, each with a dedicated role, passing outputs to one another like a real engineering team.**

| Pain point | Navide (Agent-Team)'s solution |
|---|---|
| One agent must finish requirements before design, then implementation — lots of waiting | Multiple agents run **in parallel** within a Stage; the next Stage starts automatically when all complete |
| Different tasks need different mindsets (PM, Backend, QA) | Each pane automatically injects the matching **Role System Prompt** |
| Agent output is long; hard to know where to pick up | After a Stage completes, **context is automatically extracted** and injected into the next Stage |
| Can't tell if an agent is thinking or stuck | Local LLM (Ollama) **interprets agent intent in real time** with a three-signal liveness probe |
| Manually pasting task descriptions and setting roles every time | One-click **▶ Run pipeline** — all 4 SDLC stages run automatically |

---

## Features

### 🚀 4-Stage SDLC Pipeline (Fully Automated)

Give it a task description and Navide (Agent-Team) automatically runs Requirements → Design → Implementation → Testing, using the right agent and role at each stage.

```
▶ Run pipeline  →  Stage 01 Requirements  →  Stage 02 Design       →  Stage 03 Implementation  →  Stage 04 QA
                       Claude · PM              Claude · PM             Codex · Backend               Gemini · QA
                                                Claude · Frontend       Claude · Frontend
```

### 🤝 Manager Coordination Mode (Multi-Agent Direction)

When a Stage has multiple parallel agents, designate one as **Manager** to coordinate:
- The Manager finishes its own work, then enters coordination mode
- Workers can ask the Manager questions via `---ASK-START---`
- The Manager dispatches instructions via `---DISPATCH-START---`
- The Manager decides when to end the Stage with `---STAGE-DONE---`

### 🧠 Local LLM Analyzer

Goes beyond sentinel strings — uses a local LLM to interpret each agent's intent in real time:

| Result | Action |
|---|---|
| `question` | Opens a dialog for the user to answer (or Full Auto answers automatically) |
| `completion` | Marks the Slot as done, counts toward Stage advancement |
| `in_progress` | Extends the liveness window, keeps waiting |

Two inference backends are available and can be switched at any time via **Settings → Analyzer**:

| Backend | How it works | When to use |
|---|---|---|
| **llama.cpp** (default) | Uses `llama-cli` / `llama-completion` directly against Ollama's GGUF blobs — no daemon required | Lower latency; works without an Ollama server running |
| **Ollama REST** | Calls `POST /api/generate` on a running Ollama server | Easier setup; Ollama manages GPU memory and concurrency |

Model downloads and deletion are available in **Settings → Analyzer → 模型管理**, regardless of which backend is selected.

### 📊 Live Token Usage Tracking

Parses token usage directly from CLI log files for all three providers, categorized by Stage and Run — no API keys or extra configuration needed.

### 📚 Context7 Doc Injection

Before each Stage starts, Navide (Agent-Team) detects the tech stack in the task (Next.js, Laravel, Flutter…), fetches the latest framework docs from Context7, and injects them into the kickoff prompt so agents start with accurate API knowledge.

### 🔄 Pipeline Resume

Closed the app mid-run or interrupted execution?
`.agent-team/project.json` records each Stage's state so you can resume from any incomplete Stage when you reopen.

### 📂 Workspace-First Entry

The app opens to a **Welcome screen** (VS Code "Open Folder"-style) rather than a blank canvas:
- **Recent list** — recently opened workspaces with last task and status; supports **★ pinning** (pinned items stay at the top and are never evicted); stale folders are automatically grayed out
- **Browse…** — folder dialog to select or create a workspace
- Automatically switches to **Pipeline / Spawn / Completed** mode based on project state

### 🕓 History Timeline

The right panel toggles between **Token Usage** and **History**:
- All events per run (spawn / inject / sentinel / question / analyzer / handoff / error) are persisted to `.agent-team/runs/{run-id}/history.jsonl`
- The Timeline UI supports **type/stage filtering, search, click-to-expand details, and .jsonl export**
- **Auto-scroll to bottom** follows new events; scrolling up automatically pauses it

---

## Demo

```
Task: "Build an internal approval system for a retail chain — digitize paper workflows, support iOS + Android"

Stage 01  Claude  (PM)           → PRD, user stories, UAT scenarios
Stage 02  Claude  (PM)           → System architecture, API design, ERD
          Claude  (Frontend)     → Wireframes, component specs, design system
Stage 03  Codex   (Backend)      → API implementation, database migrations, validation logic
          Claude  (Frontend)     → React Native pages, API integration
Stage 04  Gemini  (QA/Test)      → Happy/Unhappy paths, E2E scripts, UAT checklist
```

All outputs are passed between stages. Claude's Stage 02 design docs automatically become Codex's context in Stage 03.

---

## Quick Start

### Prerequisites

On first launch the app runs an **Onboarding Wizard** that detects the tools
below, offers one-click installs for what's missing, and hard-blocks the main UI
until the required environment is ready (re-runnable from Settings → Appearance →
Environment; set `AGENT_TEAM_SKIP_ONBOARDING=1` to bypass).

| Tool | Version |
|---|---|
| Node.js | 22+ |
| pnpm | 10+ |
| Python / uv | 3.12 / 0.11+ |
| macOS | 13+ |

**Agent CLIs (optional — required to actually run agents):**
- `claude` — [Claude Code](https://code.claude.ai)
- `codex` — [Codex CLI](https://github.com/openai/codex)
- `gemini` — [Gemini CLI](https://github.com/google-gemini/gemini-cli)

**Local LLM Analyzer (optional, recommended):**

The default backend (`llama.cpp`) requires both Ollama (for model downloads) and the llama.cpp CLI (for inference):

```bash
brew install ollama llama.cpp   # llama.cpp provides the llama-cli binary
ollama pull qwen2.5-coder        # downloads the GGUF into ~/.ollama
```

If your llama.cpp build installs the binary as `llama-cli` instead of `llama-completion`, configure it in **Settings → Analyzer → llama-cli 執行檔路徑** (or set the env var before starting):

```bash
export LLAMA_CLI=llama-cli
```

Alternatively, switch to the **Ollama REST** backend in Settings — this only requires a running Ollama server and no llama.cpp installation:

```bash
brew install ollama
ollama serve           # keep running in background
ollama pull qwen2.5-coder
```

### Install

```bash
git clone https://github.com/nt-nerdtechnic/Navide (Agent-Team)
cd Navide (Agent-Team)

pnpm install
uv --project backend sync
```

### Run

```bash
pnpm dev
```

This single command starts the Vite dev server, Electron main window, and Python backend (dynamic port) together.

---

## Usage

### Pipeline Mode (Recommended)

1. **Open Workspace** — pick from the Recent list on the Welcome screen, or Browse to select/create a project folder
2. **Task description** — describe what you want to build (any language)
3. Click **▶ Run pipeline** — the system automatically spawns Stage 01 agents, injects Role Prompts, and sends the Kickoff Prompt
4. Completion is detected automatically (sentinel / analyzer / turn_complete) → advances to the next Stage
5. Repeats through Stage 04; a completion dialog appears when done

> Open the **History** tab in the right panel at any time to see the full event timeline, or switch/close workspaces from the Header (a warning appears if a pipeline is running).

**Advanced options:**

| Setting | Description |
|---|---|
| **YOLO Mode** | Automatically passes `--dangerously-skip-permissions` and similar flags to skip confirmations |
| **Continuous Mode** | Auto-advances when a sentinel is detected or the Analyzer judges completion — no manual "Next" needed |
| **Strict Mode** | Shows a confirmation dialog on Idle/Cap timeout instead of auto-advancing |
| **Full Auto** | LLM automatically answers agent questions — zero human intervention |
| **Local Analyzer** | Local LLM interprets agent intent in real time, replacing pure sentinel detection (configure backend in Settings → Analyzer) |

### Manual Spawn (Single Run)

1. Expand the **Manual spawn** section
2. Select CLI, Role, and Stage
3. Click **+ Add to grid**

Each pane supports independent `⌃C` (interrupt), `Re-inject` (resend Role Prompt), and `Remove` (close).

### Stage / Role Customization

Toolbar gear → Settings:
- **Role Manager** — edit system prompts for each role, or add custom roles
- **Stage Editor** — adjust the slot configuration, kickoff body, and sentinel string for each Stage

All settings are stored locally in `~/Library/Application Support/Navide (Agent-Team)/` and are not committed to the repository.

---

## Completion Detection

A Slot is considered "complete" when any of the following conditions is met (in priority order):

```
1. Sentinel       — agent outputs a designated string (e.g. ---SPEC-DONE---) on its own line
2. turn_complete  — Claude Hooks / log reader detects agent turn end + 5s of silence
3. Analyzer       — Ollama LLM judges intent = "completion"
4. Idle timeout   — 10 min of no cleaned-text activity, after passing multi-signal liveness probes
5. Hard cap       — 15-minute absolute limit (prevents permanent hangs)
```

All Slots must complete before the Stage advances (in Strict Mode, Idle/Cap requires user confirmation).

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Electron Main Process                   │
│  Multi-window management (Main / Roles / Stages)         │
│  IPC handlers                                            │
│  backend.ts — dynamic port · child process supervisor    │
│              · health check                              │
└───────────────────────┬─────────────────────────────────┘
                        │ uv run python -m agent_team_backend
                        ▼
┌─────────────────────────────────────────────────────────┐
│              Python FastAPI Backend                       │
│                                                          │
│  WebSocket /ws ── all message routing (concurrent tasks) │
│  REST /health · /hooks/claude · /mcp/...                 │
│                                                          │
│  terminals.py    PTY process management (pty + asyncio)  │
│  projects.py     Pipeline state + per-run event log      │
│  analyzer.py     Ollama / llama-cli local LLM inference  │
│  log_readers/    Claude · Codex · Gemini log parsing     │
│  tokens_store.py Token usage tracking + dedup            │
│  mcp_manager.py  MCP server connections (Context7, etc.) │
│  doc_injector.py Context7 docs → kickoff prefix          │
│  claude_hooks.py ~/.claude/settings.json hook installer  │
│  roles_store.py / stages_store.py  settings persistence  │
└───────────────────────┬─────────────────────────────────┘
                        │ WebSocket ws://127.0.0.1:{port}/ws
                        ▼
┌─────────────────────────────────────────────────────────┐
│                  Vue 3 Renderer                           │
│                                                          │
│  App.vue (Orchestrator)                                  │
│  ├─ Pipeline state machine                               │
│  ├─ Stage watcher (600ms poll · sentinel · analyzer)     │
│  ├─ Manager router (4s poll · ASK/REPORT/DISPATCH)       │
│  ├─ Question alert + auto-answer                         │
│  └─ Cross-slot handoff                                   │
│                                                          │
│  ControlPane.vue   Left control panel                    │
│  TerminalPane.vue  xterm.js · displayStatus · PTY wire   │
│  TokenStatsPanel   Live token statistics                 │
│  SettingsModal     MCP server settings                   │
└─────────────────────────────────────────────────────────┘
```

### Tech Stack

| Layer | Technology |
|---|---|
| Desktop shell | Electron 33 |
| Frontend | Vue 3 + TypeScript + Vite (electron-vite) |
| Terminal emulation | xterm.js 6 + FitAddon |
| Backend | Python 3.12 + FastAPI + uvicorn |
| PTY | Python stdlib `pty` + asyncio |
| Local LLM | Ollama / llama-cli (GGUF, Metal-accelerated) |
| MCP Client | `mcp` Python SDK |
| Package management | pnpm (Node) · uv (Python) |

---

## Project Structure

```
agent-team/
├── src/
│   ├── main/
│   │   ├── index.ts          Electron main process, IPC, multi-window
│   │   └── backend.ts        Python child process management, health check
│   ├── preload/
│   │   └── index.ts          contextBridge API exposure
│   └── renderer/src/
│       ├── App.vue           Pipeline Orchestrator (main logic)
│       ├── RolesManagerApp.vue
│       ├── StagesEditorApp.vue
│       ├── components/
│       │   ├── ControlPane.vue      Left control panel
│       │   ├── TerminalPane.vue     xterm.js pane
│       │   ├── QuestionAlert.vue    Agent question dialog
│       │   ├── CompletionModal.vue  Pipeline completion modal
│       │   ├── TokenStatsPanel.vue  Token stats panel
│       │   └── SettingsModal.vue    MCP settings
│       ├── composables/
│       │   ├── useBackend.ts        WebSocket connection + message routing
│       │   ├── useTerminal.ts       xterm + PTY wire-up
│       │   ├── useRoles.ts / useStages.ts
│       │   ├── useAnalyzer.ts       Ollama API
│       │   └── useTokens.ts         Token usage reactive state
│       ├── data/
│       │   └── stages.ts            Stage/Slot types + kickoff rendering
│       └── lib/
│           └── buffer.ts            ANSI strip · sentinel · question block parser
└── backend/agent_team_backend/
    ├── app.py               FastAPI + WebSocket dispatcher
    ├── terminals.py         PTY process management
    ├── projects.py          Pipeline persistence
    ├── analyzer.py          Local LLM (Ollama)
    ├── log_readers/         Claude / Codex / Gemini log parsing
    ├── tokens_store.py      Token tracking + dedup
    ├── mcp_manager.py       MCP server connection management
    ├── doc_injector.py      Context7 doc injection
    ├── claude_hooks.py      Claude lifecycle hook installer
    ├── roles_store.py
    └── stages_store.py
```

---

## Local Data & Privacy

Navide (Agent-Team) is a local developer tool. All computation and data stay on your machine.

- **No external service dependencies** (beyond the Claude / Codex / Gemini CLIs you choose to run)
- **No telemetry, no accounts** — no API keys required
- Runtime settings stored in `~/Library/Application Support/Navide (Agent-Team)/` (not committed)
- Workspace state written to `<workspace>/.agent-team/` (`project.json`, pipeline log, pane conversation history)

### YOLO Mode Notice

Enabling YOLO Mode automatically passes the following flags:

| CLI | Flag |
|---|---|
| Claude Code | `--dangerously-skip-permissions` |
| Codex | `--dangerously-bypass-approvals-and-sandbox` |
| Gemini | `--yolo --skip-trust` |

These flags let agents skip interactive confirmations. **Agents have unrestricted filesystem read/write access.** Only use this in workspaces you trust.

### Claude Code Hooks

On first launch, Navide (Agent-Team) adds three lifecycle hooks (`PreToolUse` / `Stop` / `Notification`) to `~/.claude/settings.json` so the backend receives precise agent activity signals. Installation is merge-safe (does not overwrite existing settings), and the original `settings.json` is backed up as `.pre-agent-team.bak`.

### Unimplemented Security Features

- Automatic secret scrubbing before cross-agent context handoff (planned)
- Workspace sandboxing — agents currently run with full user-level permissions

---

## Running Tests

```bash
cd backend
uv run pytest
```

---

## Dev Commands

```bash
pnpm dev            # Start Electron + Vite + Python backend (all together)
pnpm build          # Package the Electron app
pnpm typecheck      # TypeScript type check (Node + Web)
pnpm backend:dev    # Start Python backend only (for debugging)
```

---

## Roadmap

- [ ] Git preflight (auto-create task branch, snapshot)
- [ ] Cross-agent route engine (routed message bus between agents)
- [ ] Frontend tests (Vitest + Playwright)
- [ ] Windows / Linux support
- [ ] More Agent CLI support (Aider, OpenCode, etc.)

> Full roadmap and design details in [`docs/spec.md`](docs/spec.md).

---

## Security

See [SECURITY.md](SECURITY.md) for the vulnerability reporting policy.

**Safe-use reminders:**
- YOLO Mode grants agents unrestricted filesystem access. Only use it in workspaces you trust.
- The Claude Code hooks installed by Navide (Agent-Team) are merge-safe; your original `~/.claude/settings.json` is backed up before any changes.
- Navide (Agent-Team) never stores API keys. All CLI credentials remain in the respective tool's own config (`~/.claude/`, `~/.codex/`, etc.).

---

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting a pull request.

---

## License

MIT
