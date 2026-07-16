from __future__ import annotations

from typing import Any, AsyncIterator

import pytest

from agent_team_backend import app
from agent_team_backend import ai_chat_service


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeSettingsStore:
    """Stands in for app.ai_chat_settings_store with a fixed settings dict."""

    def __init__(self, settings: dict[str, Any]) -> None:
        self._settings = settings

    def get(self) -> dict[str, Any]:
        return dict(self._settings)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


def _fake_stream_chat(captured: list[dict[str, Any]], chunks: list[str]):
    async def fake_stream_chat(
        *,
        settings: dict,
        messages: list[dict],
        system: str,
        max_tokens: int,
        tools: list[dict] | None = None,
    ) -> AsyncIterator[str]:
        captured.append({
            "settings": settings,
            "messages": messages,
            "system": system,
            "max_tokens": max_tokens,
        })
        for chunk in chunks:
            yield chunk
        yield "\x00DONE:{}"

    return fake_stream_chat


@pytest.mark.asyncio
async def test_enhance_prompt_happy_path_returns_ok(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Regression: the handler used to read the nonexistent session.settings,
    raising AttributeError on every call, so ok was always False."""
    captured: list[dict[str, Any]] = []
    monkeypatch.setattr(
        ai_chat_service, "stream_chat",
        _fake_stream_chat(captured, ["Enhanced ", "prompt text"]),
    )
    monkeypatch.setattr(
        app, "ai_chat_settings_store",
        FakeSettingsStore({"provider": "ollama", "model": "test-model"}),
    )
    session = _session()

    await app.handle_message(session, {
        "id": "ep-1",
        "type": "ai.enhance_prompt",
        "payload": {"prompt": "make this better", "system": "You enhance prompts."},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["type"] == "ai.enhance_prompt.result"
    assert response["ok"] is True
    assert response["payload"] == {"ok": True, "content": "Enhanced prompt text"}
    assert captured[0]["messages"] == [{"role": "user", "content": "make this better"}]
    assert captured[0]["system"] == "You enhance prompts."


@pytest.mark.asyncio
async def test_enhance_prompt_settings_come_from_ai_chat_settings_store(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The LLM call must be configured from ai_chat_settings_store, not from
    any per-session attribute — changing the store changes what stream_chat
    receives."""
    captured: list[dict[str, Any]] = []
    monkeypatch.setattr(
        ai_chat_service, "stream_chat",
        _fake_stream_chat(captured, ["ok"]),
    )
    monkeypatch.setattr(
        app, "ai_chat_settings_store",
        FakeSettingsStore({
            "provider": "anthropic",
            "model": "store-model-marker",
            "anthropic_api_key": "store-key-marker",
        }),
    )
    session = _session()

    await app.handle_message(session, {
        "id": "ep-2",
        "type": "ai.enhance_prompt",
        "payload": {"prompt": "hello"},
    })

    response = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert response["payload"]["ok"] is True
    assert captured[0]["settings"]["provider"] == "anthropic"
    assert captured[0]["settings"]["model"] == "store-model-marker"
    assert captured[0]["settings"]["anthropic_api_key"] == "store-key-marker"
