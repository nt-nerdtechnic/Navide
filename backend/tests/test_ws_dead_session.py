"""Dead WebSocket sessions must be pruned, not crashed into.

Observed 2026-07-16 (backend.log): after a client disconnected with 1001,
leftover fire-and-forget handler tasks kept sending on the closed socket
(`RuntimeError: Cannot call "send" once a close message has been sent`) and
broadcast spammed warnings for the dead session forever. send_json now marks
the session dead on the first send failure and later sends are silent no-ops;
broadcast prunes dead sessions; ws() cancels in-flight handler tasks on
disconnect.
"""

from __future__ import annotations

import asyncio

import pytest
from fastapi import WebSocketDisconnect

from agent_team_backend import app as app_module

# NOTE: always reference app_module attributes at call time (not from-imports):
# test_analyzer_routing.py reloads the app module mid-suite, which rebinds
# _SESSIONS / Session / broadcast to fresh objects.


class ClosedSocket:
    """Fake websocket whose send always fails like a closed starlette socket."""

    def __init__(self) -> None:
        self.send_attempts = 0

    async def send_json(self, data: dict) -> None:
        self.send_attempts += 1
        raise RuntimeError('Cannot call "send" once a close message has been sent.')


class ScriptedSocket:
    """Fake websocket: accepts, yields queued messages, then disconnects."""

    def __init__(self, messages: list[dict]) -> None:
        self._messages = list(messages)

    async def accept(self) -> None:
        pass

    async def receive_json(self) -> dict:
        if self._messages:
            return self._messages.pop(0)
        # Yield once so tasks spawned for earlier messages get to start
        # before the disconnect unwinds the receive loop.
        await asyncio.sleep(0)
        raise WebSocketDisconnect(1001)

    async def send_json(self, data: dict) -> None:
        pass


async def test_send_json_on_closed_socket_marks_dead_without_raising() -> None:
    sock = ClosedSocket()
    session = app_module.Session(sock)  # type: ignore[arg-type]
    app_module._SESSIONS.add(session)
    try:
        await session.send_json({"type": "x"})  # must not raise
        assert session.dead is True
        assert session not in app_module._SESSIONS
        assert sock.send_attempts == 1
    finally:
        app_module._SESSIONS.discard(session)


async def test_dead_session_send_json_is_silent_noop() -> None:
    sock = ClosedSocket()
    session = app_module.Session(sock)  # type: ignore[arg-type]
    await session.send_json({"type": "x"})
    await session.send_json({"type": "y"})
    # The second call must not touch the socket at all.
    assert sock.send_attempts == 1


async def test_broadcast_prunes_dead_session() -> None:
    sock = ClosedSocket()
    session = app_module.Session(sock)  # type: ignore[arg-type]
    app_module._SESSIONS.add(session)
    try:
        await app_module.broadcast({"type": "event"})  # must not raise
        assert session.dead is True
        assert session not in app_module._SESSIONS
    finally:
        app_module._SESSIONS.discard(session)


async def test_disconnect_cancels_inflight_handler_tasks(monkeypatch) -> None:
    sessions: list[app_module.Session] = []
    handler_tasks: list[asyncio.Task] = []

    orig_session = app_module.Session

    class RecordingSession(orig_session):  # type: ignore[misc,valid-type]
        def __init__(self, websocket) -> None:
            super().__init__(websocket)
            sessions.append(self)

    async def slow_handler(session, msg) -> None:
        handler_tasks.append(asyncio.current_task())
        await asyncio.sleep(30)

    monkeypatch.setattr(app_module, "Session", RecordingSession)
    monkeypatch.setattr(app_module, "handle_message", slow_handler)

    await app_module.ws(ScriptedSocket([{"type": "anything"}]))  # type: ignore[arg-type]

    assert len(sessions) == 1
    session = sessions[0]
    assert session.dead is True
    assert session not in app_module._SESSIONS

    assert len(handler_tasks) == 1
    task = handler_tasks[0]
    with pytest.raises(asyncio.CancelledError):
        await task
    assert task.cancelled()
