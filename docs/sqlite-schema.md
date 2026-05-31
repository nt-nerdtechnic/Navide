# Agent-Team SQLite Schema

Status: v1 draft  
Date: 2026-05-26

## 1. Principles

- SQLite is the local source of truth for V1.
- Terminal raw output can be large; store append-only terminal events with retention controls later.
- Git snapshots/checkpoints store metadata in SQLite and patch files on disk.
- All timestamps use ISO-8601 UTC strings.
- Use `TEXT` ids as UUID strings.

## 2. Tables

### settings

Global key-value settings.

| Column | Type | Notes |
| --- | --- | --- |
| key | TEXT PRIMARY KEY | setting key |
| value_json | TEXT NOT NULL | JSON encoded value |
| updated_at | TEXT NOT NULL | ISO time |

### workspaces

| Column | Type | Notes |
| --- | --- | --- |
| id | TEXT PRIMARY KEY | UUID |
| name | TEXT NOT NULL | display name |
| path | TEXT NOT NULL UNIQUE | local path |
| created_at | TEXT NOT NULL |  |
| updated_at | TEXT NOT NULL |  |

### workspace_configs

| Column | Type | Notes |
| --- | --- | --- |
| workspace_id | TEXT PRIMARY KEY | FK workspaces.id |
| protected_branches_json | TEXT NOT NULL | default main/master/develop |
| test_commands_json | TEXT NOT NULL | commands |
| agent_config_json | TEXT NOT NULL | executable/default args/profile/model |
| route_config_json | TEXT NOT NULL | route defaults |
| redaction_config_json | TEXT NOT NULL | secret rules |
| updated_at | TEXT NOT NULL |  |

### tasks

| Column | Type | Notes |
| --- | --- | --- |
| id | TEXT PRIMARY KEY | UUID |
| workspace_id | TEXT NOT NULL | FK |
| title | TEXT NOT NULL |  |
| prompt | TEXT NOT NULL | original user task |
| status | TEXT NOT NULL | draft/running/completed/blocked/terminated |
| current_round | INTEGER NOT NULL DEFAULT 0 |  |
| created_at | TEXT NOT NULL |  |
| updated_at | TEXT NOT NULL |  |
| completed_at | TEXT NULL |  |

### terminal_sessions

| Column | Type | Notes |
| --- | --- | --- |
| id | TEXT PRIMARY KEY | UUID |
| task_id | TEXT NOT NULL | FK |
| workspace_id | TEXT NOT NULL | FK |
| pane_id | TEXT NOT NULL | claude/codex/gemini/control |
| agent_key | TEXT NULL | claude/codex/gemini |
| command | TEXT NOT NULL | launch command |
| cwd | TEXT NOT NULL | workspace path |
| status | TEXT NOT NULL | starting/running/exited/error |
| pid | INTEGER NULL | process id |
| created_at | TEXT NOT NULL |  |
| exited_at | TEXT NULL |  |

### terminal_events

| Column | Type | Notes |
| --- | --- | --- |
| id | TEXT PRIMARY KEY | UUID |
| terminal_session_id | TEXT NOT NULL | FK |
| event_type | TEXT NOT NULL | stdout/stderr/input/system |
| data | TEXT NOT NULL | event text |
| sequence | INTEGER NOT NULL | monotonic per session |
| created_at | TEXT NOT NULL |  |

Indexes:

- `(terminal_session_id, sequence)`

### cli_agent_runs

| Column | Type | Notes |
| --- | --- | --- |
| id | TEXT PRIMARY KEY | UUID |
| task_id | TEXT NOT NULL | FK |
| terminal_session_id | TEXT NOT NULL | FK |
| agent_key | TEXT NOT NULL | claude/codex/gemini |
| role | TEXT NOT NULL | planner/reviewer/implementer/tester/verifier |
| status | TEXT NOT NULL | queued/running/waiting_user/succeeded/failed/canceled |
| started_at | TEXT NULL |  |
| finished_at | TEXT NULL |  |
| summary | TEXT NULL | latest parsed summary |

### orchestration_runs

| Column | Type | Notes |
| --- | --- | --- |
| id | TEXT PRIMARY KEY | UUID |
| task_id | TEXT NOT NULL | FK |
| status | TEXT NOT NULL | idle/routing/paused/stopped/completed/failed/terminated |
| max_rounds | INTEGER NOT NULL | default 3 |
| current_round | INTEGER NOT NULL |  |
| no_progress_count | INTEGER NOT NULL |  |
| started_at | TEXT NOT NULL |  |
| finished_at | TEXT NULL |  |

### route_messages

