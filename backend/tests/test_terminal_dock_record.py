"""terminal.dock_record — what an embedded AI panel resumes on restore.

A panel whose PTY did not survive (the app quit) asks for its own restore
record: the agent and session id, when the record is still 'spawned'. It is a
read: a workspace without a project must not get one written into it (the
Mini-IDE opens sub-folders), and a window pane's record is never handed out.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend.projects import ProjectStore


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


@pytest.fixture()
def store(monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    project_store = ProjectStore()
    monkeypatch.setattr(app, "project_store", project_store)
    return project_store


async def _read(ws: str, pane_id: str) -> dict[str, Any]:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    await app.handle_message(session, {
        "id": "r1", "type": "terminal.dock_record",
        "payload": {"workspace_path": ws, "pane_id": pane_id},
    })
    return session.websocket.sent[-1]["payload"]  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_returns_a_spawned_panel_record(tmp_path: Path, store: ProjectStore) -> None:
    ws = str(tmp_path)
    store.record_manual_pane_spawn(
        ws, pane_id="dock-plans", agent="claude", session_id="sess-1", origin="plan-window", surface="plans",
    )
    assert await _read(ws, "dock-plans") == {"record": {"agent": "claude", "session_id": "sess-1"}}


@pytest.mark.asyncio
async def test_a_removed_record_is_not_returned(tmp_path: Path, store: ProjectStore) -> None:
    ws = str(tmp_path)
    store.record_manual_pane_spawn(
        ws, pane_id="dock-plans", agent="claude", session_id="sess-1", origin="plan-window", surface="plans",
    )
    store.record_manual_pane_unspawn(ws, pane_id="dock-plans")
    assert await _read(ws, "dock-plans") == {"record": None}


@pytest.mark.asyncio
async def test_a_window_pane_record_is_not_returned(tmp_path: Path, store: ProjectStore) -> None:
    ws = str(tmp_path)
    store.record_manual_pane_spawn(ws, pane_id="main-pane", agent="claude", session_id="sess-1")
    assert await _read(ws, "main-pane") == {"record": None}


@pytest.mark.asyncio
async def test_reading_never_creates_a_project(tmp_path: Path, store: ProjectStore) -> None:
    ws = tmp_path / "sub"
    ws.mkdir()
    assert await _read(str(ws), "dock-editor") == {"record": None}
    assert list(ws.iterdir()) == []
