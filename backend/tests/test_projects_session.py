"""Pane session-id persistence (resume-on-restart support).

PaneRecord is the unified record for both pipeline slots and manual panes.
These tests cover that session_id round-trips through project.json and that
all spawn / detect / unspawn write paths populate panes[] correctly.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_team_backend.projects import Project, ProjectStore, SlotRecord, PaneRecord


def test_slot_record_session_id_defaults_empty() -> None:
    assert SlotRecord(label="X").session_id == ""


def test_pane_record_session_id_defaults_empty() -> None:
    assert PaneRecord(pane_id="x").session_id == ""


def test_slot_session_id_round_trips_through_panes() -> None:
    """Pipeline slot session_id is stored in panes[] and round-trips through dict."""
    proj = Project(
        id="p", name="n", workspace_path="/ws", created_at="t", updated_at="t",
    )
    from agent_team_backend.projects import StageRecord
    proj.stages = [StageRecord(stage_id="01")]
    proj.panes = [PaneRecord(pane_id="x", origin="pipeline",
                             stage_id="01", stage_index=0, slot_label="Build",
                             session_id="sess-123")]
    restored = Project.from_dict(proj.to_dict())
    pane = next((p for p in restored.panes if p.slot_label == "Build"), None)
    assert pane is not None
    assert pane.session_id == "sess-123"


def test_old_project_json_without_panes_migrates_slots(tmp_path: Path) -> None:
    """Backward compat: old project.json with stages[].slots[] migrates to panes[]."""
    legacy = {
        "id": "p", "name": "n", "workspace_path": "/ws",
        "created_at": "t", "updated_at": "t",
        "stages": [{"stage_id": "01", "slots": [
            {"label": "Build", "agent": "codex", "pane_id": "pane-1",
             "spawn_status": "spawned", "session_id": "old-sess"}
        ]}],
    }
    restored = Project.from_dict(legacy)
    assert len(restored.panes) == 1
    assert restored.panes[0].session_id == "old-sess"
    assert restored.panes[0].origin == "pipeline"
    assert restored.panes[0].slot_label == "Build"


def test_old_project_json_migrates_manual_panes(tmp_path: Path) -> None:
    """Backward compat: old manual_panes[] migrates to panes[]."""
    legacy = {
        "id": "p", "name": "n", "workspace_path": "/ws",
        "created_at": "t", "updated_at": "t",
        "stages": [],
        "manual_panes": [
            {"pane_id": "mp-1", "agent": "claude", "role": "",
             "command": "claude", "spawn_status": "spawned", "session_id": "manual-sess"}
        ],
    }
    restored = Project.from_dict(legacy)
    assert len(restored.panes) == 1
    assert restored.panes[0].origin == "manual"
    assert restored.panes[0].session_id == "manual-sess"


@pytest.fixture
def store_with_stage(tmp_path: Path) -> tuple[ProjectStore, str]:
    ws = str(tmp_path)
    store = ProjectStore()
    store.start_pipeline(
        ws,
        task_description="t",
        total_stages=1,
        stage_blueprint=[{"stage_id": "01", "title": "Build",
                          "slots": [{"label": "Build", "agent": "codex", "role": "eng"}]}],
    )
    return store, ws


def test_record_slot_spawn_persists_session_id(store_with_stage: tuple[ProjectStore, str]) -> None:
    """Claude path: id known at spawn → persisted in panes[]."""
    store, ws = store_with_stage
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="pane-1", agent="claude", session_id="claude-sess")
    project = store.peek(ws)
    assert project is not None
    pane = next((p for p in project.panes if p.slot_label == "Build"), None)
    assert pane is not None
    assert pane.session_id == "claude-sess"
    assert pane.spawn_status == "spawned"
    assert pane.origin == "pipeline"


def test_record_slot_session_fills_in_later(store_with_stage: tuple[ProjectStore, str]) -> None:
    """Codex/Gemini path: spawn first with no id, detect + persist later."""
    store, ws = store_with_stage
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="pane-1", agent="codex")
    pane = next(p for p in store.peek(ws).panes if p.slot_label == "Build")
    assert pane.session_id == ""

    store.record_slot_session(ws, stage_index=0, slot_label="Build", session_id="codex-sess")
    pane = next(p for p in store.peek(ws).panes if p.slot_label == "Build")
    assert pane.session_id == "codex-sess"


def test_record_slot_session_unknown_slot_is_noop(store_with_stage: tuple[ProjectStore, str]) -> None:
    store, ws = store_with_stage
    store.record_slot_session(ws, stage_index=0, slot_label="Nope", session_id="x")


def test_record_slot_unspawn_marks_removed_but_preserves_session(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    store, ws = store_with_stage
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="pane-1", agent="codex", session_id="sess-123")
    store.record_slot_unspawn(ws, stage_index=0, slot_label="Build")

    pane = next(p for p in store.peek(ws).panes if p.slot_label == "Build")
    assert pane.spawn_status == "removed"
    assert pane.kickoff_status == "none"
    assert pane.session_id == "sess-123"  # preserved on unspawn


def test_manual_pane_spawn_round_trips_and_can_be_rekeyed(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    store, ws = store_with_stage

    store.record_manual_pane_spawn(ws, pane_id="pane-old", agent="claude",
                                   role="", command="claude", session_id="sess-1")
    store.record_manual_pane_spawn(ws, pane_id="pane-new", previous_pane_id="pane-old",
                                   agent="claude", role="", command="claude --resume sess-1",
                                   session_id="sess-1")

    project = store.peek(ws)
    manual = [p for p in project.panes if p.origin == "manual"]
    assert len(manual) == 1
    assert manual[0].pane_id == "pane-new"
    assert manual[0].spawn_status == "spawned"
    assert manual[0].session_id == "sess-1"


def test_manual_pane_unspawn_marks_removed(store_with_stage: tuple[ProjectStore, str]) -> None:
    store, ws = store_with_stage
    store.record_manual_pane_spawn(ws, pane_id="pane-1", agent="codex")
    store.record_manual_pane_unspawn(ws, pane_id="pane-1")

    pane = next(p for p in store.peek(ws).panes if p.origin == "manual")
    assert pane.spawn_status == "removed"


def test_manual_pane_session_fills_in_later(store_with_stage: tuple[ProjectStore, str]) -> None:
    store, ws = store_with_stage
    store.record_manual_pane_spawn(ws, pane_id="pane-1", agent="gemini")
    store.record_manual_pane_session(ws, pane_id="pane-1", session_id="gemini-sess")

    pane = next(p for p in store.peek(ws).panes if p.origin == "manual")
    assert pane.session_id == "gemini-sess"


def test_manual_pane_session_can_be_cleared(store_with_stage: tuple[ProjectStore, str]) -> None:
    store, ws = store_with_stage
    store.record_manual_pane_spawn(ws, pane_id="pane-1", agent="claude", session_id="bad-sess")
    store.record_manual_pane_session(ws, pane_id="pane-1", session_id="")

    pane = next(p for p in store.peek(ws).panes if p.origin == "manual")
    assert pane.session_id == ""


def test_set_pane_run_group_reassigns_pipeline_pane(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    store, ws = store_with_stage
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="pane-1", agent="codex", run_group_id="rg-a")
    store.set_pane_run_group(ws, pane_id="pane-1", run_group_id="rg-b")

    pane = next(p for p in store.peek(ws).panes if p.pane_id == "pane-1")
    assert pane.run_group_id == "rg-b"


def test_set_pane_run_group_can_clear_group(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    store, ws = store_with_stage
    store.record_manual_pane_spawn(ws, pane_id="mp-1", agent="claude", run_group_id="rg-a")
    store.set_pane_run_group(ws, pane_id="mp-1", run_group_id="")

    pane = next(p for p in store.peek(ws).panes if p.pane_id == "mp-1")
    assert pane.run_group_id == ""


def test_set_pane_run_group_unknown_pane_is_noop(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    store, ws = store_with_stage
    store.set_pane_run_group(ws, pane_id="nope", run_group_id="rg-x")  # no raise


def test_ensure_dir_writes_self_ignoring_gitignore(tmp_path: Path) -> None:
    store = ProjectStore()
    d = store._ensure_dir(str(tmp_path))
    gi = d / ".gitignore"
    assert gi.exists()
    assert gi.read_text(encoding="utf-8").strip() == "*"


def test_ensure_dir_keeps_existing_gitignore(tmp_path: Path) -> None:
    store = ProjectStore()
    d = store.project_dir(str(tmp_path))
    d.mkdir(parents=True)
    (d / ".gitignore").write_text("# custom\n", encoding="utf-8")
    store._ensure_dir(str(tmp_path))
    assert (d / ".gitignore").read_text(encoding="utf-8") == "# custom\n"
