"""ProjectStore.set_pane_order — drag-reorder persistence for project.panes.

Covers the happy path (full id list), tolerance for panes missing from the
list (they keep relative order and are appended after the listed ones — no
data loss), unknown ids (ignored), and peek semantics (no project → None,
nothing created on disk).
"""

from __future__ import annotations

from pathlib import Path

from agent_team_backend.projects import PaneRecord, ProjectStore


def _store_with_panes(ws: Path, pane_ids: list[str]) -> ProjectStore:
    store = ProjectStore()
    project = store.load_or_create(str(ws))
    project.panes = [PaneRecord(pane_id=pid, origin="manual") for pid in pane_ids]
    store.save(project)
    return store


def _order(store: ProjectStore, ws: Path) -> list[str]:
    project = store.peek(str(ws))
    assert project is not None
    return [p.pane_id for p in project.panes]


def test_reorders_panes_to_match_full_id_list(tmp_path: Path) -> None:
    store = _store_with_panes(tmp_path, ["a", "b", "c"])
    result = store.set_pane_order(str(tmp_path), pane_ids=["c", "a", "b"])
    assert result is not None
    assert _order(store, tmp_path) == ["c", "a", "b"]


def test_panes_missing_from_list_keep_order_and_append_after(tmp_path: Path) -> None:
    """Partial pane_ids (e.g. a stale frontend list) must not drop records."""
    store = _store_with_panes(tmp_path, ["a", "b", "c", "d"])
    store.set_pane_order(str(tmp_path), pane_ids=["c", "a"])
    assert _order(store, tmp_path) == ["c", "a", "b", "d"]


def test_unknown_ids_in_list_are_ignored(tmp_path: Path) -> None:
    store = _store_with_panes(tmp_path, ["a", "b"])
    store.set_pane_order(str(tmp_path), pane_ids=["ghost", "b", "a"])
    assert _order(store, tmp_path) == ["b", "a"]


def test_no_project_returns_none_and_creates_nothing(tmp_path: Path) -> None:
    """peek semantics: reordering must never create a project.json."""
    store = ProjectStore()
    assert store.set_pane_order(str(tmp_path), pane_ids=["a"]) is None
    assert not store.project_file(str(tmp_path)).exists()


def test_new_order_survives_reload(tmp_path: Path) -> None:
    store = _store_with_panes(tmp_path, ["a", "b", "c"])
    store.set_pane_order(str(tmp_path), pane_ids=["b", "c", "a"])
    fresh = ProjectStore().peek(str(tmp_path))
    assert fresh is not None
    assert [p.pane_id for p in fresh.panes] == ["b", "c", "a"]
