# Agent-Team Git Control Spec

Status: v1 draft  
Date: 2026-05-26

## 1. Purpose

Git control prevents autonomous CLI agents from damaging or mixing repository changes. Any task that modifies a repo must pass Git preflight before automation starts.

## 2. Preflight Commands

```bash
git rev-parse --show-toplevel
git branch --show-current
git rev-parse HEAD
git status --short --branch
```

Optional:

```bash
git remote -v
git rev-parse --abbrev-ref --symbolic-full-name @{u}
```

## 3. Protected Branches

Defaults:

- `main`
- `master`
- `develop`

If current branch is protected:

1. create task branch, or
2. require explicit protected branch override.

Task branch:

```text
agent/{task-id}-{slug}
```

## 4. Dirty Working Tree

If dirty before task:

- classify existing changes
- create pre-task snapshot
- show warning
- allow continue only if user accepts preserving existing state

Never overwrite unrelated user changes.

## 5. Snapshots

Snapshot metadata:

- task id
- workspace id
- repo path
- branch
- base commit
- status short
- untracked files
- patch path
- created_at

Snapshot types:

- `pre_task`
- `termination`
- `manual`

## 6. Checkpoints

V1 checkpoint strategy:

- patch file + metadata
- no temporary commit checkpoints
- optional stash only for dirty-tree handling

Checkpoint moments:

- after each completed route round
- before Kill Task
- before user-confirmed commit

## 7. Change Tracking

During automation:

- poll `git status --short`
- collect changed files
- generate diff summary
- attach changed-file summary to handoff messages
- warn on task-external file changes

## 8. Completion

Before completion:

- show changed-file scope
- show diff summary
- show test result
- propose commit message

Commit only after user confirmation.

Commit flow:

```bash
git add <approved-files>
git commit -m "<approved-message>"
```

Do not commit unrelated user changes.

## 9. Termination

Kill Task must:

1. stop route engine
2. create termination snapshot
3. interrupt/kill CLI processes
4. mark task terminated
5. show changed files and recovery options

