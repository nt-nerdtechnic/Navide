"""ProjectStore.set_ui_state — per-workspace run-group records + active tab.

The run-group tab records are renderer-owned UI state persisted on the
Project. Covers round-trips through disk, partial updates, the None/[] field
semantics (None = never persisted → frontend runs legacy migration; [] = the
user deleted every group), peek semantics, and backward-compatible defaults
for old project.json files without the fields.
"""

from __future__ import annotations

import json
from pathlib import Path

from agent_team_backend.projects import ProjectStore


def _store_with_project(ws: Path) -> ProjectStore:
    store = ProjectStore()
    store.save(store.load_or_create(str(ws)))
    return store


GROUPS = [
    {"id": "rg-default", "name": "預設", "createdAt": 1},
    {"id": "rg-2", "name": "Run 2", "createdAt": 2},
]


def test_run_groups_round_trip_through_disk(tmp_path: Path) -> None:
    store = _store_with_project(tmp_path)
    result = store.set_ui_state(str(tmp_path), run_groups=GROUPS)
    assert result is not None
    assert result.ui_run_groups == GROUPS
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.ui_run_groups == GROUPS


def test_active_tab_round_trip_through_disk(tmp_path: Path) -> None:
    store = _store_with_project(tmp_path)
    store.set_ui_state(str(tmp_path), active_tab="rg-2")
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.ui_active_tab == "rg-2"


def test_partial_update_leaves_other_field_untouched(tmp_path: Path) -> None:
    store = _store_with_project(tmp_path)
    store.set_ui_state(str(tmp_path), run_groups=GROUPS, active_tab="rg-2")
    store.set_ui_state(str(tmp_path), active_tab="manual")
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.ui_run_groups == GROUPS
    assert fresh.ui_active_tab == "manual"


def test_git_tab_repo_round_trip_through_disk(tmp_path: Path) -> None:
    store = _store_with_project(tmp_path)
    store.set_ui_state(str(tmp_path), git_tab_repo="/ws/sub/repo")
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.ui_git_tab_repo == "/ws/sub/repo"


def test_spawn_history_round_trip_through_disk(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace-a"
    other_workspace = tmp_path / "workspace-b"
    workspace.mkdir()
    other_workspace.mkdir()
    store = _store_with_project(workspace)
    _store_with_project(other_workspace)
    history = [{
        "paneId": "pane-1",
        "agentKey": "codex",
        "agentLabel": "Codex",
        "customName": "Workspace title",
        "workspacePath": str(workspace),
    }]
    store.set_ui_state(str(workspace), spawn_history=history)
    fresh = ProjectStore().peek(str(workspace))
    assert fresh is not None
    assert fresh.ui_spawn_history == history
    other = ProjectStore().peek(str(other_workspace))
    assert other is not None
    assert other.ui_spawn_history is None


def test_empty_spawn_history_is_distinct_from_legacy_missing_field(tmp_path: Path) -> None:
    store = _store_with_project(tmp_path)
    store.set_ui_state(str(tmp_path), spawn_history=[])
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.ui_spawn_history == []


def test_git_tab_repo_partial_update_leaves_other_fields_untouched(tmp_path: Path) -> None:
    store = _store_with_project(tmp_path)
    store.set_ui_state(str(tmp_path), run_groups=GROUPS, active_tab="rg-2")
    store.set_ui_state(str(tmp_path), git_tab_repo="/ws/repo-a")
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.ui_run_groups == GROUPS
    assert fresh.ui_active_tab == "rg-2"
    assert fresh.ui_git_tab_repo == "/ws/repo-a"


def test_empty_list_is_stored_distinct_from_never_set(tmp_path: Path) -> None:
    """[] (user deleted all groups) must survive a reload — not decay to None."""
    store = _store_with_project(tmp_path)
    store.set_ui_state(str(tmp_path), run_groups=[])
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.ui_run_groups == []


def test_no_arguments_is_a_no_op(tmp_path: Path) -> None:
    store = _store_with_project(tmp_path)
    assert store.set_ui_state(str(tmp_path)) is None
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.ui_run_groups is None


def test_no_project_returns_none_and_creates_nothing(tmp_path: Path) -> None:
    """peek semantics: setting UI state must never create a project.json."""
    store = ProjectStore()
    assert store.set_ui_state(str(tmp_path), active_tab="rg-1") is None
    assert not store.project_file(str(tmp_path)).exists()


def test_project_json_without_fields_defaults(tmp_path: Path) -> None:
    """Backward compat: old project.json without the fields → None / ''."""
    store = _store_with_project(tmp_path)
    project_file = store.project_file(str(tmp_path))
    data = json.loads(project_file.read_text(encoding="utf-8"))
    data.pop("ui_run_groups", None)
    data.pop("ui_active_tab", None)
    data.pop("ui_git_tab_repo", None)
    data.pop("ui_spawn_history", None)
    project_file.write_text(json.dumps(data), encoding="utf-8")
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert fresh.ui_run_groups is None
    assert fresh.ui_active_tab == ""
    assert fresh.ui_git_tab_repo == ""
    assert fresh.ui_spawn_history is None
