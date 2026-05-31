# Agent-Team Product Spec

Status: v1 draft  
Date: 2026-05-26  
Source: `docs/sdd-agent-team.md`

## 1. Product Summary

Agent-Team 是一個 macOS desktop terminal 管理系統，用於控制 Claude Code、Codex、Gemini CLI 三個開發用 CLI agent。產品核心是 terminal grid first：使用者在同一個介面中觀看三個 agent 的開發過程，系統自動把 agent 輸出整理成 handoff prompt 並轉送給下一個 agent，盡量一次完成開發任務。

第一版不重做 agent runtime，而是用 Electron desktop UI、xterm.js 類 terminal renderer、Python local backend 與本機 shell/PTY 控制既有 CLI。

## 2. V1 Scope

### 2.1 Included

- macOS desktop app。
- Electron shell。
- Python local backend with PTY control。
- xterm.js or equivalent embedded web terminal。
- SQLite storage。
- 本機 shell only。
- 固定 2x2 terminal grid。
- 控制 `claude`、`codex`、`gemini`。
- Claude Code / Codex / Gemini CLI 自動 handoff。
- Git preflight、task branch、snapshot、checkpoint、diff tracking。
- Stop Orchestration、Kill Task、Pause/Resume、Inject Message。
- Secret redaction before route/handoff。
- Commit message 建議與使用者確認後 commit。

### 2.2 Excluded From V1

- SSH/remote/container execution。
- Windows/Linux support。
- Multi-user collaboration。
- SaaS/server deployment。
- Free-form draggable terminal layout。
- 自動 commit。
- 從零實作新的 AI agent runtime。

## 3. Target User

V1 主要使用者是個人開發者或小型技術團隊負責人，想用多個 CLI agent 協助完成開發任務，同時需要可觀察、可控制、可回復的 terminal-based workflow。

## 4. Primary UI

V1 採固定 2x2 layout：

- Pane 1: Claude Code
- Pane 2: Codex
- Pane 3: Gemini CLI
- Pane 4: Control / Route Messages / Git Status / Logs

每個 terminal pane 必須顯示：

- CLI agent name
- task name
- current status
- current command or last detected activity
- branch name
- changed-file count

Global controls 必須固定可見，不依賴目前 focus pane：

- Stop Orchestration
- Kill Task
- Pause/Resume

Control pane priority:

1. Global controls
2. Prompt composer / inject message
3. Route messages and current round
4. Git status, branch, changed files
5. Test/diff summary
6. History/log search

## 5. Agent Roles

Default role mapping:

- Claude Code: planner + reviewer
- Codex: implementer
- Gemini CLI: tester + verifier

Default launch commands:

- Claude Code: `claude`
- Codex: `codex`
- Gemini CLI: `gemini`

All three agents share the same workspace by default. Executable path, workspace path, default args, profile/model/config may be overridden in settings. If profile/model/config is not specified, each CLI agent uses its own defaults.

## 6. Orchestration

Default route:

1. Claude Code -> Codex: plan, implementation instructions, review findings.
2. Codex -> Gemini CLI: implementation summary, test request, verification request.
3. Gemini CLI -> Claude Code: test result, risk, blocker, next review input.
4. Any -> User: blocker, high-risk action, secret detection, unclear next step.

Auto-run defaults:

- `max_rounds`: 3
- single-agent no-output timeout: 10 minutes
- stop if 2 consecutive rounds have no diff/test/route progress
- complete when tests pass and Claude Code reports no blocker
- blocked when any CLI agent explicitly reports blocker

## 7. Handoff Prompt

Agent-to-agent transfer uses fixed handoff prompt plus summary. Full raw terminal output is not forwarded by default.

```text
[Handoff]
From: {source_agent}
To: {target_agent}
Task: {task_title}
Round: {round_number}
Route Type: {route_type}

Context:
{short_context_summary}

What changed / found:
{summary}

Request:
{specific_action_for_target_agent}

Evidence:
{commands_files_tests_or_diff_summary}

Constraints:
{safety_limits_workspace_branch_or_user_instructions}

Expected output:
{what_the_target_agent_should_return}
```

Before sending, every handoff must pass secret redaction.

## 8. Git Control

Git is mandatory for any task that can modify a repo.

Preflight:

- verify workspace is Git-backed
- check current branch
- check working tree
- check untracked files
- check upstream remote
- create or confirm task branch
- create pre-task snapshot

Branch rule:

- protected branches: `main`, `master`, `develop`, plus user-configured values
- do not auto-modify protected branches unless explicitly overridden
- task branch format: `agent/{task-id}-{slug}`

Checkpoint rule:

- use patch file + metadata by default
- dirty tree may optionally use stash
- no temporary commit checkpoint in V1

Completion:

- show changed-file scope
- show diff summary
- show test result
- propose commit message
- commit only after user confirmation

## 9. Safety Controls

Stop Orchestration:

- stops route engine and automatic forwarding
- keeps terminal sessions alive
- can be resumed

Kill Task:

- stops route engine
- creates termination snapshot
- sends Ctrl-C to Claude/Codex/Gemini terminals
- waits for grace period
- kills child process if needed
- marks task as `terminated`
- cannot resume automatically

High-risk conditions:

- dangerous command
- secret detection
- private key detection
- protected branch override
- file deletion or broad destructive change

High-risk conditions require approval or Stop Orchestration.

## 10. Secret Redaction

Route messages, handoff prompts, summaries, and history previews must redact:

- `.env` values
- API keys
- tokens
- private keys
- SSH keys
- database URLs
- bearer tokens
- GitHub tokens
- provider credentials

Redacted format: `[REDACTED:{type}]`.

If private key or large secret exposure is detected, Stop Orchestration and notify user.

## 11. Storage

V1 uses SQLite.

Core persisted records:

- settings
- workspace configs
- tasks
- terminal sessions/events
- CLI agent runs
- route rules/messages
- orchestration runs
- intervention events
- git repositories/snapshots/checkpoints/change events
- artifacts
- reviews

## 12. MVP Acceptance Criteria

V1 is accepted when:

1. App launches on macOS with Electron and Python backend.
2. User can open a Git-backed workspace.
3. System runs Git preflight and creates/validates task branch.
4. System creates pre-task snapshot.
5. UI shows 2x2 panes.
6. App can launch `claude`, `codex`, and `gemini`.
7. User can submit one task.
8. System completes at least one Claude -> Codex -> Gemini route cycle.
9. Handoff prompt is generated and redacted.
10. User can inject message during execution.
11. Stop Orchestration preserves terminal sessions.
12. Kill Task sends Ctrl-C, can kill child process, and creates termination snapshot.
13. Git diff and changed files are tracked.
14. Completion shows test result, diff summary, changed-file scope, commit message suggestion.
15. Commit runs only after user confirmation.
16. Terminal events, route messages, intervention events, and Git snapshots/checkpoints are recoverable.
