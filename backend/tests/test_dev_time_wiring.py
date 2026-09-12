"""Dev-time wiring: the real event entry points must reach DevTimeStore.

test_dev_time_store.py covers the store; these tests drive the app-level
entry points (log-reader activity sink, CLI hook receiver, terminal.input,
terminal.kill) and assert on the store's state, so removing a wiring call
turns a test red.
"""

from __future__ import annotations

import uuid
from datetime import timezone
from types import SimpleNamespace
from typing import Any

import pytest
from fastapi.testclient import TestClient

from agent_team_backend import app as app_module
from agent_team_backend import hook_auth
from agent_team_backend.app import app
from agent_team_backend.db import WorkspaceDatabases
from agent_team_backend.dev_time_store import DevTimeStore
from agent_team_backend.log_readers.attribution import AttributedUsage
from agent_team_backend.log_readers.base import ActivityEvent

UTC = timezone.utc


@pytest.fixture
def ws(tmp_path):
    w = tmp_path / "ws"
    w.mkdir()
    return str(w)


@pytest.fixture
def store(monkeypatch, tmp_path):
    (tmp_path / "claude-home" / "projects").mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    fresh = DevTimeStore(WorkspaceDatabases(), tz=UTC)
    monkeypatch.setattr(app_module, "dev_time_store", fresh)
    return fresh


@pytest.fixture
def events(monkeypatch) -> list[dict]:
    captured: list[dict] = []

    async def fake_broadcast(event, **_kwargs):
        captured.append(event)

    monkeypatch.setattr(app_module, "broadcast", fake_broadcast)
    return captured


@pytest.fixture
def client() -> TestClient:
    client = TestClient(app, base_url="http://127.0.0.1")
    client.headers[hook_auth.HEADER] = hook_auth.token()
    return client


@pytest.fixture
def attributed(monkeypatch, ws):
    """Every log event and hook resolves to pane-1 in ``ws``."""
    monkeypatch.setattr(
        app_module.attribution,
        "attribute",
        lambda usage: AttributedUsage(
            usage=usage, pane_id="pane-1", workspace_path=ws, stage_id=""
        ),
    )
    monkeypatch.setattr(
        app_module.attribution, "pane_for_session", lambda _sid: ("pane-1", ws, "")
    )


def _activity(event_type: str, timestamp: str) -> ActivityEvent:
    return ActivityEvent(
        vendor="claude", event_type=event_type, cwd="/x", session_id="s-1",
        file_path="/x/s-1.jsonl", dedup_key=str(uuid.uuid4()), timestamp=timestamp,
    )


def _now_iso() -> str:
    from agent_team_backend.dev_time_store import _iso
    import time

    return _iso(time.time())


def _types(events: list[dict]) -> list[str]:
    return [e["type"] for e in events]


# ── log-reader sink ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_log_reader_agent_active_opens_and_turn_complete_closes(
    store, ws, events, attributed
):
    await app_module._on_log_activity(_activity("agent_active", _now_iso()))
    snap = store.snapshot(ws)
    assert snap["active_sources"] == ["agent"]
    assert snap["by_pane"][0]["pane_id"] == "pane-1"
    assert _types(events) == ["agent.activity", "devtime.changed"]
    assert events[1]["payload"] == {"workspace_path": ws}

    await app_module._on_log_activity(_activity("turn_complete", _now_iso()))
    assert store.snapshot(ws)["active"] is False
    assert _types(events)[-1] == "devtime.changed"


@pytest.mark.asyncio
async def test_replayed_old_log_events_do_not_touch_the_store(store, ws, events, attributed):
    await app_module._on_log_activity(_activity("agent_active", "2020-01-01T00:00:00Z"))
    assert store.snapshot(ws)["active"] is False
    assert _types(events) == ["agent.activity"]  # still broadcast for the UI, no devtime


# ── CLI hook receiver ────────────────────────────────────────────────


def test_hook_stop_closes_the_agent_interval(client, store, ws, events, attributed):
    store.beat(ws, "pane-1", "agent")
    resp = client.post(
        "/hooks/claude",
        headers={"X-Agent-Team-Event": "stop"},
        json={"session_id": "s-1", "cwd": ws},
    )
    assert resp.status_code == 200
    assert store.snapshot(ws)["active"] is False
    assert "devtime.changed" in _types(events)


def test_hook_pre_tool_use_beats(client, store, ws, events, attributed):
    resp = client.post(
        "/hooks/claude",
        headers={"X-Agent-Team-Event": "pre_tool_use"},
        json={"session_id": "s-1", "cwd": ws, "tool_name": "Read", "tool_input": {}},
    )
    assert resp.status_code == 200
    assert store.snapshot(ws)["active_sources"] == ["agent"]


@pytest.mark.parametrize("notification_type", ["permission_prompt", "idle_prompt"])
def test_hook_notification_is_not_an_agent_beat(
    client, store, ws, events, attributed, notification_type
):
    resp = client.post(
        "/hooks/claude",
        headers={"X-Agent-Team-Event": "notification"},
        json={"session_id": "s-1", "cwd": ws, "notification_type": notification_type},
    )
    assert resp.status_code == 200
    assert store.snapshot(ws)["active"] is False
    assert _types(events) == ["agent.activity"]  # the busy-state path still hears it
    # ...and it does not extend a running interval either.
    store.beat(ws, "pane-1", "agent")
    before = store._open[(store._key_ws(ws), "pane-1", "agent")].last_seen_at
    client.post(
        "/hooks/claude",
        headers={"X-Agent-Team-Event": "notification"},
        json={"session_id": "s-1", "cwd": ws, "notification_type": notification_type},
    )
    assert store._open[(store._key_ws(ws), "pane-1", "agent")].last_seen_at == before


