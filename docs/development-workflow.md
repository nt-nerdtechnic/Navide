# Agent-Team Development Workflow

Status: v1 draft  
Date: 2026-05-26

## 1. Workflow Principle

Agent-Team development is spec-driven. Implementation must follow:

1. `docs/sdd-agent-team.md`
2. `docs/product-spec.md`
3. `.cursor/plans/*.plan.md`
4. this workflow document

Do not start implementation work that changes product behavior unless the active plan references the relevant spec section.

## 2. Required Project Flow

Every implementation task follows this order:

1. Read the active plan under `.cursor/plans/`.
2. Read the relevant spec section.
3. Run repo status checks.
4. Create or confirm task branch.
5. Create pre-task snapshot/checkpoint.
6. Implement the smallest vertical slice.
7. Run verification.
8. Update documentation if behavior changed.
9. Report changed-file scope and verification result.
10. Suggest commit message.
11. Commit only after user confirmation.

## 3. Git Preflight

Before any code change:

```bash
git status --short --branch
git branch --show-current
git rev-parse --show-toplevel
git rev-parse HEAD
```

Required behavior:

- If not in a Git repo, stop and initialize or ask user.
- If on protected branch, create task branch first.
- If working tree is dirty, classify existing changes before editing.
- Never overwrite unrelated user changes.
- Create snapshot metadata before changes.

Protected branches:

- `main`
- `master`
- `develop`
- user-configured protected branches

Task branch format:

```text
agent/{task-id}-{slug}
```

## 4. Snapshot and Checkpoint

Pre-task snapshot must capture:

- task id
- branch
- base commit
- `git status --short`
- untracked files summary
- diff patch if any
- created_at

Checkpoint defaults:

- patch file + metadata
- no temporary commit checkpoints
- stash only for dirty-tree handling when needed

Checkpoint moments:

- before orchestration starts
- after each completed route round
- before Kill Task
- before user-confirmed commit

## 5. Implementation Phases

### Phase 1: App Shell

Build:

- Electron shell
- Python backend process lifecycle
- local dev start command
- basic IPC/WebSocket health check

Acceptance:

- Electron UI starts on macOS.
- Python backend starts and reports healthy.
- UI can display backend status.

### Phase 2: Terminal Grid

Build:

- 2x2 layout
- xterm.js pane wrapper
- PTY creation through Python backend
- local shell input/output streaming
- resize handling

Acceptance:

- four panes render without overlap.
- terminal output is live.
- keyboard input reaches active PTY.
- pane resize updates PTY size.

### Phase 3: CLI Agent Adapters

Build:

- `claude` adapter
- `codex` adapter
- `gemini` adapter
- launch, send input, Ctrl-C, kill, status detection
- settings overrides for executable path and args

Acceptance:

- each CLI launches in its pane.
- prompt can be sent to each CLI.
- Ctrl-C works.
- Kill Task can terminate child processes.

### Phase 4: SQLite Persistence

Build:

- schema
- migrations
- settings
- workspace config
- task/run records
- terminal events
- route messages
- Git snapshots/checkpoints

Acceptance:

- app can restart and recover task/session history.
- route messages persist.
- Git snapshots/checkpoints persist.

### Phase 5: Git Control

Build:

- Git preflight
- protected branch detection
- task branch creation
- patch snapshot
- changed-file tracking
- diff summary
- commit suggestion and confirmation flow

Acceptance:

- task cannot auto-modify repo before Git preflight passes.
- protected branch triggers branch creation or explicit override.
- completion shows changed-file scope and commit message suggestion.
- commit only runs after confirmation.

### Phase 6: Orchestration

Build:

- route engine
- fixed handoff prompt
- Claude -> Codex -> Gemini route
- max rounds
- timeout
- no-progress detection
- route message persistence

Acceptance:

- one task can complete at least one full route cycle.
- handoff includes required fields.
- route engine stops on max rounds, timeout, no progress, blocker, Stop Orchestration, or Kill Task.

### Phase 7: Safety and Redaction

Build:

- secret scanner
- redaction before route send
- high-risk event detection
- Stop Orchestration trigger
- intervention event logging

Acceptance:

- fake token/private key is redacted before route send.
- high-risk secret triggers Stop Orchestration.
- intervention events persist.

### Phase 8: Control Pane

Build:

- global controls
- prompt composer
- route messages
- Git status
- test/diff summary
- history/log search

Acceptance:

- Stop Orchestration is always visible.
- Kill Task requires confirmation.
- Inject message can target one agent or all agents.

## 6. Verification Gates

Each phase must run the applicable checks:

- syntax/lint checks
- unit tests
- backend tests
- frontend build
- Electron launch smoke test
- PTY smoke test
- Git preflight smoke test
- route engine test
- redaction test

Before declaring a task complete:

```bash
git status --short
git diff --check
```

Also report:

- files changed
- tests run
- tests not run
- known risk
- commit message suggestion

## 7. Commit Flow

The system or developer may suggest a commit message, but must not commit automatically.

Before commit:

1. Show staged files.
2. Show diff summary.
3. Show test result.
4. Show commit message.
5. Wait for user confirmation.

After confirmation:

```bash
git add <approved-files>
git commit -m "<approved-message>"
```

Do not include unrelated user changes.

## 8. Definition of Done

A development task is done when:

- spec behavior is implemented
- verification gates pass or failures are documented
- Git scope is reviewed
- no unrelated changes are included
- docs are updated if behavior changed
- user receives concise summary and remaining risk

## 9. Current Next Work

The next technical design documents should be:

- `docs/technical-design.md`
- `docs/sqlite-schema.md`
- `docs/ipc-contract.md`
- `docs/terminal-pty-contract.md`
