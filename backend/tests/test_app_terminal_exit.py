from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend.ipc import make_event


class FakeAttribution:
    def __init__(self) -> None:
        self.unregistered: list[str] = []

    def unregister_pane(self, pane_id: str) -> None:
        self.unregistered.append(pane_id)


def _exit_event(pane_id: str = "p1", exit_code: int | None = 127) -> dict[str, Any]:
    return make_event("terminal.exit", {
        "terminal_session_id": "t1",
        "pane_id": pane_id,
        "reason": "exit",
        "exit_code": exit_code,
    })


@pytest.mark.asyncio
async def test_active_emit_terminal_exit_unregisters_attribution_pane(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An autonomous PTY exit must release the attribution registration
    (regression: only terminal.kill unregistered, so a CLI that died on its
    own leaked its session marker in _unbound_markers forever)."""
    fake_attr = FakeAttribution()
    monkeypatch.setattr(app, "attribution", fake_attr)

    # No entry in _PTY_OWNERS: cleanup must run even for a detached pane.
    await app._active_emit(_exit_event())

    assert fake_attr.unregistered == ["p1"]


@pytest.mark.asyncio
async def test_active_emit_non_exit_event_does_not_unregister(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_attr = FakeAttribution()
    monkeypatch.setattr(app, "attribution", fake_attr)

    await app._active_emit(make_event("terminal.output", {
        "terminal_session_id": "t1",
        "pane_id": "p1",
        "data": "hello",
        "stream": "stdout",
    }))

    assert fake_attr.unregistered == []


@pytest.mark.asyncio
async def test_active_emit_terminal_exit_without_pane_id_is_safe(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_attr = FakeAttribution()
    monkeypatch.setattr(app, "attribution", fake_attr)

    event = _exit_event()
    event["payload"].pop("pane_id")
    await app._active_emit(event)

    assert fake_attr.unregistered == []