def test_hook_still_answers_when_the_store_blows_up(
    client, store, ws, events, attributed, monkeypatch
):
    def boom(*_a: Any, **_k: Any) -> bool:
        raise RuntimeError("db on fire")

    monkeypatch.setattr(store, "agent_event", boom)
    for kind, extra in (("pre_tool_use", {"tool_name": "Read", "tool_input": {}}), ("stop", {})):
        resp = client.post(
            "/hooks/claude",
            headers={"X-Agent-Team-Event": kind},
            json={"session_id": "s-1", "cwd": ws, **extra},
        )
        assert resp.status_code == 200
    assert _types(events) == ["agent.activity", "agent.activity"]


# ── terminal.input / terminal.kill ───────────────────────────────────


class _FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict] = []

    async def send_json(self, payload: dict) -> None:
        self.sent.append(payload)


class _FakeTerminals:
    def __init__(self, sessions: dict) -> None:
        self._sessions = sessions
        self.written: list[tuple[str, str]] = []
        self.killed: list[str] = []

    def write(self, session_id: str, data: str) -> None:
        self.written.append((session_id, data))

    def get(self, session_id: str):
        return self._sessions.get(session_id)

    async def kill(self, session_id: str, force: bool = False) -> None:
        self.killed.append(session_id)


async def _call(session, msg_type: str, payload: dict) -> dict:
    msg_id = str(uuid.uuid4())
    await app_module.handle_message(session, {"id": msg_id, "type": msg_type, "payload": payload})
    frames = [f for f in session.websocket.sent if f.get("id") == msg_id]
    assert frames and frames[-1]["ok"] is True, frames
    return frames[-1]["payload"]


def _session_with_pane(ws: str):
    session = app_module.Session(_FakeWebSocket())  # type: ignore[arg-type]
    term = SimpleNamespace(
        id="tsid-1", pane_id="pane-1", cwd="/elsewhere", metadata={"workspace_path": ws}
    )
    session.terminals = _FakeTerminals({"tsid-1": term})  # type: ignore[assignment]
    return session


@pytest.mark.asyncio
async def test_terminal_input_beats_only_when_flagged_human(store, ws, events):
    session = _session_with_pane(ws)
    # Paste / injection / mouse report: written, no beat.
    await _call(session, "terminal.input", {"terminal_session_id": "tsid-1", "data": "x"})
    await _call(session, "terminal.input", {"terminal_session_id": "tsid-1", "data": "y", "human": False})
    assert session.terminals.written == [("tsid-1", "x"), ("tsid-1", "y")]
    assert store.snapshot(ws)["active"] is False
    assert events == []
    # Keyboard: beat.
    await _call(session, "terminal.input", {"terminal_session_id": "tsid-1", "data": "z", "human": True})
    snap = store.snapshot(ws)
    assert snap["active_sources"] == ["human"]
    assert snap["by_pane"][0]["pane_id"] == "pane-1"
    assert _types(events) == ["devtime.changed"]


@pytest.mark.asyncio
async def test_terminal_input_survives_a_broken_store(store, ws, events, monkeypatch, caplog):
    session = _session_with_pane(ws)

    def boom(*_a: Any, **_k: Any) -> bool:
        raise RuntimeError("db on fire")

    monkeypatch.setattr(store, "beat", boom)
    for data in "abc":
        payload = await _call(
            session, "terminal.input", {"terminal_session_id": "tsid-1", "data": data, "human": True}
        )
        assert payload == {"ok": True}
    assert [d for _, d in session.terminals.written] == ["a", "b", "c"]
    # Exactly one response frame per message: no trailing INTERNAL_ERROR frame.
    assert len(session.websocket.sent) == 3
    assert events == []


@pytest.mark.asyncio
async def test_terminal_kill_closes_the_panes_intervals(store, ws, events, monkeypatch):
    session = _session_with_pane(ws)
    monkeypatch.setattr(app_module.attribution, "unregister_pane", lambda _pid: None)
    store.beat(ws, "pane-1", "human")
    store.beat(ws, "pane-1", "agent")
    assert store.snapshot(ws)["active_sources"] == ["human", "agent"]
    await _call(session, "terminal.kill", {"terminal_session_id": "tsid-1"})
    assert session.terminals.killed == ["tsid-1"]
    assert store.snapshot(ws)["active"] is False
    assert _types(events) == ["devtime.changed"]


# ── pane alias ───────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_rebuilt_pane_accrues_under_its_current_id(monkeypatch, ws, events, tmp_path):
    from agent_team_backend import agent_messaging

    (tmp_path / "claude-home" / "projects").mkdir(parents=True)
    monkeypatch.setenv("CLAUDE_CONFIG_DIR", str(tmp_path / "claude-home"))
    monkeypatch.setattr(
        agent_messaging, "resolve_alias", lambda pid: "new-id" if pid == "old-id" else ""
    )
    # The production store resolves through agent_messaging.resolve_alias
    # ("" = no alias, keep the id as it came).
    fresh = DevTimeStore(WorkspaceDatabases(), tz=UTC, resolve_pane=agent_messaging.resolve_alias)
    monkeypatch.setattr(app_module, "dev_time_store", fresh)
    monkeypatch.setattr(
        app_module.attribution,
        "attribute",
        lambda usage: AttributedUsage(usage=usage, pane_id="old-id", workspace_path=ws, stage_id=""),
    )
    await app_module._on_log_activity(_activity("agent_active", _now_iso()))
    assert fresh.human_input(ws, "old-id") in (True, False)
    snap = fresh.snapshot(ws)
    assert [p["pane_id"] for p in snap["by_pane"]] == ["new-id"]
    # Removal by the current id closes what arrived under the old one.
    assert fresh.pane_removed("new-id") == [ws]
    assert fresh.snapshot(ws)["active"] is False
