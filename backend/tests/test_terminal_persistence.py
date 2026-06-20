from __future__ import annotations

import fcntl
import os
import pty
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend.terminals import TerminalSession


class RecordingWS:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _fake_session_entry(session: app.Session, sid: str) -> tuple[int, int]:
    master, slave = pty.openpty()
    fcntl.fcntl(master, fcntl.F_SETFL, os.O_NONBLOCK)
    entry = TerminalSession(
        id=sid,
        pane_id="p1",
        agent_key=None,
        command=["x"],
        cwd="/",
        master_fd=master,
        proc=SimpleNamespace(pid=4321, returncode=None),  # type: ignore[arg-type]
    )
    session.terminals._sessions[sid] = entry
    return master, slave


@pytest.mark.asyncio
async def test_terminals_are_app_level_shared() -> None:
    """Every Session shares the one app-level TerminalService so a PTY created
    on one connection is reachable from the next (the basis for reattach)."""
    s1 = app.Session(RecordingWS())  # type: ignore[arg-type]
    s2 = app.Session(RecordingWS())  # type: ignore[arg-type]
    assert s1.terminals is s2.terminals


@pytest.mark.asyncio
async def test_disconnect_kills_only_owned_terminals() -> None:
    """The TerminalService is an app-level singleton shared by every window, so a
    disconnecting connection must kill only the PTYs it owns — not another open
    window's agents."""
    s1 = app.Session(RecordingWS())  # type: ignore[arg-type]
    s2 = app.Session(RecordingWS())  # type: ignore[arg-type]
    m1, sl1 = _fake_session_entry(s1, "win1-pty")
    m2, sl2 = _fake_session_entry(s2, "win2-pty")
    s1.owned_terminals.add("win1-pty")
    s2.owned_terminals.add("win2-pty")
    try:
        # Window 1 disconnects: kill only its owned PTYs (the ws() finally logic).
        for tid in list(s1.owned_terminals):
            s1.terminals.kill(tid)
        # Window 1's PTY is gone; window 2's survives in the shared singleton.
        assert "win1-pty" not in s1.terminals._sessions
        assert "win2-pty" in s2.terminals._sessions
    finally:
        for fd in (m1, sl1, m2, sl2):
            try:
                os.close(fd)
            except OSError:
                pass


@pytest.mark.asyncio
async def test_reattach_reports_alive_and_dead() -> None:
    """terminal.reattach returns which persisted ids survived so the frontend
    rebinds the live one and falls back to spawn+resume for the rest."""
    ws = RecordingWS()
    session = app.Session(ws)  # type: ignore[arg-type]
    app._active_session = session
    sid = "term-alive"
    master, slave = _fake_session_entry(session, sid)
    try:
        await app.handle_message(session, {
            "id": "ra1",
            "type": "terminal.reattach",
            "payload": {
                "terminal_session_ids": [sid, "term-gone"],
                "cols": 80,
                "rows": 24,
            },
        })
    finally:
        os.close(master)
        os.close(slave)

    result = next(m for m in ws.sent if m["type"] == "terminal.reattach.result")
    assert result["payload"]["alive"] == [sid]
    assert result["payload"]["dead"] == ["term-gone"]


@pytest.mark.asyncio
async def test_reattach_marks_requester_active() -> None:
    """A reattach makes the requesting Session the output target — the surviving
    PTY's output now flows to the reconnecting renderer."""
    first = app.Session(RecordingWS())  # type: ignore[arg-type]
    app._active_session = first
    second = app.Session(RecordingWS())  # type: ignore[arg-type]
    await app.handle_message(second, {
        "id": "ra2",
        "type": "terminal.reattach",
        "payload": {"terminal_session_ids": [], "cols": 80, "rows": 24},
    })
    assert app._active_session is second
