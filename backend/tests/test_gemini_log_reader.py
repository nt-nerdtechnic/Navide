"""GeminiLogReader: assistant-turn 'tokens' parsing + projects.json lookup."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend.log_readers.gemini import GeminiLogReader


def _write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


@pytest.fixture
def fake_gemini(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """tmp $HOME with ~/.gemini/{tmp,projects.json} prepared."""
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    (home / ".gemini" / "tmp").mkdir(parents=True)
    return home


def _gemini_event(event_id: str, *, input_t=0, output_t=0, cached=0, thoughts=0, tool=0) -> dict:
    return {
        "id": event_id,
        "timestamp": "2026-05-28T00:00:00.000Z",
        "type": "gemini",
        "tokens": {
            "input": input_t,
            "output": output_t,
            "cached": cached,
            "thoughts": thoughts,
            "tool": tool,
            "total": input_t + output_t + cached + thoughts + tool,
        },
        "model": "gemini-3-flash-preview",
        "sessionId": "sess-1",
    }


def test_parses_basic_assistant_turn(fake_gemini: Path) -> None:
    reader = GeminiLogReader()
    session = fake_gemini / ".gemini" / "tmp" / "myproj" / "chats" / "s1.jsonl"
    _write_jsonl(session, [
        {"id": "x", "type": "user", "message": "hi"},   # ignored
        _gemini_event("e1", input_t=100, output_t=50, cached=20, thoughts=15, tool=5),
    ])
    events = reader.parse_session_file(session, set())
    assert len(events) == 1
    ev = events[0]
    assert ev.vendor == "gemini"
    # input = input + cached
    assert ev.input_tokens == 120
    # output = output + thoughts + tool
    assert ev.output_tokens == 70


def test_dedup_by_id(fake_gemini: Path) -> None:
    reader = GeminiLogReader()
    session = fake_gemini / ".gemini" / "tmp" / "p" / "chats" / "s.jsonl"
    _write_jsonl(session, [
        _gemini_event("dup", input_t=10, output_t=5),
        _gemini_event("dup", input_t=10, output_t=5),  # same id, dedup
    ])
    events = reader.parse_session_file(session, set())
    assert len(events) == 1


def test_cwd_resolved_via_projects_json(fake_gemini: Path) -> None:
    reader = GeminiLogReader()
    (fake_gemini / ".gemini" / "projects.json").write_text(
        json.dumps({"myproj": {"path": "/Users/me/Desktop/myproj"}}), encoding="utf-8"
    )
    session = fake_gemini / ".gemini" / "tmp" / "myproj" / "chats" / "s.jsonl"
    _write_jsonl(session, [_gemini_event("e1", input_t=10, output_t=5)])
    events = reader.parse_session_file(session, set())
    assert events[0].cwd == "/Users/me/Desktop/myproj"


def test_cwd_empty_when_projects_json_absent(fake_gemini: Path) -> None:
    reader = GeminiLogReader()
    session = fake_gemini / ".gemini" / "tmp" / "myproj" / "chats" / "s.jsonl"
    _write_jsonl(session, [_gemini_event("e1", input_t=10, output_t=5)])
    events = reader.parse_session_file(session, set())
    assert events[0].cwd == ""


def test_session_files_enumerates_chats_folders(fake_gemini: Path) -> None:
    reader = GeminiLogReader()
    (fake_gemini / ".gemini" / "tmp" / "a" / "chats").mkdir(parents=True)
    (fake_gemini / ".gemini" / "tmp" / "a" / "chats" / "s1.jsonl").write_text("", encoding="utf-8")
    (fake_gemini / ".gemini" / "tmp" / "b" / "chats").mkdir(parents=True)
    (fake_gemini / ".gemini" / "tmp" / "b" / "chats" / "s2.jsonl").write_text("", encoding="utf-8")
    # Project without chats/ folder should be ignored
    (fake_gemini / ".gemini" / "tmp" / "c").mkdir(parents=True)
    (fake_gemini / ".gemini" / "tmp" / "c" / "notes.json").write_text("", encoding="utf-8")
    files = reader.session_files()
    assert len(files) == 2


def test_zero_tokens_skipped(fake_gemini: Path) -> None:
    reader = GeminiLogReader()
    session = fake_gemini / ".gemini" / "tmp" / "p" / "chats" / "s.jsonl"
    _write_jsonl(session, [_gemini_event("e1")])  # all zeros
    events = reader.parse_session_file(session, set())
    assert events == []


def test_missing_tokens_field_skipped(fake_gemini: Path) -> None:
    reader = GeminiLogReader()
    session = fake_gemini / ".gemini" / "tmp" / "p" / "chats" / "s.jsonl"
    _write_jsonl(session, [
        {"id": "e1", "type": "gemini", "content": "no tokens key"},
    ])
    events = reader.parse_session_file(session, set())
    assert events == []


def test_missing_id_skipped(fake_gemini: Path) -> None:
    reader = GeminiLogReader()
    session = fake_gemini / ".gemini" / "tmp" / "p" / "chats" / "s.jsonl"
    _write_jsonl(session, [
        {"type": "gemini", "tokens": {"input": 10, "output": 5}},  # no id field
    ])
    events = reader.parse_session_file(session, set())
    assert events == []


def test_session_files_includes_both_jsonl_and_json(fake_gemini: Path) -> None:
    """Newer Gemini writes single-object .json; older wrote .jsonl. The watcher
    must enqueue both so session-id capture (resume) sees the file."""
    reader = GeminiLogReader()
    chats = fake_gemini / ".gemini" / "tmp" / "p" / "chats"
    chats.mkdir(parents=True)
    (chats / "old.jsonl").write_text("{}\n", encoding="utf-8")
    (chats / "new.json").write_text("{}", encoding="utf-8")
    names = {f.name for f in reader.session_files()}
    assert names == {"old.jsonl", "new.json"}


def test_single_object_json_does_not_crash_parse(fake_gemini: Path) -> None:
    """A single-object .json isn't line-delimited; parse must skip it cleanly
    (token tracking for that format is handled elsewhere), not raise."""
    reader = GeminiLogReader()
    session = fake_gemini / ".gemini" / "tmp" / "p" / "chats" / "s.json"
    session.parent.mkdir(parents=True)
    session.write_text(json.dumps({
        "sessionId": "uuid", "messages": [{"type": "user", "content": [{"text": "hi"}]}],
    }, indent=2), encoding="utf-8")
    assert reader.parse_session_file(session, set()) == []
    assert reader.parse_activity(session, set()) == []
