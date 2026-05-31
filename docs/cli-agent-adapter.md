# Agent-Team CLI Agent Adapter Spec

Status: v1 draft  
Date: 2026-05-26

## 1. Purpose

CLI adapters normalize how Agent-Team launches and controls Claude Code, Codex, and Gemini CLI through PTY-backed local shell sessions.

## 2. Supported Agents

| Agent Key | Display Name | Default Command | Default Role |
| --- | --- | --- | --- |
| `claude` | Claude Code | `claude` | planner + reviewer |
| `codex` | Codex | `codex` | implementer |
| `gemini` | Gemini CLI | `gemini` | tester + verifier |

## 3. Adapter Interface

Each adapter must support:

- `launch(task, workspace, config)`
- `send_input(text)`
- `send_prompt(prompt)`
- `interrupt()`
- `kill()`
- `resize(cols, rows)`
- `read_output()`
- `get_status()`
- `summarize_recent_output()`

## 4. Settings

Configurable per agent:

- executable path
- default args
- profile/model/config args
- env overrides
- startup prompt template
- status detection patterns

If unset, use CLI defaults.

## 5. Launch

Launch requirements:

- cwd is workspace path
- command is executable + default args
- use PTY, not plain subprocess pipe
- persist terminal session record
- record launch event

## 6. Prompt Send

Prompt sending must:

- target the correct PTY
- append newline if required by adapter config
- persist input event
- support injected user messages
- support route handoff messages

## 7. Status Detection

V1 status detection can be heuristic.

Signals:

- process state
- output activity
- known prompt suffixes
- explicit blocker text
- explicit completion text
- timeout

Statuses:

- `queued`
- `running`
- `waiting_user`
- `succeeded`
- `failed`
- `canceled`

## 8. Adapter-Specific Defaults

### Claude Code

- role: planner + reviewer
- receives initial task by default
- expected output: plan, review findings, blocker/no-blocker decision

### Codex

- role: implementer
- receives implementation handoff from Claude
- expected output: changed files, implementation summary, test notes

### Gemini CLI

- role: tester + verifier
- receives test/verification handoff from Codex
- expected output: test result, risk, blocker, suggested next action

## 9. Failure Handling

- executable missing: adapter setup error
- launch failure: terminal session error
- no output timeout: route engine warning
- crash: CLI run failed
- repeated failed send: route message failed

