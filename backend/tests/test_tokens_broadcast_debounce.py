"""tokens.changed broadcasts must coalesce per workspace.

A startup rescan of historical CLI logs emits thousands of token events in a
burst; broadcasting a snapshot per event starved the event loop and timed out
concurrent requests (real case: terminal.create timeouts during session
restore, 2026-07-14). These tests lock the debounce behaviour of
_schedule_tokens_broadcast.
"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from agent_team_backend import app


@pytest.fixture(autouse=True)
def _fast_debounce(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(app, "_TOKENS_BROADCAST_DEBOUNCE_SEC", 0.01)
    app._pending_tokens_broadcast.clear()
    yield
    app._pending_tokens_broadcast.clear()


@pytest.mark.asyncio
async def test_burst_coalesces_to_one_broadcast(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app.tokens_store, "snapshot", lambda ws: {"ws": ws})
    with patch.object(app, "broadcast", new_callable=AsyncMock) as mock_broadcast:
        for _ in range(50):
            app._schedule_tokens_broadcast("/ws/a")
        await asyncio.sleep(0.05)
        mock_broadcast.assert_called_once()
        event = mock_broadcast.call_args.args[0]
        assert event["type"] == "tokens.changed"
        assert event["payload"] == {"ws": "/ws/a"}


@pytest.mark.asyncio
async def test_workspaces_debounce_independently(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app.tokens_store, "snapshot", lambda ws: {"ws": ws})
    with patch.object(app, "broadcast", new_callable=AsyncMock) as mock_broadcast:
        app._schedule_tokens_broadcast("/ws/a")
        app._schedule_tokens_broadcast("/ws/b")
        await asyncio.sleep(0.05)
        assert mock_broadcast.call_count == 2
        broadcast_workspaces = {
            call.args[0]["payload"]["ws"] for call in mock_broadcast.call_args_list
        }
        assert broadcast_workspaces == {"/ws/a", "/ws/b"}


@pytest.mark.asyncio
async def test_new_burst_after_window_broadcasts_again(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(app.tokens_store, "snapshot", lambda ws: {"ws": ws})
    with patch.object(app, "broadcast", new_callable=AsyncMock) as mock_broadcast:
        app._schedule_tokens_broadcast("/ws/a")
        await asyncio.sleep(0.05)
        app._schedule_tokens_broadcast("/ws/a")
        await asyncio.sleep(0.05)
        assert mock_broadcast.call_count == 2
