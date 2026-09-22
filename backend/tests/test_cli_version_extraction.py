"""Phase 1b: readers carry the CLI version their transcript records.

claude and qwen stamp every record; codex keeps it in the session_meta
header (carried through the incremental checkpoint); copilot's events.jsonl
names it in session.start; muse in the session metadata build. The vendors
whose logs have no version are pinned to "" so the by_version bucket reads
``vendor@unknown`` rather than inventing one.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from agent_team_backend.cli_vendors.claude import ClaudeLogReader
from agent_team_backend.cli_vendors.codex import CodexLogReader
from agent_team_backend.cli_vendors.qwen import QwenLogReader
from agent_team_backend.log_readers.base import TurnCall, TurnUsage


def _write(path: Path, records: list[dict]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(r) + "\n" for r in records), encoding="utf-8")
    return path


def _claude_assistant(msg_id: str, version: str, ts: str) -> dict:
    return {
        "type": "assistant", "requestId": f"r-{msg_id}", "timestamp": ts, "version": version,
        "message": {"id": msg_id, "model": "m", "usage": {
            "input_tokens": 10, "output_tokens": 2,
            "cache_read_input_tokens": 5, "cache_creation_input_tokens": 1,
        }},
    }


def test_claude_records_carry_version_and_the_cache_split(tmp_path: Path) -> None:
    log = _write(tmp_path / "s1.jsonl", [
        {"type": "user", "promptId": "p1", "timestamp": "2026-09-16T00:00:00Z",
         "version": "2.1.270", "message": {"role": "user", "content": "hi"}},
        _claude_assistant("m1", "2.1.270", "2026-09-16T00:00:01Z"),
        {"type": "user", "promptId": "p2", "timestamp": "2026-09-16T00:01:00Z",
         "version": "2.1.273", "message": {"role": "user", "content": "again"}},
        _claude_assistant("m2", "2.1.273", "2026-09-16T00:01:01Z"),
    ])
    reader = ClaudeLogReader()
    events = reader.parse_session_file(log, set())
    assert [e.cli_version for e in events] == ["2.1.270", "2.1.273"]
    assert events[0].input_tokens == 16 and events[0].cache_read_tokens == 5
    assert events[0].cache_creation_tokens == 1
    inc = reader.parse_incremental(log, {})
    assert [e.cli_version for e in inc.events] == ["2.1.270", "2.1.273"]
    turns = reader.turns_for_session(log)
    assert [t.cli_version for t in turns] == ["2.1.270", "2.1.273"]
    assert turns[1].calls[0].cli_version == "2.1.273"


def test_a_turn_takes_the_last_calls_version_when_they_differ() -> None:
    turn = TurnUsage(turn_index=1, session_id="s", started_at=None, ended_at=None, prompt_excerpt="")
    turn.add_call(TurnCall(ts=None, model="m", input=1, cache_read=0, cache_creation=0, output=1,
                           cli_version="2.1.270"))
    turn.add_call(TurnCall(ts=None, model="m", input=1, cache_read=0, cache_creation=0, output=1))
    assert turn.cli_version == "2.1.270"      # a call without one keeps the last known
    turn.add_call(TurnCall(ts=None, model="m", input=1, cache_read=0, cache_creation=0, output=1,
                           cli_version="2.1.273"))
    assert turn.cli_version == "2.1.273"


def _codex_token_count(inp: int, out: int, ts: str) -> dict:
    return {"type": "event_msg", "timestamp": ts, "payload": {
        "type": "token_count", "info": {"total_token_usage": {
            "input_tokens": inp, "cached_input_tokens": 0, "output_tokens": out,
            "reasoning_output_tokens": 0,
        }},
    }}


def test_codex_version_comes_from_session_meta_and_rides_the_checkpoint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    home = tmp_path / "codex"
    monkeypatch.setenv("CODEX_HOME", str(home))
    log = _write(home / "sessions" / "2026" / "09" / "16" / "rollout-s1.jsonl", [
        {"type": "session_meta", "timestamp": "2026-09-16T00:00:00Z", "payload": {
            "id": "s1", "cwd": str(tmp_path), "cli_version": "0.154.0", "model": "gpt-5",
        }},
        {"type": "event_msg", "timestamp": "2026-09-16T00:00:01Z",
         "payload": {"type": "user_message", "message": "hello"}},
        _codex_token_count(100, 10, "2026-09-16T00:00:02Z"),
    ])
    reader = CodexLogReader()
    [event] = reader.parse_session_file(log, set())
    assert event.cli_version == "0.154.0"
    inc = reader.parse_incremental(log, {})
    assert [e.cli_version for e in inc.events] == ["0.154.0"]
    assert inc.checkpoint["cli_version"] == "0.154.0"
    # A tail read that no longer sees the header still knows the version.
    with log.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(_codex_token_count(150, 12, "2026-09-16T00:00:03Z")) + "\n")
    tail = reader.parse_incremental(log, inc.checkpoint)
    assert [e.cli_version for e in tail.events] == ["0.154.0"]
    turns = reader.turns_for_session(log)
    assert turns and turns[0].cli_version == "0.154.0"
    assert turns[0].calls[0].cli_version == "0.154.0"


def test_qwen_records_carry_version(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("HOME", str(tmp_path))
    log = _write(tmp_path / ".qwen" / "projects" / "p" / "chats" / "session-s1.jsonl", [
        {"type": "assistant", "uuid": "u1", "timestamp": "2026-09-16T00:00:00Z",
         "version": "0.21.12", "cwd": str(tmp_path), "model": "qwen3",
         "usageMetadata": {"promptTokenCount": 40, "candidatesTokenCount": 4,
                           "cachedContentTokenCount": 10}},
    ])
    reader = QwenLogReader()
    [event] = reader.parse_session_file(log, set())
    assert event.cli_version == "0.21.12"
    assert event.cache_read_tokens == 10
    inc = reader.parse_incremental(log, {})
    assert [e.cli_version for e in inc.events] == ["0.21.12"]
