"""Tests for tmux_name persistence in ProjectStore."""

from __future__ import annotations

import json

import pytest

from agent_team_backend.projects import (
    ManualPaneRecord,
    Project,
    ProjectStore,
    SlotRecord,
)


# ── SlotRecord / ManualPaneRecord default field ────────────────────────────────

def test_slot_record_tmux_name_default():
    slot = SlotRecord(label="s1")
    assert slot.tmux_name == ""


def test_manual_pane_record_tmux_name_default():
    pane = ManualPaneRecord(pane_id="p1")
    assert pane.tmux_name == ""


# ── backward-compat: old JSON without tmux_name loads cleanly ─────────────────

def test_from_dict_slot_missing_tmux_name():
    """Project.from_dict must not fail when tmux_name is absent in stored JSON."""
    data = {
        "id": "proj_abc",
        "name": "test",
        "workspace_path": "/tmp/ws",
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
        "stages": [{
            "stage_id": "01",
            "title": "Stage 1",
            "slots": [{"label": "A", "agent": "claude"}],
        }],
        "manual_panes": [{"pane_id": "mp1", "agent": "claude"}],
    }
    project = Project.from_dict(data)
    assert project.stages[0].slots[0].tmux_name == ""
    assert project.manual_panes[0].tmux_name == ""


# ── record_slot_tmux_name ──────────────────────────────────────────────────────

def test_record_slot_tmux_name_persists(tmp_path):
    store = ProjectStore()
    ws = str(tmp_path)
    # Bootstrap a project with one stage and one slot
    project = store.load_or_create(ws, name="test")
    from agent_team_backend.projects import StageRecord
    project.stages = [StageRecord(stage_id="01", title="Stage 1")]
    project.stages[0].slots = [SlotRecord(label="A", agent="claude", spawn_status="spawned")]
    store.save(project)

    store.record_slot_tmux_name(ws, stage_index=0, slot_label="A", tmux_name="at-abc123")

    reloaded = store.load_or_create(ws)
    assert reloaded.stages[0].slots[0].tmux_name == "at-abc123"


def test_record_slot_tmux_name_missing_slot_is_noop(tmp_path):
    store = ProjectStore()
    ws = str(tmp_path)
    project = store.load_or_create(ws, name="test")
    from agent_team_backend.projects import StageRecord
    project.stages = [StageRecord(stage_id="01")]
    store.save(project)

    # Should return without error even when slot does not exist.
    result = store.record_slot_tmux_name(ws, stage_index=0, slot_label="nonexistent", tmux_name="at-abc123")
    assert result is not None


def test_record_slot_tmux_name_invalid_index(tmp_path):
    store = ProjectStore()
    ws = str(tmp_path)
    store.load_or_create(ws, name="test")

    with pytest.raises(IndexError):
        store.record_slot_tmux_name(ws, stage_index=99, slot_label="A", tmux_name="at-abc123")


# ── record_manual_pane_tmux_name ───────────────────────────────────────────────

def test_record_manual_pane_tmux_name_persists(tmp_path):
    store = ProjectStore()
    ws = str(tmp_path)
    project = store.load_or_create(ws, name="test")
    project.manual_panes = [ManualPaneRecord(pane_id="p1", agent="claude", spawn_status="spawned")]
    store.save(project)

    store.record_manual_pane_tmux_name(ws, pane_id="p1", tmux_name="at-xyz999")

    reloaded = store.load_or_create(ws)
    assert reloaded.manual_panes[0].tmux_name == "at-xyz999"


def test_record_manual_pane_tmux_name_missing_pane_is_noop(tmp_path):
    store = ProjectStore()
    ws = str(tmp_path)
    store.load_or_create(ws, name="test")

    result = store.record_manual_pane_tmux_name(ws, pane_id="ghost", tmux_name="at-abc123")
    assert result is not None


# ── tmux_name format validation ───────────────────────────────────────────────

