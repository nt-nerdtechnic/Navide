"""Per-pane mute (is_muted): the renderer stops a pane's desktop notification and
sound; the flag lives on PaneRecord so a restart keeps the pane quiet.

Same shape as is_minimized: one bool on the record, one store setter, one WS
handler. Independent of is_minimized — a muted pane can be on screen and a
minimized one can still chime.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend.projects import PaneRecord, ProjectStore


@pytest.fixture
def store_ws(tmp_path: Path) -> tuple[ProjectStore, str]:
    return ProjectStore(), str(tmp_path)


def test_is_muted_defaults_false() -> None:
    assert PaneRecord(pane_id="x").is_muted is False


def test_set_pane_muted_round_trips(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude")
    store.set_pane_muted(ws, pane_id="p1", is_muted=True)
    assert ProjectStore().peek(ws).panes[0].is_muted is True
    store.set_pane_muted(ws, pane_id="p1", is_muted=False)
    assert ProjectStore().peek(ws).panes[0].is_muted is False


def test_set_pane_muted_unknown_pane_is_a_noop(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude")
    store.set_pane_muted(ws, pane_id="ghost", is_muted=True)
    assert [p.is_muted for p in ProjectStore().peek(ws).panes] == [False]


def test_mute_and_minimize_are_independent(store_ws: tuple[ProjectStore, str]) -> None:
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude")
    store.set_pane_muted(ws, pane_id="p1", is_muted=True)
    pane = ProjectStore().peek(ws).panes[0]
    assert pane.is_muted is True
    assert pane.is_minimized is False


def test_records_written_before_the_field_load_unmuted(store_ws: tuple[ProjectStore, str]) -> None:
    """A project.json from a build without is_muted must load, unmuted."""
    store, ws = store_ws
    store.record_manual_pane_spawn(ws, pane_id="p1", agent="claude")
    project = store.load_or_create(ws)
    raw = project.to_dict()
    del raw["panes"][0]["is_muted"]
    loaded = type(project).from_dict(raw)
    assert loaded.panes[0].is_muted is False


# ── WS handler ───────────────────────────────────────────────────────────────


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> "app.Session":
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_handler_persists_and_acks(tmp_path: Path) -> None:
    ws = str(tmp_path)
    await app.handle_message(_session(), {
        "id": "m0",
        "type": "manual_pane.spawn",
        "payload": {"workspace_path": ws, "pane_id": "P1", "agent": "claude", "command": "claude"},
    })
    session = _session()
    await app.handle_message(session, {
        "id": "m1",
        "type": "project.set_pane_muted",
        "payload": {"workspace_path": ws, "pane_id": "P1", "is_muted": True},
    })
    reply = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert reply["ok"] is True
    assert ProjectStore().peek(ws).panes[0].is_muted is True


@pytest.mark.asyncio
async def test_handler_ignores_an_empty_address(tmp_path: Path) -> None:
    session = _session()
    await app.handle_message(session, {
        "id": "m1",
        "type": "project.set_pane_muted",
        "payload": {"workspace_path": "", "pane_id": "", "is_muted": True},
    })
    reply = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert reply["ok"] is True
