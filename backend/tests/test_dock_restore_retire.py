"""An embedded AI panel's restore record is retired when its CLI is not wanted back.

A panel (AiCliDock) restores its CLI on the next window open while its record
is 'spawned'. Two endings must retire that record, or every window open
relaunches a CLI nobody wants:

* the user pressed Stop (terminal.kill on the panel's PTY);
* the CLI failed right at launch — typically a restore resuming a session the
  vendor no longer has — which would otherwise re-file 'spawned' and fail
  again on every open.

A CLI still running when the app quits (shutdown) and a CLI the user ended
from inside (a clean exit) keep today's behaviour, as does every window pane.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app, ws_handlers
from agent_team_backend.projects import ProjectStore

_DOCK_PANE = "ab12cd34-plans-ai-terminal"
_SESSION = "11111111-2222-3333-4444-555555555555"


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeTerminals:
    def __init__(self, sessions: list[SimpleNamespace]) -> None:
        self._sessions = {s.id: s for s in sessions}
        self.killed: list[str] = []

    async def kill(self, session_id: str, force: bool = False) -> None:
        self.killed.append(session_id)


class FakeAttribution:
    def unregister_pane(self, pane_id: str) -> None:
        return None


@pytest.fixture()
def store(monkeypatch: pytest.MonkeyPatch) -> ProjectStore:
    project_store = ProjectStore()
    monkeypatch.setattr(app, "project_store", project_store)
    monkeypatch.setattr(app, "attribution", FakeAttribution())
    return project_store


def _dock_meta(ws: str) -> dict[str, Any]:
    return {"workspace_path": ws, "surface": "plans", "window_kind": "plans", "explicit_session_id": _SESSION}


def _record_panel(store: ProjectStore, ws: str) -> None:
    store.record_manual_pane_spawn(
        ws, pane_id=_DOCK_PANE, agent="claude", session_id=_SESSION, origin="plan-window", surface="plans",
    )


def _status(store: ProjectStore, ws: str, pane_id: str = _DOCK_PANE) -> str:
    return next(p.spawn_status for p in store.load_or_create(ws).panes if p.pane_id == pane_id)


async def _kill(session: app.Session, term_id: str) -> None:
    await app.handle_message(session, {
        "id": "k1", "type": "terminal.kill", "payload": {"terminal_session_id": term_id, "force": True},
    })


def _session(terminals: FakeTerminals) -> app.Session:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = terminals  # type: ignore[assignment]
    return session


async def _exit(term_id: str, *, reason: str, exit_code: int | None, uptime_ms: int) -> None:
    await app._active_emit({
        "type": "terminal.exit",
        "payload": {
            "terminal_session_id": term_id,
            "pane_id": _DOCK_PANE,
            "reason": reason,
            "exit_code": exit_code,
            "uptime_ms": uptime_ms,
        },
    })


# ── Stop ────────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_stopping_a_panel_retires_its_restore_record(tmp_path: Path, store: ProjectStore) -> None:
    ws = str(tmp_path)
    _record_panel(store, ws)
    terminals = FakeTerminals([SimpleNamespace(id="t-dock", pane_id=_DOCK_PANE, metadata=_dock_meta(ws))])

    await _kill(_session(terminals), "t-dock")

    assert terminals.killed == ["t-dock"]
    assert _status(store, ws) == "removed"


@pytest.mark.asyncio
async def test_killing_a_window_pane_leaves_its_record_alone(tmp_path: Path, store: ProjectStore) -> None:
    ws = str(tmp_path)
    store.record_manual_pane_spawn(ws, pane_id="main-pane", agent="claude", session_id=_SESSION)
    terminals = FakeTerminals([SimpleNamespace(id="t-main", pane_id="main-pane", metadata={"workspace_path": ws})])

    await _kill(_session(terminals), "t-main")

    assert _status(store, ws, "main-pane") == "spawned"


@pytest.mark.asyncio
async def test_a_panel_kill_never_retires_a_window_panes_record_under_its_id(
    tmp_path: Path, store: ProjectStore,
) -> None:
    ws = str(tmp_path)
    store.record_manual_pane_spawn(ws, pane_id=_DOCK_PANE, agent="claude", session_id=_SESSION)
    terminals = FakeTerminals([SimpleNamespace(id="t-dock", pane_id=_DOCK_PANE, metadata=_dock_meta(ws))])

    await _kill(_session(terminals), "t-dock")

    assert _status(store, ws) == "spawned"


# ── A CLI that fails at launch ──────────────────────────────────────────────

@pytest.fixture()
def recorded_panel(tmp_path: Path, store: ProjectStore) -> str:
    ws = str(tmp_path)
    _record_panel(store, ws)
    ws_handlers._note_dock_pty("t-dock", ws, _DOCK_PANE, "plans", _SESSION)
    yield ws
    ws_handlers._DOCK_PTYS.clear()


@pytest.mark.asyncio
async def test_a_panel_cli_that_fails_at_launch_retires_its_record(
    recorded_panel: str, store: ProjectStore,
) -> None:
    await _exit("t-dock", reason="exit", exit_code=1, uptime_ms=1800)
    assert _status(store, recorded_panel) == "removed"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("reason", "exit_code", "uptime_ms"),
    [
        ("exit", 0, 1800),          # ended cleanly from inside (/exit)
        ("shutdown", -15, 1800),    # app quit: restores next launch
        ("killed", -9, 1800),       # Stop / window close have their own paths
        ("exit", 1, 10 * 60_000),   # a long-running CLI that later failed
    ],
)
async def test_other_endings_keep_the_record(
    recorded_panel: str, store: ProjectStore, reason: str, exit_code: int, uptime_ms: int,
) -> None:
    await _exit("t-dock", reason=reason, exit_code=exit_code, uptime_ms=uptime_ms)
    assert _status(store, recorded_panel) == "spawned"


@pytest.mark.asyncio
async def test_a_failed_launch_leaves_a_newer_session_record_alone(
    recorded_panel: str, store: ProjectStore,
) -> None:
    # The user started a fresh CLI in the panel before the old one's exit landed.
    store.record_manual_pane_spawn(
        recorded_panel, pane_id=_DOCK_PANE, agent="claude", session_id="99999999-2222-3333-4444-555555555555",
        origin="plan-window", surface="plans",
    )
    await _exit("t-dock", reason="exit", exit_code=1, uptime_ms=1800)
    assert _status(store, recorded_panel) == "spawned"
