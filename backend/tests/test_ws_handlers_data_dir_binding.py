"""Handlers that offload data-dir work to a thread bind the dir up front.

The job runs on a worker thread after the handler has returned control to
the loop; resolving app_data_dir() only then would pick whatever the process
points at by that time. Each probe below moves AGENT_TEAM_DATA_DIR before it
reads the dir — standing in for the move landing while the job is queued —
and must still see the dir the request was dispatched under.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

from agent_team_backend import app as app_mod
from agent_team_backend import onboarding_deps, pty_registry
from agent_team_backend.applog import app_data_dir


class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


async def _send(type_: str, payload: dict) -> dict:
    session = app_mod.Session(_FakeWebSocket())  # type: ignore[arg-type]
    await app_mod.handle_message(session, {"id": "m1", "type": type_, "payload": payload})
    return session.websocket.sent[-1]


@pytest.fixture()
def dirs(tmp_path, monkeypatch):
    first = tmp_path / "first"
    second = tmp_path / "second"
    monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(first))
    seen: list[Path] = []

    def probe(result: Any):
        def run(*_args: Any, **_kwargs: Any) -> Any:
            monkeypatch.setenv("AGENT_TEAM_DATA_DIR", str(second))
            seen.append(app_data_dir())
            return result

        return run

    return first, seen, probe


@pytest.mark.asyncio
async def test_orphan_scan_runs_under_the_dispatch_data_dir(dirs, monkeypatch):
    first, seen, probe = dirs
    monkeypatch.setattr(pty_registry, "scan_orphans", probe([]))
    reply = await _send("agent.orphan_scan", {})
    assert reply["payload"]["count"] == 0
    assert seen == [first]


@pytest.mark.asyncio
async def test_reap_orphans_runs_under_the_dispatch_data_dir(dirs, monkeypatch):
    first, seen, probe = dirs
    monkeypatch.setattr(pty_registry, "reap_stale", probe([]))
    reply = await _send("agent.reap_orphans", {})
    assert reply["payload"]["count"] == 0
    assert seen == [first]


@pytest.mark.asyncio
async def test_onboarding_status_runs_under_the_dispatch_data_dir(dirs, monkeypatch):
    first, seen, probe = dirs
    monkeypatch.setattr(onboarding_deps, "get_status", probe({}))
    monkeypatch.setattr(onboarding_deps, "is_complete", lambda: True)
    reply = await _send("onboarding.status", {})
    assert reply["payload"]["complete"] is True
    assert seen == [first]


@pytest.mark.asyncio
async def test_onboarding_run_resolves_under_the_dispatch_data_dir(dirs, monkeypatch):
    first, seen, probe = dirs
    monkeypatch.setattr(onboarding_deps, "resolve_run", probe({"ok": False}))
    reply = await _send("onboarding.run", {"kind": "install", "dep_id": "x"})
    assert reply["payload"]["ok"] is False
    assert seen == [first]
