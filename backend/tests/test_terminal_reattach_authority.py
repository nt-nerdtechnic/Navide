"""Host attestation checks for terminal reattach (without real PTYs)."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

from agent_team_backend import app


class Socket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


class FakeTerminals:
    def __init__(self, *entries: Any) -> None:
        self._sessions = {entry.id: entry for entry in entries}
        self.redraws: list[tuple[Any, ...]] = []

    def force_redraw(self, *args: Any, **kwargs: Any) -> None:
        self.redraws.append((*args, *kwargs.values()))


def entry(sid: str, *, cwd: str = "/ws", origin: str = "editor", agent_key: str = "claude") -> Any:
    return SimpleNamespace(
        id=sid, closed=False, cwd=cwd, metadata={"origin": origin}, agent_key=agent_key,
    )


def session(*entries: Any, authenticated: bool = True) -> app.Session:
    ws = Socket()
    result = app.Session(ws)  # type: ignore[arg-type]
    result.terminals = FakeTerminals(*entries)  # type: ignore[assignment]
    result.host_authenticated = authenticated
    return result


async def call(s: app.Session, payload: dict[str, Any]) -> dict[str, Any]:
    await app.handle_message(s, {"id": "r", "type": "terminal.reattach", "payload": payload})
    return s.websocket.sent[-1]  # type: ignore[attr-defined,no-any-return]


@pytest.fixture(autouse=True)
def clear_owners() -> None:
    app._PTY_OWNERS.clear()
    yield
    app._PTY_OWNERS.clear()


@pytest.mark.asyncio
async def test_attested_host_adopts_matching_session_and_reports_metadata() -> None:
    s = session(entry("t1"))
    response = await call(s, {
        "terminal_session_ids": ["t1"], "cols": 80, "rows": 24,
        "expected_workspace_path": "/ws", "expected_origin": "editor",
        "expected_profile_ids": ["claude"],
    })
    assert response["ok"] is True
    assert response["payload"]["alive"] == ["t1"]
    assert response["payload"]["sessions"]["t1"] == {
        "agent_key": "claude", "workspace_path": "/ws", "origin": "editor",
    }
    assert app._PTY_OWNERS["t1"] is s


@pytest.mark.asyncio
@pytest.mark.parametrize("field, value", [
    ("expected_workspace_path", "/other"),
    ("expected_workspace_path", "/ws-link"),
    ("expected_origin", "plan"),
    ("expected_profile_ids", ["codex"]),
])
async def test_attestation_mismatch_does_not_claim_or_redraw(field: str, value: Any) -> None:
    s = session(entry("t1"))
    payload: dict[str, Any] = {
        "terminal_session_ids": ["t1"], "cols": 80, "rows": 24,
        "expected_workspace_path": "/ws", "expected_origin": "editor",
        "expected_profile_ids": ["claude"],
    }
    payload[field] = value
    response = await call(s, payload)
    assert response["payload"]["alive"] == []
    assert response["payload"]["dead"] == ["t1"]
    assert "t1" not in app._PTY_OWNERS
    assert s.terminals.redraws == []  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_attestation_requires_authenticated_host() -> None:
    s = session(entry("t1"), authenticated=False)
    response = await call(s, {
        "terminal_session_ids": ["t1"], "expected_origin": "editor",
    })
    assert response["ok"] is False
    assert response["error"]["code"] == "UNAUTHORIZED"
    assert app._PTY_OWNERS == {}


@pytest.mark.asyncio
@pytest.mark.parametrize("field, value", [
    ("expected_workspace_path", 42),
    ("expected_origin", None),
    ("expected_profile_ids", "claude"),
    ("expected_profile_ids", ["claude", 1]),
])
async def test_malformed_attestation_is_rejected_before_effects(field: str, value: Any) -> None:
    s = session(entry("t1"))
    response = await call(s, {"terminal_session_ids": ["t1"], field: value})
    assert response["ok"] is False
    assert response["error"]["code"] == "BAD_REQUEST"
    assert app._PTY_OWNERS == {}


@pytest.mark.asyncio
async def test_legacy_request_preserves_old_shape_and_behavior() -> None:
    s = session(entry("t1", agent_key=""), authenticated=False)
    response = await call(s, {"terminal_session_ids": ["t1"], "cols": 0, "rows": 0})
    assert response["payload"]["alive"] == ["t1"]
    assert "sessions" not in response["payload"]
    assert app._PTY_OWNERS["t1"] is s
