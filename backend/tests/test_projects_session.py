"""Slot session-id persistence (resume-on-restart support).

SlotRecord gained a `session_id` field; these cover that it round-trips through
project.json and that the spawn / detect write paths populate it.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from agent_team_backend.projects import Project, ProjectStore, SlotRecord


def test_slot_record_session_id_defaults_empty() -> None:
    assert SlotRecord(label="X").session_id == ""


def test_slot_session_id_round_trips_through_dict() -> None:
    proj = Project(
        id="p", name="n", workspace_path="/ws", created_at="t", updated_at="t",
    )
    from agent_team_backend.projects import StageRecord
    proj.stages = [StageRecord(stage_id="01", slots=[SlotRecord(label="Build", session_id="sess-123")])]
    restored = Project.from_dict(proj.to_dict())
    assert restored.stages[0].slots[0].session_id == "sess-123"


def test_old_project_json_without_session_id_loads(tmp_path: Path) -> None:
    """Backward compat: pre-feature project.json has no session_id key."""
    legacy = {
        "id": "p", "name": "n", "workspace_path": "/ws",
        "created_at": "t", "updated_at": "t",
        "stages": [{"stage_id": "01", "slots": [{"label": "Build", "agent": "codex"}]}],
    }
    restored = Project.from_dict(legacy)
    assert restored.stages[0].slots[0].session_id == ""


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
    """Claude path: id known at spawn → persisted in one shot."""
    store, ws = store_with_stage
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="pane-1", agent="claude", session_id="claude-sess")
    reloaded = store.peek(ws)
    assert reloaded is not None
    assert reloaded.stages[0].slots[0].session_id == "claude-sess"


def test_record_slot_session_fills_in_later(store_with_stage: tuple[ProjectStore, str]) -> None:
    """Codex/Gemini path: spawn first with no id, detect + persist later."""
    store, ws = store_with_stage
    store.record_slot_spawn(ws, stage_index=0, slot_label="Build",
                            pane_id="pane-1", agent="codex")
    assert store.peek(ws).stages[0].slots[0].session_id == ""
    store.record_slot_session(ws, stage_index=0, slot_label="Build", session_id="codex-sess")
    assert store.peek(ws).stages[0].slots[0].session_id == "codex-sess"


def test_record_slot_session_unknown_slot_is_noop(store_with_stage: tuple[ProjectStore, str]) -> None:
    store, ws = store_with_stage
    # Should not raise on a slot that doesn't exist.
    store.record_slot_session(ws, stage_index=0, slot_label="Nope", session_id="x")


def test_record_slot_unspawn_marks_removed_but_preserves_session(
    store_with_stage: tuple[ProjectStore, str]
) -> None:
    store, ws = store_with_stage
    store.record_slot_spawn(
        ws,
        stage_index=0,
        slot_label="Build",
        pane_id="pane-1",
        agent="codex",
        session_id="sess-123",
    )

    store.record_slot_unspawn(ws, stage_index=0, slot_label="Build")

    slot = store.peek(ws).stages[0].slots[0]
    assert slot.spawn_status == "removed"
    assert slot.pane_id is None
    assert slot.kickoff_status == "none"
    assert slot.session_id == "sess-123"
