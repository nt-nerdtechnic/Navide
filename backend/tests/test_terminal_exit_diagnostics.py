from __future__ import annotations

import asyncio
import os
import pty
import time
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend.terminals import TerminalService, TerminalSession


@pytest.mark.asyncio
async def test_terminal_exit_includes_lifetime_signal_and_probe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events: list[dict[str, Any]] = []

    async def emit(event: dict[str, Any]) -> None:
        events.append(event)

    monkeypatch.setattr(
        "agent_team_backend.terminals.pty_registry.unregister",
        lambda _pid: None,
    )
    service = TerminalService(emit)
    master, slave = pty.openpty()
    proc = SimpleNamespace(pid=4321, returncode=-9, poll=lambda: -9)
    session = TerminalSession(
        id="fast-exit",
        pane_id="pane-1",
        agent_key="claude",
        command=["/bin/zsh", "-lc", "claude"],
        cwd="/tmp",
        master_fd=master,
        proc=proc,  # type: ignore[arg-type]
        started_monotonic=time.monotonic() - 0.042,
        metadata={"startup_probe": {"binary_path": "/opt/bin/claude"}},
    )
    service._sessions[session.id] = session

    try:
        service._close(session, reason="exit")
        await asyncio.sleep(0)
    finally:
        os.close(slave)

    payload = events[0]["payload"]
    assert payload["exit_code"] == -9
    assert payload["signal"] == "SIGKILL"
    assert 35 <= payload["uptime_ms"] <= 250
    assert payload["startup_probe"]["binary_path"] == "/opt/bin/claude"
