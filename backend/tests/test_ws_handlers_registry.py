"""Strangler-fig registry: editor.* dispatch goes through ws_handlers."""

from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import app, ws_handlers


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


def test_registry_has_editor_handlers() -> None:
    assert ws_handlers.lookup("editor.rewrite") is not None
    assert ws_handlers.lookup("editor.complete") is not None
    assert ws_handlers.lookup("does.not.exist") is None


def test_duplicate_registration_raises() -> None:
    with pytest.raises(ValueError):
        ws_handlers.handler("editor.rewrite")(lambda *a: None)  # type: ignore[arg-type]


@pytest.mark.asyncio
async def test_editor_complete_dispatched_via_registry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_complete(*args: Any, **kwargs: Any) -> dict[str, Any]:
        return {"ok": True, "text": "COMPLETION"}

    monkeypatch.setattr(app.editor_service, "complete", fake_complete)
    session = _session()

    await app.handle_message(session, {
        "id": "c1",
        "type": "editor.complete",
        "payload": {"prefix": "a", "suffix": "b", "language": "py"},
    })

    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["type"] == "editor.complete.result"
    assert resp["payload"] == {"ok": True, "text": "COMPLETION"}


@pytest.mark.asyncio
async def test_editor_only_reachable_through_registry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The legacy elif branch is gone: if the registry does not resolve
    editor.complete, it must fall through to UNKNOWN_TYPE."""
    monkeypatch.setattr(ws_handlers, "lookup", lambda _mt: None)
    session = _session()

    await app.handle_message(session, {
        "id": "c2",
        "type": "editor.complete",
        "payload": {},
    })

    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert resp["error"]["code"] == "UNKNOWN_TYPE"
