"""tokens.turns: the per-turn cut of one session log, read on demand.

The handler is a thin wire over app.scan_session_turns, so what is pinned
here is the contract the Turn Stats window is written against: a pane
resolves to its session through the live-scan registry (the same binding
"THIS SESSION" uses), the reply shape, the error codes, and that the parse
runs on the dedicated live-scan worker rather than the shared pool.
"""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend.log_readers.base import LogReader, TurnCall, TurnUsage
from agent_team_backend.tokens_store import TokensStore


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class _Reader(LogReader):
    vendor = "fake"

    def __init__(self, method: str = "exact") -> None:
        self.turns_method = method
        self.threads: list[str] = []

    def project_dirs(self) -> list[Path]:
        return []

    def session_files(self) -> list[Path]:
        return []

    def parse_session_file(self, path: Path, seen_keys: set[str]) -> list:
        return []

    def turns_for_session(self, path: Path, session_id: str = "") -> list[TurnUsage]:
        self.threads.append(threading.current_thread().name)
        turn = TurnUsage(
            turn_index=1, session_id=session_id, started_at="2026-09-16T00:00:00Z",
            ended_at="2026-09-16T00:00:03Z", prompt_excerpt="hello",
        )
        turn.add_call(TurnCall(
            ts="2026-09-16T00:00:01Z", model="m", input=1, cache_read=20, cache_creation=3, output=4,
        ))
        return [turn]


@pytest.fixture()
def reader(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> _Reader:
    fake = _Reader()
    monkeypatch.setattr(app, "_readers", [fake])
    monkeypatch.setattr(app, "_live_scans", {})
    monkeypatch.setattr(app, "tokens_store", TokensStore(
        global_path=tmp_path / "global-tokens.json",
        workspace_base_dir=tmp_path / "workspaces",
    ))
    return fake


def _bind(tmp_path: Path, pane_id: str, session_id: str, *, vendor: str = "fake",
          session_file: str | None = None) -> Path:
    log = tmp_path / f"{session_id}.jsonl"
    log.write_text("{}\n", encoding="utf-8")
    app._live_scans[(str(tmp_path), session_id)] = {
        "vendor": vendor, "session_id": session_id,
        "session_file": str(log) if session_file is None else session_file,
        "identity": "", "size": -1, "mtime": -1.0, "cursor": {},
        "totals": {"input": 0, "output": 0, "calls": 0}, "panes": {pane_id},
    }
    return log


async def _call(**payload: Any) -> dict[str, Any]:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    await app.handle_message(session, {"id": "m1", "type": "tokens.turns", "payload": payload})
    return session.websocket.sent[-1]  # type: ignore[attr-defined]


async def test_a_pane_resolves_to_its_live_session_and_the_reply_follows_the_contract(
    reader: _Reader, tmp_path: Path,
) -> None:
    log = _bind(tmp_path, "pane-a", "sess-1")
    frame = await _call(pane_id="pane-a", include_calls=True)
    assert frame["type"] == "tokens.turns.result"
    reply = frame["payload"]
    assert reply["ok"] is True
    assert reply["pane_id"] == "pane-a"
    assert reply["session_id"] == "sess-1"
    assert reply["vendor"] == "fake"
    assert reply["file_path"] == str(log)
    assert reply["method"] == "exact"
    assert reply["turns"] == [{
        "turn_index": 1, "started_at": "2026-09-16T00:00:00Z", "ended_at": "2026-09-16T00:00:03Z",
        "prompt_excerpt": "hello", "input": 1, "cache_read": 20, "cache_creation": 3, "output": 4,
        "total": 28, "calls": 1, "profile_id": "unknown", "cli_version": "",
        "calls_detail": [{"ts": "2026-09-16T00:00:01Z", "model": "m", "input": 1,
                          "cache_read": 20, "cache_creation": 3, "output": 4,
                          "cli_version": ""}],
    }]
    assert reply["accounts"] == ["unknown"]
    assert reply["totals"] == {
        "input": 1, "cache_read": 20, "cache_creation": 3, "output": 4, "total": 28, "calls": 1,
    }
    assert reply["scanned_at"].endswith("Z")
    # The parse ran on the dedicated live-scan worker, not the shared pool.
    assert reader.threads and all(t.startswith("tokens-live-scan") for t in reader.threads)


async def test_calls_detail_is_opt_in(reader: _Reader, tmp_path: Path) -> None:
    _bind(tmp_path, "pane-a", "sess-1")
    reply = (await _call(pane_id="pane-a"))["payload"]
    assert "calls_detail" not in reply["turns"][0]


async def test_a_bare_session_id_is_found_in_the_registry_too(reader: _Reader, tmp_path: Path) -> None:
    _bind(tmp_path, "pane-a", "sess-1")
    reply = (await _call(session_id="sess-1"))["payload"]
    assert reply["ok"] is True
    assert "pane_id" not in reply
    assert reply["vendor"] == "fake"


async def test_an_unknown_pane_is_no_session(reader: _Reader) -> None:
    assert (await _call(pane_id="nope"))["payload"] == {"ok": False, "error": "no-session"}
    assert (await _call())["payload"] == {"ok": False, "error": "no-session"}
    # A bare id nobody tracks, with no agent_key to pick a reader by: there is
    # no session to read, which is not an unknown vendor named "".
    assert (await _call(session_id="sess-9"))["payload"] == {"ok": False, "error": "no-session"}


async def test_a_session_outside_the_registry_needs_a_known_vendor(reader: _Reader) -> None:
    reply = (await _call(session_id="sess-9", agent_key="nobody"))["payload"]
    assert reply["ok"] is False and reply["error"] == "unknown-vendor"
    # Known vendor, but the reader cannot find the log.
    reply = (await _call(session_id="sess-9", agent_key="fake"))["payload"]
    assert reply["ok"] is False and reply["error"] == "file-missing"


async def test_a_bound_pane_whose_log_is_gone_is_file_missing(reader: _Reader, tmp_path: Path) -> None:
    log = _bind(tmp_path, "pane-a", "sess-1")
    log.unlink()
    reply = (await _call(pane_id="pane-a"))["payload"]
    assert reply["ok"] is False and reply["error"] == "file-missing"


async def test_an_unsupported_vendor_is_ok_with_no_turns(reader: _Reader, tmp_path: Path) -> None:
    reader.turns_method = "unsupported"
    _bind(tmp_path, "pane-a", "sess-1")
    reply = (await _call(pane_id="pane-a"))["payload"]
    assert reply["ok"] is True
    assert reply["method"] == "unsupported"
    assert reply["turns"] == []
    assert reply["totals"]["total"] == 0 and reply["totals"]["calls"] == 0


async def test_a_reader_crash_is_scan_failed(reader: _Reader, tmp_path: Path, monkeypatch) -> None:
    _bind(tmp_path, "pane-a", "sess-1")

    def boom(path: Path, session_id: str = "") -> list[TurnUsage]:
        raise RuntimeError("corrupt")

    monkeypatch.setattr(reader, "turns_for_session", boom)
    reply = (await _call(pane_id="pane-a"))["payload"]
    assert reply == {"ok": False, "error": "scan-failed", "detail": "corrupt"}
