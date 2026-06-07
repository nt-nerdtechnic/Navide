# 🌌 Navide (Agent-Team)

> **Stop chatting with an agent. Start leading a team.**
> Run Claude Code, Codex, and Gemini CLI simultaneously — orchestrated across an SDLC pipeline with automated handoffs and multi-agent coordination.

[English](README.md) | [繁體中文](README.zh-TW.md)

[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron)](https://www.electronjs.org/)
[![Vue 3](https://img.shields.io/badge/Vue-3-4FC08D?logo=vue.js)](https://vuejs.org/)
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python)](https://python.org/)
[![Platform](https://img.shields.io/badge/platform-macOS-lightgrey?logo=apple)](https://www.apple.com/macos/)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

---

## ⚡ Why Navide (Agent-Team)?

A single AI coding agent has its limits — complex tasks require constant waiting, context is finite, and a single model often struggles to switch between PM, Backend, and QA mindsets.

**Navide transforms your AI tools from isolated chat boxes into a coordinated engineering team.**

| Pain point | Navide's Solution |
| :--- | :--- |
| **Linear Waiting** | **Parallel Execution**: Run multiple agents (Frontend/Backend) simultaneously within a Stage. |
| **Context Loss** | **Automated Handoffs**: Context is extracted and injected across 4 SDLC stages automatically. |
| **Stuck Agents** | **Local LLM Analyzer**: A dedicated local LLM interprets agent intent to keep the pipeline moving. |
| **Manual Input** | **Full Auto Mode**: AI answers the agent's questions based on your task context. |

---

## 🚀 Core Features

### 🛠️ 4-Stage SDLC Pipeline
Transform a simple task description into a finished product through a fully automated pipeline:
**Requirements → Design → Implementation → Testing**. Navide picks the right role and agent for every step.

### 🤝 Manager Coordination Mode
Designate a **Manager Agent** (e.g., Claude) to orchestrate a team of Worker Agents. 
- Manager dispatches instructions via `---DISPATCH---`.
- Workers report progress or ask questions via `---ASK---`.
- Manager decides when the stage is complete.

### 🧠 Local LLM Perception (Analyzer)
Beyond simple text matching, Navide uses **Ollama** or **llama.cpp** to interpret the CLI's intent in real-time.
- **Intent Detection**: Recognizes if the agent is asking a question or is stuck.
- **Full Auto**: Automatically answers technical questions to achieve 100% autonomy.

### ✍️ AI-Native Editor & Explorer
A built-in editor designed specifically for AI workflows:
- **AI Hunks**: Review AI-proposed edits with inline diffs and per-hunk acceptance.
- **Ghost Text**: Inline completions as you type.
- **Cmd+K Rewrite**: Select code and give instructions for instant AI refactoring.

### 📊 Real-Time Token Tracking
Track costs accurately by parsing log files directly from the providers. No API keys required for tracking — categorized by Stage and Run.

---

## 🏁 Quick Start

### 1. Prerequisites
Navide (Agent-Team) is a local-first tool. Ensure you have the basics:
- **Node.js 22+** & **pnpm 10+**
- **Python 3.12+** & **uv 0.11+**
- **macOS 13+**
- (Optional) [Ollama](https://ollama.com/) for Local Analysis.

### 2. Installation
```bash
# Clone the repository
git clone https://github.com/nt-nerdtechnic/Agent-Team
cd Agent-Team

# Install dependencies
pnpm install
uv --project backend sync
```

### 3. Run
```bash
pnpm dev
```
*Upon launch, the **Onboarding Wizard** will guide you through the setup and tool detection.*

---

## 🏗️ Architecture

Navide is built with a **dual-engine** design:

- **Orchestration Engine (Electron + Vue 3)**: Manages UI, state machines, and terminal grids.
- **Perception Engine (Python FastAPI)**: Handles PTY management, real-time log reading, and local LLM inference.

```
┌───────────────────────────┐      ┌───────────────────────────┐
│     Electron/Vue UI       │      │   Python FastAPI Backend  │
│ (Orchestrator & Terminal)  │ <──> │ (PTY, Logs, LLM Analyzer) │
└─────────────┬─────────────┘      └─────────────┬─────────────┘
              │                                  │
              ▼                                  ▼
      ┌──────────────────────────────────────────────────┐
      │  External Agent CLIs (Claude, Codex, Gemini)      │
      └──────────────────────────────────────────────────┘
```

---

## 🔒 Safety & Privacy

- **100% Local**: All computation and orchestration data stay on your machine.
- **No Telemetry**: We don't track your tasks or your code.
- **YOLO Mode**: Skip interactive confirmations at your own risk. YOLO mode grants agents unrestricted filesystem access.

---

## 🗺️ Roadmap
- [ ] Git Preflight & Automated Task Branching
- [ ] Cross-agent Route Engine (Enhanced Bus)
- [ ] Windows & Linux Support
- [ ] Support for more Agent CLIs (Aider, etc.)

---

## 📄 License
MIT © Navide Team
