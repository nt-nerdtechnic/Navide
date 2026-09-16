"""terminal.input feedback: pending bytes in the ack, blocked/unblocked events.

The ack used to be a bare {ok: true} whether or not the kernel had accepted
the bytes, so the renderer could only infer delivery from echo — and when the
CLI was not reading its stdin it re-pasted the whole message up to three times
into the same _in_buffers. These tests pin the backend half of the fix:
write() reports what is still pending, an episode that stays blocked past
_INPUT_BLOCK_NOTIFY_MS is announced to the owning window and its release is
announced with duration and drained bytes, a short blip stays silent, and a
close during an announced episode still releases it.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from types import SimpleNamespace

import pytest

from agent_team_backend import app as app_module
from agent_team_backend.terminals import _INPUT_BLOCK_NOTIFY_MS, TerminalService


class _BlockableHandle:
    """A PTY master whose kernel buffer is "full" while `blocked` is set."""

    def __init__(self) -> None:
        self.blocked = False
        self.written = bytearray()
        self.watching = False

    def write(self, data: bytes) -> int:
        if self.blocked:
            raise BlockingIOError
        self.written.extend(data)
        return len(data)

    def watch_writable(self, loop, callback) -> None:
        self.watching = True

    def unwatch_writable(self) -> None:
        self.watching = False

    def pause_reading(self) -> None:
        pass

    def resume_reading(self) -> None:
        pass

    def stop_reading(self) -> None:
        pass

    def close(self) -> None:
        pass


def _make() -> tuple[TerminalService, SimpleNamespace, _BlockableHandle, list]:
    events: list = []

    async def emit(event) -> None:
        events.append(event)

    svc = TerminalService(emit)
    handle = _BlockableHandle()
    session = SimpleNamespace(
        id="t-in",
        handle=handle,
        closed=False,
        pane_id="pane-1",
        sequence=0,
        output_log_fp=None,
        agent_key="claude",
    )
    svc._sessions[session.id] = session
    return svc, session, handle, events


def _types(events: list) -> list[str]:
    return [e["type"] for e in events]


@pytest.mark.asyncio
async def test_write_reports_pending_bytes_until_the_writer_callback_drains():
    svc, session, handle, _events = _make()
    handle.blocked = True
    assert svc.write(session.id, "hello") == 5
    assert handle.watching

    handle.blocked = False
    svc._on_writable(session)  # the add_writer callback
    assert len(svc._in_buffers[session.id]) == 0
    assert bytes(handle.written) == b"hello"
    assert not handle.watching
    assert svc.write(session.id, "!") == 0
    svc._end_input_block(session)


@pytest.mark.asyncio
async def test_long_block_announces_once_and_release_reports_duration_and_drained(caplog):
    svc, session, handle, events = _make()
    handle.blocked = True
    with caplog.at_level(logging.WARNING):
        svc.write(session.id, "x" * 700)
        svc.write(session.id, "y" * 79)  # a retry appends, never re-announces
        await asyncio.sleep(_INPUT_BLOCK_NOTIFY_MS / 1000 + 0.15)
        assert _types(events) == ["terminal.input_blocked"]
        blocked = events[0]["payload"]
        assert blocked["session_id"] == session.id
        assert blocked["terminal_session_id"] == session.id
        assert blocked["pending"] == 779

        handle.blocked = False
        svc._on_writable(session)
        await asyncio.sleep(0)
        assert _types(events) == ["terminal.input_blocked", "terminal.input_unblocked"]
        released = events[1]["payload"]
        assert released["session_id"] == session.id
        assert released["duration_ms"] >= _INPUT_BLOCK_NOTIFY_MS
        assert released["drained"] == 779
        assert "pty input unblocked session=t-in agent=claude after=" in caplog.text
        assert "drained=779 bytes" in caplog.text
    assert session.id not in svc._input_blocked


@pytest.mark.asyncio
async def test_short_blip_stays_silent(caplog):
    svc, session, handle, events = _make()
    handle.blocked = True
    with caplog.at_level(logging.WARNING):
        svc.write(session.id, "abc")
        await asyncio.sleep(0.1)
        handle.blocked = False
        svc._on_writable(session)
        await asyncio.sleep(_INPUT_BLOCK_NOTIFY_MS / 1000 + 0.1)
    assert events == []
    assert "pty input unblocked" not in caplog.text
    assert session.id not in svc._input_blocked


@pytest.mark.asyncio
async def test_close_during_an_announced_episode_releases_it_with_partial_drain():
    """A kill after the PTY took part of the backlog reports those bytes,
    not 0 — the CLI did read them."""
    events: list = []

    async def emit(event) -> None:
        events.append(event)

    svc = TerminalService(emit)
    session = svc.create(pane_id="p1", agent_key=None, command=["sleep", "30"], cwd="/")
    try:
        budget = 0  # bytes the fake PTY will still accept

        def _partial(data: bytes) -> int:
            nonlocal budget
            if budget <= 0:
                raise BlockingIOError
            n = min(budget, len(data))
            budget -= n
            return n

        session.handle.write = _partial  # type: ignore[method-assign]
        svc.write(session.id, "stuck!")
        await asyncio.sleep(_INPUT_BLOCK_NOTIFY_MS / 1000 + 0.15)
        assert _types(events) == ["terminal.input_blocked"]
        block = svc._input_blocked[session.id]
        assert block.timer is None

        budget = 4  # the PTY takes part of the backlog, then blocks again
        svc._on_writable(session)
        assert len(svc._in_buffers[session.id]) == 2

        svc._close(session, reason="killed")
        await asyncio.sleep(0)
        assert _types(events) == [
            "terminal.input_blocked",
            "terminal.input_unblocked",
            "terminal.exit",
        ]
        assert events[1]["payload"]["drained"] == 4
        assert session.id not in svc._input_blocked
    finally:
        try:
            session.proc.kill()
        except Exception:  # noqa: BLE001
            pass


@pytest.mark.asyncio
async def test_write_error_during_an_announced_episode_reports_what_was_accepted(caplog):
    svc, session, handle, events = _make()
    handle.blocked = True
    svc.write(session.id, "x" * 30)
    await asyncio.sleep(_INPUT_BLOCK_NOTIFY_MS / 1000 + 0.15)
    assert _types(events) == ["terminal.input_blocked"]

    # The PTY takes 10 bytes, then the fd dies under the rest.
    calls = 0

    def _accept_then_die(data: bytes) -> int:
        nonlocal calls
        calls += 1
        if calls == 1:
            return 10
        raise OSError("gone")

    handle.write = _accept_then_die  # type: ignore[method-assign]
    with caplog.at_level(logging.WARNING):
        svc._on_writable(session)
    await asyncio.sleep(0)
    assert _types(events) == ["terminal.input_blocked", "terminal.input_unblocked"]
    assert events[1]["payload"]["drained"] == 10
    assert "drained=10 bytes" in caplog.text
    assert session.id not in svc._input_blocked
    assert len(svc._in_buffers[session.id]) == 0


# ── ws terminal.input ack ─────────────────────────────────────────────


class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


class _FakeTerminals:
    def __init__(self, pending: int) -> None:
        self.pending = pending

    def write(self, session_id: str, data: str) -> int:
        return self.pending

    def get(self, session_id: str):
        return None


@pytest.mark.asyncio
async def test_terminal_input_ack_carries_pending():
    session = app_module.Session(_FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = _FakeTerminals(pending=42)  # type: ignore[assignment]
    msg_id = str(uuid.uuid4())
    await app_module.handle_message(
        session,
        {"id": msg_id, "type": "terminal.input", "payload": {"terminal_session_id": "t", "data": "hi"}},
    )
    frames = [f for f in session.websocket.sent if f.get("id") == msg_id]  # type: ignore[attr-defined]
    assert frames[-1]["ok"] is True
    assert frames[-1]["payload"] == {"ok": True, "pending": 42}


@pytest.mark.asyncio
async def test_empty_write_is_a_pure_probe_of_pending():
    svc, session, handle, events = _make()
    assert svc.write(session.id, "") == 0
    assert session.id not in svc._echo_probe
    assert session.id not in svc._in_buffers
    assert not handle.watching

    handle.blocked = True
    bulk = "x" * 20  # bulk-sized so the write itself arms no echo probe
    assert svc.write(session.id, bulk) == 20
    assert svc.write(session.id, "") == 20
    assert svc.write(session.id, "") == 20
    assert svc._in_buffers[session.id] == bulk.encode()
    assert session.id not in svc._echo_probe
    svc._end_input_block(session)


@pytest.mark.asyncio
async def test_empty_terminal_input_skips_the_human_heartbeat(monkeypatch):
    calls: list = []
    monkeypatch.setattr(
        app_module.dev_time_store, "human_input", lambda *a: calls.append(a) or False
    )
    session = app_module.Session(_FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = _FakeTerminals(pending=7)  # type: ignore[assignment]
    session.terminals.get = lambda _sid: SimpleNamespace(  # type: ignore[method-assign]
        metadata={"workspace_path": "/ws"}, cwd="/ws", pane_id="pane-1"
    )
    msg_id = str(uuid.uuid4())
    await app_module.handle_message(
        session,
        {
            "id": msg_id,
            "type": "terminal.input",
            "payload": {"terminal_session_id": "t", "data": "", "human": True},
        },
    )
    frames = [f for f in session.websocket.sent if f.get("id") == msg_id]  # type: ignore[attr-defined]
    assert frames[-1]["payload"] == {"ok": True, "pending": 7}
    assert calls == []