| Column | Type | Notes |
| --- | --- | --- |
| id | TEXT PRIMARY KEY | UUID |
| orchestration_run_id | TEXT NOT NULL | FK |
| task_id | TEXT NOT NULL | FK |
| round_number | INTEGER NOT NULL |  |
| source_agent_key | TEXT NOT NULL | claude/codex/gemini/user/system |
| target_agent_key | TEXT NOT NULL | claude/codex/gemini/user |
| route_type | TEXT NOT NULL | plan/test_request/etc |
| content | TEXT NOT NULL | redacted handoff |
| raw_source_excerpt | TEXT NULL | optional redacted evidence |
| status | TEXT NOT NULL | pending/sent/failed/skipped |
| created_at | TEXT NOT NULL |  |
| sent_at | TEXT NULL |  |

### intervention_events

| Column | Type | Notes |
| --- | --- | --- |
| id | TEXT PRIMARY KEY | UUID |
| task_id | TEXT NOT NULL | FK |
| orchestration_run_id | TEXT NULL | FK |
| event_type | TEXT NOT NULL | pause/resume/inject_message/stop_orchestration/kill_task |
| target_agent_key | TEXT NULL | null means all/team |
| payload_json | TEXT NOT NULL | details |
| created_at | TEXT NOT NULL |  |

### git_repositories

| Column | Type | Notes |
| --- | --- | --- |
| id | TEXT PRIMARY KEY | UUID |
| workspace_id | TEXT NOT NULL | FK |
| root_path | TEXT NOT NULL | repo root |
| current_branch | TEXT NULL | latest observed |
| upstream | TEXT NULL | latest observed |
| updated_at | TEXT NOT NULL |  |

### git_snapshots

| Column | Type | Notes |
| --- | --- | --- |
| id | TEXT PRIMARY KEY | UUID |
| task_id | TEXT NOT NULL | FK |
| repository_id | TEXT NOT NULL | FK |
| snapshot_type | TEXT NOT NULL | pre_task/termination/manual |
| branch | TEXT NOT NULL |  |
| base_commit | TEXT NOT NULL | HEAD |
| status_short | TEXT NOT NULL | git status --short |
| patch_path | TEXT NULL | path to patch file |
| metadata_json | TEXT NOT NULL | extra metadata |
| created_at | TEXT NOT NULL |  |

### git_checkpoints

| Column | Type | Notes |
| --- | --- | --- |
| id | TEXT PRIMARY KEY | UUID |
| task_id | TEXT NOT NULL | FK |
| round_number | INTEGER NULL |  |
| checkpoint_type | TEXT NOT NULL | manual/auto/pre_commit |
| branch | TEXT NOT NULL |  |
| base_commit | TEXT NOT NULL |  |
| patch_path | TEXT NULL |  |
| metadata_json | TEXT NOT NULL | changed files, source run |
| created_at | TEXT NOT NULL |  |

### git_change_events

| Column | Type | Notes |
| --- | --- | --- |
| id | TEXT PRIMARY KEY | UUID |
| task_id | TEXT NOT NULL | FK |
| source_run_id | TEXT NULL | CLI run |
| branch | TEXT NOT NULL |  |
| changed_files_json | TEXT NOT NULL | array |
| diff_summary | TEXT NOT NULL | summary |
| status_short | TEXT NOT NULL |  |
| created_at | TEXT NOT NULL |  |

### artifacts

| Column | Type | Notes |
| --- | --- | --- |
| id | TEXT PRIMARY KEY | UUID |
| task_id | TEXT NOT NULL | FK |
| artifact_type | TEXT NOT NULL | diff_summary/test_result/final_summary |
| title | TEXT NOT NULL |  |
| content | TEXT NOT NULL |  |
| created_at | TEXT NOT NULL |  |

### reviews

| Column | Type | Notes |
| --- | --- | --- |
| id | TEXT PRIMARY KEY | UUID |
| task_id | TEXT NOT NULL | FK |
| status | TEXT NOT NULL | approved/changes_requested/rejected |
| comment | TEXT NULL |  |
| created_at | TEXT NOT NULL |  |

## 3. Migration Strategy

- Use sequential migration files under `backend/migrations`.
- Store applied migrations in `schema_migrations`.
- Migration id format: `YYYYMMDDHHMM_name`.
- Migrations must be idempotent in development.

## 4. File Storage

Patch/checkpoint files are stored outside SQLite:

```text
{app_data}/workspaces/{workspace_id}/tasks/{task_id}/snapshots/
{app_data}/workspaces/{workspace_id}/tasks/{task_id}/checkpoints/
```

SQLite stores file paths and metadata.

