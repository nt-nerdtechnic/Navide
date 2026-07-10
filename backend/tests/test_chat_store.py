"""ChatStore — per-workspace chat-threads.json / chat-notes.json persistence.

Covers round-trips through disk, backward-compatible defaults for missing
files/fields, tolerance of corrupt/oversize files, invalid-workspace no-ops
(never creates anything), and the self-gitignoring .agent-team dir.
"""

from __future__ import annotations

import json
from pathlib import Path

from agent_team_backend.chat_store import MAX_FILE_BYTES, ChatStore


# ── threads ──────────────────────────────────────────────────────────────────

def test_threads_round_trip_through_disk(tmp_path: Path) -> None:
    store = ChatStore()
    threads = [{"id": "t1", "title": "Hi", "messages": [{"role": "user", "content": "hey"}]}]
    assert store.set_threads(str(tmp_path), threads) is not None
    assert ChatStore().get_threads(str(tmp_path)) == threads


def test_threads_missing_file_defaults_to_empty(tmp_path: Path) -> None:
    assert ChatStore().get_threads(str(tmp_path)) == []


def test_threads_corrupt_file_defaults_to_empty(tmp_path: Path) -> None:
    store = ChatStore()
    store.set_threads(str(tmp_path), [{"id": "t1"}])
    (tmp_path / ".agent-team" / "chat-threads.json").write_text("{not json", encoding="utf-8")
    assert store.get_threads(str(tmp_path)) == []


def test_threads_non_list_document_defaults_to_empty(tmp_path: Path) -> None:
    store = ChatStore()
    store.set_threads(str(tmp_path), [])
    (tmp_path / ".agent-team" / "chat-threads.json").write_text('{"a": 1}', encoding="utf-8")
    assert store.get_threads(str(tmp_path)) == []


def test_threads_oversize_file_defaults_to_empty(tmp_path: Path) -> None:
    store = ChatStore()
    store.set_threads(str(tmp_path), [])
    f = tmp_path / ".agent-team" / "chat-threads.json"
    f.write_text("[" + " " * MAX_FILE_BYTES + "]", encoding="utf-8")
    assert store.get_threads(str(tmp_path)) == []


def test_set_threads_overwrites_whole_document(tmp_path: Path) -> None:
    store = ChatStore()
    store.set_threads(str(tmp_path), [{"id": "old"}])
    store.set_threads(str(tmp_path), [{"id": "new"}])
    assert ChatStore().get_threads(str(tmp_path)) == [{"id": "new"}]


# ── notes ────────────────────────────────────────────────────────────────────

def test_notes_round_trip_through_disk(tmp_path: Path) -> None:
    store = ChatStore()
    pads = [{"id": "n1", "name": "Plan", "content": "steps", "updatedAt": 1}]
    assert store.set_notes(str(tmp_path), notes="quick note", notepads=pads) is not None
    assert ChatStore().get_notes(str(tmp_path)) == {"notes": "quick note", "notepads": pads}


def test_notes_missing_file_defaults(tmp_path: Path) -> None:
    assert ChatStore().get_notes(str(tmp_path)) == {"notes": "", "notepads": []}


def test_notes_corrupt_file_defaults(tmp_path: Path) -> None:
    store = ChatStore()
    store.set_notes(str(tmp_path), notes="x", notepads=[])
    (tmp_path / ".agent-team" / "chat-notes.json").write_text("[[", encoding="utf-8")
    assert store.get_notes(str(tmp_path)) == {"notes": "", "notepads": []}


def test_notes_wrong_field_types_fall_back_per_field(tmp_path: Path) -> None:
    store = ChatStore()
    f = tmp_path / ".agent-team"
    f.mkdir()
    (f / "chat-notes.json").write_text(
        json.dumps({"notes": 42, "notepads": {"nope": True}}), encoding="utf-8"
    )
    assert store.get_notes(str(tmp_path)) == {"notes": "", "notepads": []}


# ── workspace validity / dir hygiene ─────────────────────────────────────────

def test_invalid_workspace_is_a_safe_no_op(tmp_path: Path) -> None:
    store = ChatStore()
    missing = str(tmp_path / "does-not-exist")
    assert store.set_threads(missing, [{"id": "t"}]) is None
    assert store.set_notes(missing, notes="n", notepads=[]) is None
    assert store.get_threads(missing) == []
    assert store.get_notes(missing) == {"notes": "", "notepads": []}
    assert store.set_threads("", []) is None
    assert not (tmp_path / "does-not-exist").exists()


def test_write_creates_self_gitignoring_dir(tmp_path: Path) -> None:
    ChatStore().set_threads(str(tmp_path), [])
    gi = tmp_path / ".agent-team" / ".gitignore"
    assert gi.read_text(encoding="utf-8") == "*\n"
