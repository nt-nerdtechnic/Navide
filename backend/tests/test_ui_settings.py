"""Tests for UiSettingsStore — defaults, merge semantics, atomic write, corrupt recovery."""

from __future__ import annotations

import json
from pathlib import Path

from agent_team_backend.ui_settings import UiSettingsStore, _MAX_FILE_SIZE


def make_store(tmp_path: Path) -> UiSettingsStore:
    return UiSettingsStore(path=tmp_path / "ui_settings.json")


# ── Defaults ──────────────────────────────────────────────────────────────────

def test_get_missing_file_returns_empty_dict(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    assert store.get() == {}


def test_empty_set_does_not_create_file(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    assert store.set({}) == {}
    assert not store.path.exists()


# ── Merge semantics ───────────────────────────────────────────────────────────

def test_set_get_roundtrip(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.set({"agent-team:theme": "dark", "agentTeam.colWidths": [120, 80]})
    result = store.get()
    assert result["agent-team:theme"] == "dark"
    assert result["agentTeam.colWidths"] == [120, 80]


def test_shallow_merge_preserves_other_keys(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.set({"a": 1, "b": 2})
    store.set({"b": 3})
    assert store.get() == {"a": 1, "b": 3}


def test_none_value_deletes_key(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.set({"a": 1, "b": 2})
    store.set({"a": None})
    assert store.get() == {"b": 2}


def test_set_returns_applied_delta(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.set({"a": 1})
    delta = store.set({"b": 2, "a": None})
    assert delta == {"b": 2, "a": None}


def test_non_string_and_empty_keys_ignored(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    delta = store.set({1: "x", "": "y", "ok": "z"})  # type: ignore[dict-item]
    assert delta == {"ok": "z"}
    assert store.get() == {"ok": "z"}


# ── Atomic write ──────────────────────────────────────────────────────────────

def test_write_is_atomic_no_tmp_left_behind(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.set({"a": 1})
    files = sorted(p.name for p in tmp_path.iterdir())
    assert files == ["ui_settings.json"]
    # File on disk is complete, valid JSON.
    assert json.loads(store.path.read_text(encoding="utf-8")) == {"a": 1}


# ── Corrupt / oversized recovery ──────────────────────────────────────────────

def test_corrupt_file_returns_empty_dict(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.path.parent.mkdir(parents=True, exist_ok=True)
    store.path.write_text("{not json", encoding="utf-8")
    assert store.get() == {}


def test_non_object_root_returns_empty_dict(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.path.parent.mkdir(parents=True, exist_ok=True)
    store.path.write_text("[1, 2, 3]", encoding="utf-8")
    assert store.get() == {}


def test_oversized_file_returns_empty_dict(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.path.parent.mkdir(parents=True, exist_ok=True)
    store.path.write_text('{"pad": "' + "x" * (_MAX_FILE_SIZE + 1) + '"}', encoding="utf-8")
    assert store.get() == {}


def test_set_recovers_corrupt_file(tmp_path: Path) -> None:
    store = make_store(tmp_path)
    store.path.parent.mkdir(parents=True, exist_ok=True)
    store.path.write_text("{not json", encoding="utf-8")
    store.set({"a": 1})
    assert store.get() == {"a": 1}
    assert json.loads(store.path.read_text(encoding="utf-8")) == {"a": 1}
