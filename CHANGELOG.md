# Changelog

All notable changes to Agent-Team will be documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

<!-- 所有重要的版本變更都會記錄在這裡，格式遵循 Keep a Changelog。 -->

---

## [Unreleased]

---

## [0.1.8] — 2026-06-01

### Added

- **4-Stage SDLC Pipeline** — fully automated Requirements → Design → Implementation → QA pipeline
- **Multi-agent parallel execution** — multiple agents run concurrently within a Stage
- **Manager coordination mode** — one agent acts as Manager; workers communicate via `---ASK-START---` / `---DISPATCH-START---` / `---STAGE-DONE---` protocol
- **Local LLM Analyzer** — Ollama (qwen2.5-coder) classifies agent intent in real time (`question` / `completion` / `in_progress`)
- **Live token usage tracking** — parses Claude / Codex / Gemini CLI log files directly; no API keys required
- **Context7 doc injection** — auto-detects tech stack in the task and prefixes kickoff prompts with up-to-date framework docs
- **Pipeline Resume** — per-Stage state persisted to `.agent-team/project.json`; resume from any incomplete Stage
- **Workspace-First entry screen** — Recent list with ★ pinning and stale-folder detection (VS Code "Open Folder"-style)
- **History Timeline panel** — all run events persisted to `.agent-team/runs/{run-id}/history.jsonl`; supports filtering, search, and export
- **YOLO / Continuous / Strict / Full Auto / Local Analyzer** mode toggles
- **Claude Code lifecycle hooks** — merge-safe installer for `~/.claude/settings.json` (`PreToolUse` / `Stop` / `Notification`)
- **Role Manager** — edit or create custom Role system prompts
- **Stage Editor** — customize slot configuration, kickoff body, and sentinel strings per Stage
- Initial open-source release under MIT license

[0.1.8]: https://github.com/nt-nerdtechnic/Agent-Team/releases/tag/v0.1.8
