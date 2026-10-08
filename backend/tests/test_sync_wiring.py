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