def test_record_slot_tmux_name_rejects_invalid_format(tmp_path):
    store = ProjectStore()
    ws = str(tmp_path)
    project = store.load_or_create(ws, name="test")
    from agent_team_backend.projects import StageRecord
    project.stages = [StageRecord(stage_id="01", title="Stage 1")]
    project.stages[0].slots = [SlotRecord(label="A", agent="claude", spawn_status="spawned")]
    store.save(project)

    with pytest.raises(ValueError, match="invalid tmux_name"):
        store.record_slot_tmux_name(ws, stage_index=0, slot_label="A", tmux_name="evil; rm -rf /")


def test_record_manual_pane_tmux_name_rejects_invalid_format(tmp_path):
    store = ProjectStore()
    ws = str(tmp_path)
    project = store.load_or_create(ws, name="test")
    project.manual_panes = [ManualPaneRecord(pane_id="p1", agent="claude", spawn_status="spawned")]
    store.save(project)

    with pytest.raises(ValueError, match="invalid tmux_name"):
        store.record_manual_pane_tmux_name(ws, pane_id="p1", tmux_name="../../../etc/passwd")


def test_record_slot_tmux_name_allows_empty_string(tmp_path):
    """Empty string (clearing) must bypass format validation."""
    store = ProjectStore()
    ws = str(tmp_path)
    project = store.load_or_create(ws, name="test")
    from agent_team_backend.projects import StageRecord
    project.stages = [StageRecord(stage_id="01", title="Stage 1")]
    project.stages[0].slots = [SlotRecord(label="A", agent="claude", spawn_status="spawned", tmux_name="at-abc123")]
    store.save(project)

    store.record_slot_tmux_name(ws, stage_index=0, slot_label="A", tmux_name="")
    reloaded = store.load_or_create(ws)
    assert reloaded.stages[0].slots[0].tmux_name == ""


# ── clear_tmux_name_by_value ───────────────────────────────────────────────────

def test_clear_tmux_name_clears_manual_pane(tmp_path):
    store = ProjectStore()
    ws = str(tmp_path)
    project = store.load_or_create(ws, name="test")
    project.manual_panes = [ManualPaneRecord(pane_id="p1", agent="claude", tmux_name="at-aabbcc")]
    store.save(project)

    store.clear_tmux_name_by_value(ws, "at-aabbcc")

    reloaded = store.load_or_create(ws)
    assert reloaded.manual_panes[0].tmux_name == ""


def test_clear_tmux_name_clears_slot(tmp_path):
    store = ProjectStore()
    ws = str(tmp_path)
    project = store.load_or_create(ws, name="test")
    from agent_team_backend.projects import StageRecord
    project.stages = [StageRecord(stage_id="01", title="Stage 1")]
    project.stages[0].slots = [SlotRecord(label="A", agent="claude", tmux_name="at-xxyyzz")]
    store.save(project)

    store.clear_tmux_name_by_value(ws, "at-xxyyzz")

    reloaded = store.load_or_create(ws)
    assert reloaded.stages[0].slots[0].tmux_name == ""


def test_clear_tmux_name_noop_for_unknown_workspace(tmp_path):
    store = ProjectStore()
    # Should not raise even when workspace has no project.json
    store.clear_tmux_name_by_value(str(tmp_path / "nonexistent"), "at-abc123")


def test_clear_tmux_name_noop_for_empty_string(tmp_path):
    store = ProjectStore()
    ws = str(tmp_path)
    store.load_or_create(ws, name="test")
    # Empty tmux_name should be a no-op (no save triggered)
    store.clear_tmux_name_by_value(ws, "")


def test_record_manual_pane_tmux_name_roundtrip(tmp_path):
    """tmux_name survives a save → reload cycle including JSON serialisation."""
    store = ProjectStore()
    ws = str(tmp_path)
    project = store.load_or_create(ws, name="test")
    project.manual_panes = [ManualPaneRecord(pane_id="p2", agent="gemini", spawn_status="spawned")]
    store.save(project)

    store.record_manual_pane_tmux_name(ws, pane_id="p2", tmux_name="at-roundtrip")

    raw = json.loads((store.project_file(ws)).read_text())
    assert raw["manual_panes"][0]["tmux_name"] == "at-roundtrip"
