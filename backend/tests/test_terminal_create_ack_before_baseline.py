"""terminal.create acks as soon as the PTY exists — the attribution baseline
scan runs behind it, never in front of it (issue #118).

On a large Codex session tree the scan (every rollout's header under
~/.codex/sessions and ~/.codex-panes/*/sessions) outlived the renderer's 30s
create deadline, so the pane was marked failed while Codex itself already sat
at its prompt. Codex 0.155 sends no SessionStart hook at startup either, so
nothing else could have rescued the pane.
"""

from __future__ import annotations

import asyncio
import threading
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app
from agent_team_backend.log_readers.attribution import Attribution
from agent_team_backend.log_readers.base import LogReader, TokenUsage


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeTerminals:
    def __init__(self) -> None:
        self.created: list[dict[str, Any]] = []
        self.killed: list[tuple[str, bool]] = []

    def create(self, **kwargs: Any) -> SimpleNamespace:
        self.created.append(kwargs)
        return SimpleNamespace(
            id=f"term-{len(self.created)}",
            pane_id=kwargs["pane_id"],
            command=kwargs["command"],
            proc=SimpleNamespace(pid=4321),
            closed=False,
        )

    async def kill(self, session_id: str, force: bool = False) -> None:
        self.killed.append((session_id, force))

    def find_live_by_resume_id(self, *args: Any, **kwargs: Any) -> list[Any]:
        return []


class SlowTreeCodexReader(LogReader):
    """A Codex reader whose session-tree scan takes as long as the test says."""

    vendor = "codex"

    def __init__(self) -> None:
        self.scan_started = threading.Event()
        self.scan_release = threading.Event()
        self.scans = 0

    def project_dirs(self) -> list[Path]:
        return []

    def session_files(self) -> list[Path]:
        return []

    def session_files_for_workspace(self, workspace_path: str) -> list[Path]:
        self.scans += 1
        self.scan_started.set()
        self.scan_release.wait(timeout=10)
        return []

    def parse_session_file(self, path: Path, seen_keys: set[str]) -> list[TokenUsage]:
        return []


class FakeCodexHomeManager:
    def __init__(self, root: Path) -> None:
        self.real_home = root / "real"
        self.root = root

    def find_session_home(self, _resume_id: str) -> Path | None:
        return None

    def prepare(self, home_id: str, *, source_home: Path | None = None) -> Path:
        return self.root / home_id


@pytest.fixture
def slow_codex_tree(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> SlowTreeCodexReader:
    async def no_path_refresh(_agent_key: str) -> None:
        pass

    reader = SlowTreeCodexReader()
    attribution = Attribution([reader], workspaces_path=tmp_path / "ws.json")
    monkeypatch.setattr(app, "_ensure_fresh_path_for_spawn", no_path_refresh)
    monkeypatch.setattr(app, "_probe_agent_cli_for_spawn", lambda *_args: None)
    monkeypatch.setattr(app, "attribution", attribution)
    monkeypatch.setattr(app, "_register_workspace_and_backfill", lambda _ws: None)
    monkeypatch.setattr(app, "codex_home_manager", FakeCodexHomeManager(tmp_path / "homes"))
    monkeypatch.setattr(
        app, "cli_profiles_store", SimpleNamespace(get_default_profile=lambda _agent_key: None),
    )
    monkeypatch.setattr(
        app.plugin_wiring,
        "apply_spawn_wiring",
        lambda _host, _agent, command, _pane_id="", _env=None, _cwd="": command,
    )
    app._PTY_OWNERS.clear()
    yield reader
    reader.scan_release.set()
    app._PTY_OWNERS.clear()


def _make_session() -> app.Session:
    session = app.Session(FakeWebSocket())  # type: ignore[arg-type]
    session.terminals = FakeTerminals()  # type: ignore[assignment]
    return session


def _create_message() -> dict[str, Any]:
    return {
        "id": "codex-create",
        "type": "terminal.create",
        "payload": {
            "pane_id": "codex-pane",
            "create_generation": "gen-1",
            "agent_key": "codex",
            "command": "codex",
            "cwd": "/ws",
            "metadata": {"workspace_path": "/ws", "session_marker": "NAVIDE-MARK-1"},
        },
    }


@pytest.mark.asyncio
async def test_codex_create_acks_while_the_baseline_scan_is_still_running(
    slow_codex_tree: SlowTreeCodexReader,
) -> None:
    reader = slow_codex_tree
    session = _make_session()

    # No SessionStart hook ever calls back (Codex 0.155 sends none at startup);
    # the only thing between the spawn and the ack is the baseline scan.
    create_task = asyncio.create_task(app.handle_message(session, _create_message()))
    assert await asyncio.to_thread(reader.scan_started.wait, 5)

    # The ack must land while the scan is still blocked — 2s stands in for
    # the renderer's 30s deadline, generously above any loop hop.
    await asyncio.wait_for(create_task, timeout=2)
    ack = session.websocket.sent[-1]  # type: ignore[attr-defined]
    assert ack["id"] == "codex-create" and ack["ok"] is True
    assert ack["payload"]["terminal_session_id"] == "term-1"
    assert not reader.scan_release.is_set(), "the scan must not have finished before the ack"
    assert session.terminals.killed == []  # type: ignore[attr-defined]

    # Registered before the ack — the pane's identity does not wait either —
    # but with its baseline still pending until the scan lands.
    reg = app.attribution._panes["codex-pane"]
    assert reg.baseline_pending is True
    assert app.attribution._unbound_markers["NAVIDE-MARK-1"] == "codex-pane"

    reader.scan_release.set()
    for _ in range(200):
        if not app.attribution._panes["codex-pane"].baseline_pending:
            break
        await asyncio.sleep(0.01)
    assert app.attribution._panes["codex-pane"].baseline_pending is False
    assert reader.scans == 1


@pytest.mark.asyncio
async def test_a_dead_socket_rolls_back_only_after_the_scan_and_leaves_no_registration(
    slow_codex_tree: SlowTreeCodexReader,
) -> None:
    """The rollback path still waits for the in-flight scan before
    unregistering, so a late scan can never revive a pane that is gone."""
    reader = slow_codex_tree
    session = _make_session()
    session.dead = True

    create_task = asyncio.create_task(app.handle_message(session, _create_message()))
    assert await asyncio.to_thread(reader.scan_started.wait, 5)
    await asyncio.sleep(0.05)
    assert not create_task.done()  # rollback is parked behind the scan

    reader.scan_release.set()
    await asyncio.wait_for(create_task, timeout=5)
    assert session.terminals.killed == [("term-1", True)]  # type: ignore[attr-defined]
    assert "codex-pane" not in app.attribution._panes
    assert "NAVIDE-MARK-1" not in app.attribution._unbound_markers
