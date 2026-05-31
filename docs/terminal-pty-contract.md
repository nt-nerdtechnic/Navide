# Agent-Team Terminal and PTY Contract

Status: v1 draft  
Date: 2026-05-26

## 1. Purpose

This document defines how the Electron renderer, xterm.js panes, and Python backend PTY sessions interact.

## 2. Pane Model

V1 panes:

- `claude`
- `codex`
- `gemini`
- `control`

Only the first three own PTY-backed terminal sessions. The control pane is UI-only.

## 3. PTY Session Creation

Required inputs:

- task id
- workspace id
- pane id
- agent key
- command
- cwd
- env
- cols
- rows

Defaults:

- cwd: workspace path
- shell: system default shell for command execution where needed
- encoding: UTF-8
- platform: macOS

## 4. Input

Renderer sends exact byte/text input to backend.

Rules:

- printable characters are forwarded as typed
- Enter sends `\r`
- paste sends full pasted text
- Ctrl-C sends interrupt event, not literal text from UI controls
- global shortcuts must not leak into PTY unless intended

## 5. Output

Backend streams PTY output chunks to renderer.

Rules:

- preserve ANSI escape sequences for xterm.js rendering
- persist raw output event text
- assign monotonic sequence per terminal session
- renderer should apply output in sequence order

## 6. Resize

Renderer sends cols/rows whenever pane size changes.

Backend must call PTY resize.

Renderer should debounce resize events to avoid flooding.

## 7. Ctrl-C and Kill

Ctrl-C:

- send interrupt to PTY foreground process
- keep terminal session open if process survives
- record intervention event if user-triggered

Kill:

- stop route engine first
- create termination snapshot
- send Ctrl-C to all agent PTYs
- wait grace period
- kill process group if still running
- mark task terminated
- mark sessions exited/error as appropriate

## 8. Status Detection

Backend tracks:

- `starting`
- `running`
- `waiting_input`
- `exited`
- `error`

V1 detection is heuristic:

- process alive -> running
- output inactivity plus known prompt indicators -> waiting_input
- process exit -> exited
- launch/PTY failure -> error

## 9. Buffering

Backend keeps a rolling output buffer per terminal session for route analysis.

Defaults:

- route analysis buffer: latest relevant output window
- persistence: append-only terminal events
- handoff: summaries only, not full raw terminal output

## 10. Terminal Event Persistence

Persist:

- stdout/stderr output chunks
- user input events
- system events such as launch, resize, interrupt, kill, exit

Do not persist unredacted handoff route content outside protected local storage. Route messages must be redacted before persistence as route messages.

## 11. Error Cases

- PTY launch fails: mark terminal error and show setup action.
- executable missing: show settings override prompt.
- write fails: mark session error.
- resize fails: log warning, keep session alive.
- process exits: mark exited and keep output visible.

