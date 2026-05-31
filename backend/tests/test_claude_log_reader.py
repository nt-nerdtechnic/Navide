"""ClaudeLogReader: parse real-shape JSONL with dedup + cache folding."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend.log_readers.claude import ClaudeLogReader


def _write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r) + "\n")


@pytest.fixture
def fake_claude(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[ClaudeLogReader, Path]:
    """Pin CLAUDE_CONFIG_DIR to tmp_path so the reader uses our fixture."""
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path))
    return ClaudeLogReader(), tmp_path / "projects"


def test_project_dirs_picks_up_env_override(fake_claude: tuple[ClaudeLogReader, Path]) -> None:
    reader, root = fake_claude
    root.mkdir(parents=True)
    dirs = reader.project_dirs()
    assert root in dirs


def test_parses_assistant_usage(fake_claude: tuple[ClaudeLogReader, Path]) -> None:
    reader, root = fake_claude
    session = root / "-tmp-demo" / "abc-123.jsonl"
    _write_jsonl(session, [
        {"type": "mode", "mode": "normal"},   # ignored
        {
            "type": "assistant",
            "sessionId": "abc-123",
            "requestId": "req_42",
            "timestamp": "2026-05-28T00:00:00Z",
            "message": {
                "id": "msg_1",
                "model": "claude-opus-4-7",
                "usage": {
                    "input_tokens": 100,
                    "output_tokens": 50,
                    "cache_read_input_tokens": 30,
                    "cache_creation_input_tokens": 5,
                },
            },
        },
    ])
    seen: set[str] = set()
    events = reader.parse_session_file(session, seen)
    assert len(events) == 1
    ev = events[0]
    assert ev.vendor == "claude"
    # input = 100 + 30 + 5 (cache folded in)
    assert ev.input_tokens == 135
    assert ev.output_tokens == 50
    assert ev.cwd == "/tmp/demo"
    assert ev.model == "claude-opus-4-7"


def test_dedup_by_message_id_plus_request_id(fake_claude: tuple[ClaudeLogReader, Path]) -> None:
    reader, root = fake_claude
    session = root / "-x" / "s1.jsonl"
    # Same message.id+requestId appears twice (streaming chunk repeat).
    base = {
        "type": "assistant",
        "requestId": "req_1",
        "message": {"id": "msg_1", "usage": {"input_tokens": 10, "output_tokens": 5}},
    }
    _write_jsonl(session, [base, base])
    seen: set[str] = set()
    events = reader.parse_session_file(session, seen)
    assert len(events) == 1


def test_seen_keys_persist_across_calls(fake_claude: tuple[ClaudeLogReader, Path]) -> None:
    reader, root = fake_claude
    session = root / "-x" / "s1.jsonl"
    _write_jsonl(session, [
        {"type": "assistant", "requestId": "r1",
         "message": {"id": "m1", "usage": {"input_tokens": 10, "output_tokens": 5}}},
    ])
    seen: set[str] = set()
    events1 = reader.parse_session_file(session, seen)
    events2 = reader.parse_session_file(session, seen)
    assert len(events1) == 1
    assert len(events2) == 0   # already in seen_keys


def test_distinct_message_ids_both_recorded(fake_claude: tuple[ClaudeLogReader, Path]) -> None:
    reader, root = fake_claude
    session = root / "-x" / "s1.jsonl"
    _write_jsonl(session, [
        {"type": "assistant", "requestId": "r1",
         "message": {"id": "m1", "usage": {"input_tokens": 10, "output_tokens": 5}}},
        {"type": "assistant", "requestId": "r2",
         "message": {"id": "m2", "usage": {"input_tokens": 20, "output_tokens": 8}}},
    ])
    events = reader.parse_session_file(session, set())
    assert len(events) == 2
    assert events[0].input_tokens == 10
    assert events[1].input_tokens == 20


def test_malformed_line_does_not_abort(fake_claude: tuple[ClaudeLogReader, Path]) -> None:
    reader, root = fake_claude
    session = root / "-x" / "s1.jsonl"
    session.parent.mkdir(parents=True, exist_ok=True)
    session.write_text(
        '{"type":"assistant","message":{"id":"m1","usage":{"input_tokens":7,"output_tokens":3}},"requestId":"r1"}\n'
        '{not valid json\n'
        '{"type":"assistant","message":{"id":"m2","usage":{"input_tokens":11,"output_tokens":2}},"requestId":"r2"}\n',
        encoding="utf-8",
    )
    events = reader.parse_session_file(session, set())
    assert len(events) == 2


def test_skips_lines_without_usage(fake_claude: tuple[ClaudeLogReader, Path]) -> None:
    reader, root = fake_claude
    session = root / "-x" / "s1.jsonl"
    _write_jsonl(session, [
        {"type": "assistant", "message": {"id": "m1"}, "requestId": "r1"},  # no usage
        {"type": "user", "message": {"id": "u1", "usage": {"input_tokens": 5}}, "requestId": "r2"},  # wrong type
    ])
    events = reader.parse_session_file(session, set())
    assert events == []


def test_zero_zero_event_skipped(fake_claude: tuple[ClaudeLogReader, Path]) -> None:
    reader, root = fake_claude
    session = root / "-x" / "s1.jsonl"
    _write_jsonl(session, [
        {"type": "assistant", "requestId": "r1",
         "message": {"id": "m1", "usage": {"input_tokens": 0, "output_tokens": 0}}},
    ])
    events = reader.parse_session_file(session, set())
    assert events == []


def test_cwd_reverses_from_dir_name_unambiguous(fake_claude: tuple[ClaudeLogReader, Path]) -> None:
    """When the path has no literal dashes in segments, decode is exact."""
    reader, root = fake_claude
    session = root / "-Users-example-Desktop-AgentTeam" / "s.jsonl"
    _write_jsonl(session, [
        {"type": "assistant", "requestId": "r1",
         "message": {"id": "m1", "usage": {"input_tokens": 1, "output_tokens": 1}}},
    ])
    events = reader.parse_session_file(session, set())
    assert events[0].cwd == "/Users/example/Desktop/AgentTeam"


def test_cwd_decoder_known_ambiguity_in_dashed_segments(fake_claude: tuple[ClaudeLogReader, Path]) -> None:
    """If the original cwd had a literal '-', the decoded form loses it
    (becomes '/'). Documented limitation; attribution layer should match via
    forward encoding instead of trusting this decoded string."""
    reader, root = fake_claude
    # Original cwd would be /Users/example/Desktop/Agent-Team — encoded the same
    # as /Users/example/Desktop/Agent/Team. The decoder picks the slash form.
    session = root / "-Users-example-Desktop-Agent-Team" / "s.jsonl"
    _write_jsonl(session, [
        {"type": "assistant", "requestId": "r1",
         "message": {"id": "m1", "usage": {"input_tokens": 1, "output_tokens": 1}}},
    ])
    events = reader.parse_session_file(session, set())
    # All '-' get decoded to '/' — this is the known ambiguity.
    assert events[0].cwd == "/Users/example/Desktop/Agent/Team"


def test_session_files_enumerates_all(fake_claude: tuple[ClaudeLogReader, Path]) -> None:
    reader, root = fake_claude
    (root / "-a").mkdir(parents=True)
    (root / "-a" / "s1.jsonl").write_text("", encoding="utf-8")
    (root / "-a" / "s2.jsonl").write_text("", encoding="utf-8")
    (root / "-b").mkdir(parents=True)
    (root / "-b" / "s3.jsonl").write_text("", encoding="utf-8")
    # Non-jsonl should be ignored.
    (root / "-a" / "readme.txt").write_text("", encoding="utf-8")
    files = reader.session_files()
    assert len(files) == 3
    assert {f.name for f in files} == {"s1.jsonl", "s2.jsonl", "s3.jsonl"}
