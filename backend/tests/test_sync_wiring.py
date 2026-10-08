"""How sync rounds reach the renderer and how local saves reach sync.

The engine's own behaviour is in ``test_sync_engine_core``; these pin the
seams around it: the ``sync.result`` event, ``sync.status``, the account
switch, and the debounced round after a local save.
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from agent_team_backend import app, server_link


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


# ── sync.result / sync.status ────────────────────────────────────────────────
async def test_the_links_engine_broadcasts_every_result(monkeypatch):
    sent: list[dict[str, Any]] = []

    async def broadcast(event, exclude=None):
        sent.append(event)

    monkeypatch.setattr(app, "broadcast", broadcast)
    link = server_link.ServerLink()
    engine = link.sync_engine()
    engine._enabled = lambda _s: False
    result = await engine.sync("prompts")
    await asyncio.sleep(0)
    await asyncio.sleep(0)
    events = [e for e in sent if e.get("type") == "sync.result"]
    assert [e["payload"] for e in events] == [result]


async def test_sync_status_carries_the_last_results_and_the_account(monkeypatch):
    last = {"prompts": {"scope": "prompts", "ok": True}}
    monkeypatch.setattr(server_link, "sync_last_results", lambda: last)

    async def status():
        return {"state": "connected", "accountEmail": "me@example.com", "memberId": "m-1"}

    monkeypatch.setattr(server_link, "status", status)
    session = _session()
    await app.handle_message(session, {"id": "s1", "type": "sync.status", "payload": {}})
    payload = session.websocket.sent[0]["payload"]  # type: ignore[attr-defined]
    assert payload["last"] == last
    assert payload["account"] == {"email": "me@example.com", "memberId": "m-1"}


def test_no_link_means_no_last_results(monkeypatch):
    monkeypatch.setattr(server_link, "_link", None)
    assert server_link.sync_last_results() == {}


# ── ACC: switching accounts ──────────────────────────────────────────────────
class _Settings:
    def __init__(self, values: dict) -> None:
        self.values = values

    def get(self) -> dict:
        return dict(self.values)

    def set(self, updates: dict) -> dict:
        self.values.update(updates)
        return updates


def test_an_account_change_forgets_every_scope_and_switches_them_all_off(tmp_path, monkeypatch):
    from agent_team_backend import sync_engine, sync_scopes
    from agent_team_backend.db import Database

    store = sync_engine.SyncStore(Database(tmp_path / "s.db"))
    for scope in ("prompts", "mcp", "skills", "memory", "skill-files"):
        store.set_state(scope, "i", rev=3, synced_hash="h", deleted=False)
        store.set_cursor(scope, 3)
    store.record_conflict("prompts", "c", local={"a": 1}, remote=None, remote_rev=4, remote_device="d")
    settings = _Settings({sync_scopes.SCOPES_SETTING: {s: True for s in sync_engine.SCOPES}})
    monkeypatch.setattr(sync_scopes, "_settings", lambda: settings)
    monkeypatch.setattr(app, "sync_store", store)

    sync_scopes.on_account_changed()

    for scope in ("prompts", "mcp", "skills", "memory", "skill-files"):
        assert store.states(scope) == {} and store.cursor(scope) == 0
    assert store.conflicts(None) == []
    assert not any(sync_scopes.enabled_scopes().values())


async def test_an_account_change_while_the_app_was_closed_is_still_noticed(monkeypatch):
    from agent_team_backend import sync_scopes

    calls: list[str] = []
    monkeypatch.setattr(sync_scopes, "on_account_changed", lambda: calls.append("cleared"))
    settings = _Settings({server_link.SYNC_ACCOUNT_SETTING: "ns-a"})
    monkeypatch.setattr(server_link, "_settings_store", lambda: settings)
    # A fresh process: nothing settled in memory yet.
    monkeypatch.setattr(server_link, "_settled_account", server_link._UNREAD)
    await server_link._note_account("ns-b")
    assert calls == ["cleared"]
    assert settings.values[server_link.SYNC_ACCOUNT_SETTING] == "ns-b"
    # Restart again as the same account: nothing to clear.
    monkeypatch.setattr(server_link, "_settled_account", server_link._UNREAD)
    await server_link._note_account("ns-b")
    assert calls == ["cleared"]


async def test_a_first_sign_in_on_a_fresh_install_clears_nothing(monkeypatch):
    from agent_team_backend import sync_scopes

    calls: list[str] = []
    monkeypatch.setattr(sync_scopes, "on_account_changed", lambda: calls.append("cleared"))
    settings = _Settings({})
    monkeypatch.setattr(server_link, "_settings_store", lambda: settings)
    monkeypatch.setattr(server_link, "_settled_account", server_link._UNREAD)
    await server_link._note_account("ns-a")
    assert calls == []


# ── local saves start a round ────────────────────────────────────────────────
class _Linked:
    _authenticated = True


@pytest.fixture
def rounds(monkeypatch):
    """Record the rounds sync_soon starts; scopes on, link up, no delay."""
    from agent_team_backend import sync_scopes

    started: list[str] = []

    async def sync_now(scope=""):
        started.append(scope)
        return []

    monkeypatch.setattr(server_link, "sync_now", sync_now)
    monkeypatch.setattr(server_link, "SYNC_SOON_DELAY_S", 0.01)
    monkeypatch.setattr(server_link, "_link", _Linked())
    monkeypatch.setattr(sync_scopes, "scope_enabled", lambda _s: True)
    return started


async def _settle() -> None:
    await asyncio.sleep(0.05)


async def test_saves_in_quick_succession_start_one_round(rounds):
    for _ in range(3):
        server_link.sync_soon("prompts")
    await _settle()
    assert rounds == ["prompts"]


async def test_a_save_to_a_scope_that_is_off_starts_nothing(rounds, monkeypatch):
    from agent_team_backend import sync_scopes

    monkeypatch.setattr(sync_scopes, "scope_enabled", lambda _s: False)
    server_link.sync_soon("prompts")
    await _settle()
    assert rounds == []


async def test_a_save_while_not_connected_starts_nothing(rounds, monkeypatch):
    monkeypatch.setattr(server_link, "_link", None)
    server_link.sync_soon("mcp")
    await _settle()
    assert rounds == []


async def test_saving_the_prompt_list_starts_a_prompts_round(rounds, monkeypatch):
    from agent_team_backend import sync_scopes

    monkeypatch.setattr(app.ui_settings_store, "set", lambda updates: dict(updates))

    async def broadcast(event, exclude=None):
        return None

    monkeypatch.setattr(app, "broadcast", broadcast)
    session = _session()
    await app.handle_message(session, {
        "id": "u1", "type": "ui.settings.set",
        "payload": {"updates": {sync_scopes.PROMPT_SKILLS_KEY: []}},
    })
    await app.handle_message(session, {
        "id": "u2", "type": "ui.settings.set", "payload": {"updates": {"theme": "dark"}},
    })
    await _settle()
    assert rounds == ["prompts"]


async def test_saving_a_memory_file_starts_a_memory_round(rounds, monkeypatch):
    from agent_team_backend import native_memory

    monkeypatch.setattr(native_memory, "save", lambda *a, **k: {"ok": True})
    session = _session()
    await app.handle_message(session, {
        "id": "m1", "type": "memory.save", "payload": {"path": "/x/CLAUDE.md", "text": "hi"},
    })
    await _settle()
    assert rounds == ["memory"]


async def test_a_skill_change_starts_a_skills_round(rounds, monkeypatch):
    from agent_team_backend import ws_handlers

    async def notify(name, change):
        return None

    monkeypatch.setattr(ws_handlers, "notify_skills_changed", notify)
    await ws_handlers._run_skill_operation(
        _session(), "k1", "skills.set_enabled", lambda: {"ok": True}, name="s"
    )
    await _settle()
    assert rounds == ["skills"]


async def test_saving_mcp_servers_starts_an_mcp_round(rounds, monkeypatch):
    class Store:
        path = "/nowhere/mcp.json"
        revision = 1

        def replace_servers(self, servers, expected_revision=None):
            return servers

    class Manager:
        async def reload(self, path):
            return None

    monkeypatch.setattr(app, "mcp_settings_store", Store())
    monkeypatch.setattr(app, "mcp_manager", Manager())
    session = _session()
    await app.handle_message(session, {
        "id": "c1", "type": "mcp.save_servers", "payload": {"servers": []},
    })
    assert session.websocket.sent[0]["payload"].get("ok") is True, session.websocket.sent  # type: ignore[attr-defined]
    await _settle()
    assert rounds == ["mcp"]
