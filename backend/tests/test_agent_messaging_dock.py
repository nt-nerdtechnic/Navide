"""Embedded AI panels (AiCliDock) in the pane registry.

A dock registers with the same agent_msg.register every window pane uses, plus
an optional `surface` / `window_kind` naming the window it lives in. Every
assertion about a pane registered WITHOUT those fields pins today's behaviour:
the main window never sends them, and nothing it sees may change.
"""

from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import agent_messaging, app

#: The exact key set a main-window pane reports today. A dock adds keys; a pane
#: registered without the new fields must keep precisely this set.
_MAIN_PANE_KEYS = {
    "pane_id",
    "name",
    "workspace_path",
    "workspace_label",
    "qualified_name",
    "agent_key",
    "busy",
    "offline",
    "realized",
    "displayStatus",
}


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


class FakeWebSocket:
    def __init__(self) -> None:
        self.sent: list[dict[str, Any]] = []

    async def send_json(self, payload: dict[str, Any]) -> None:
        self.sent.append(payload)


def _session() -> app.Session:
    return app.Session(FakeWebSocket())  # type: ignore[arg-type]


# T1 — a pane registered without the new fields reports exactly what it does today.
def test_a_main_window_pane_reports_the_same_keys_as_before() -> None:
    entry = agent_messaging.register("p1", "sender", "/ws/alpha", agent_key="claude")
    assert set(entry.to_dict()) == _MAIN_PANE_KEYS


def test_a_dock_reports_its_surface_and_window_kind() -> None:
    entry = agent_messaging.register(
        "d1", "pm-claude", "/ws/alpha", agent_key="claude", surface="pm", window_kind="main"
    )
    view = entry.to_dict()
    assert view["surface"] == "pm"
    assert view["window_kind"] == "main"
    assert entry.is_dock


def test_a_main_window_pane_is_not_a_dock() -> None:
    assert not agent_messaging.register("p1", "sender", "/ws/alpha").is_dock
    assert not agent_messaging.register("p2", "other", "/ws/alpha", surface="main").is_dock


# T2 — delivery to a dock is refused with its own code; normal targets are untouched.
def test_a_dock_is_refused_as_a_delivery_target() -> None:
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("d1", "pm-claude", "/ws/alpha", surface="pm")
    for to in ("pm-claude", "alpha/pm-claude"):
        result = agent_messaging.resolve("p1", to)
        assert result.pane is None
        assert result.code == "target-is-dock"
        assert "embedded" in (result.error or "")


def test_a_main_window_target_still_resolves_beside_a_dock() -> None:
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("p2", "reviewer", "/ws/alpha")
    agent_messaging.register("d1", "pm-claude", "/ws/alpha", surface="pm")
    result = agent_messaging.resolve("p1", "reviewer")
    assert result.pane is not None and result.pane.pane_id == "p2"
    assert result.code is None


def test_an_offline_dock_still_reports_offline_first() -> None:
    window = object()
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.register("d1", "pm-claude", "/ws/alpha", owner=window, surface="pm")
    agent_messaging.drop_owner(window)
    assert agent_messaging.resolve("p1", "pm-claude").code == "target-offline"


# The WS handler carries the optional fields through, and leaves them out otherwise.
@pytest.mark.asyncio
async def test_the_register_handler_carries_surface_and_window_kind() -> None:
    session = _session()
    await app.handle_message(session, {
        "id": "r1",
        "type": "agent_msg.register",
        "payload": {
            "pane_id": "d1",
            "name": "pm-claude",
            "workspace_path": "/ws/alpha",
            "agent_key": "claude",
            "surface": "pm",
            "window_kind": "main",
        },
    })
    entry = agent_messaging.get("d1")
    assert entry is not None and entry.surface == "pm" and entry.window_kind == "main"
    assert session.websocket.sent[0]["payload"]["surface"] == "pm"  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_the_register_handler_without_the_fields_answers_as_before() -> None:
    session = _session()
    await app.handle_message(session, {
        "id": "r2",
        "type": "agent_msg.register",
        "payload": {"pane_id": "p1", "name": "sender", "workspace_path": "/ws/alpha"},
    })
    resp = session.websocket.sent[0]  # type: ignore[attr-defined]
    assert set(resp["payload"]) == _MAIN_PANE_KEYS


# The dock-only handlers: what a plugin window can reach through its broker.
# They reuse agent_msg.register / unregister but can never touch a window pane.
@pytest.mark.asyncio
async def test_register_dock_registers_a_panel() -> None:
    session = _session()
    await app.handle_message(session, {
        "id": "r3",
        "type": "agent_msg.register_dock",
        "payload": {
            "pane_id": "d1",
            "name": "git-claude",
            "workspace_path": "/ws/alpha",
            "agent_key": "claude",
            "surface": "git",
            "window_kind": "git",
        },
    })
    resp = session.websocket.sent[-1]  # type: ignore[attr-defined]
    assert resp["payload"]["surface"] == "git"
    entry = agent_messaging.get("d1")
    assert entry is not None and entry.is_dock


@pytest.mark.asyncio
async def test_register_dock_requires_a_dock_surface() -> None:
    for surface in ("", "main"):
        session = _session()
        await app.handle_message(session, {
            "id": "r4",
            "type": "agent_msg.register_dock",
            "payload": {"pane_id": "d1", "name": "x", "workspace_path": "/ws/alpha", "surface": surface},
        })
        assert session.websocket.sent[-1]["error"]["code"] == "BAD_REQUEST"  # type: ignore[attr-defined]
    assert agent_messaging.get("d1") is None


@pytest.mark.asyncio
async def test_register_dock_cannot_take_over_a_window_pane() -> None:
    agent_messaging.register("p1", "reviewer", "/ws/alpha", agent_key="claude")
    session = _session()
    await app.handle_message(session, {
        "id": "r5",
        "type": "agent_msg.register_dock",
        "payload": {"pane_id": "p1", "name": "git-claude", "workspace_path": "/ws/alpha", "surface": "git"},
    })
    assert session.websocket.sent[-1]["error"]["code"] == "FORBIDDEN"  # type: ignore[attr-defined]
    entry = agent_messaging.get("p1")
    assert entry is not None and entry.name == "reviewer" and not entry.is_dock


@pytest.mark.asyncio
async def test_unregister_dock_removes_only_a_panel() -> None:
    agent_messaging.register("p1", "reviewer", "/ws/alpha")
    agent_messaging.register("d1", "git-claude", "/ws/alpha", surface="git")
    session = _session()
    await app.handle_message(session, {
        "id": "u1", "type": "agent_msg.unregister_dock", "payload": {"pane_id": "p1"},
    })
    assert session.websocket.sent[-1]["error"]["code"] == "FORBIDDEN"  # type: ignore[attr-defined]
    assert agent_messaging.get("p1") is not None

    await app.handle_message(session, {
        "id": "u2", "type": "agent_msg.unregister_dock", "payload": {"pane_id": "d1"},
    })
    assert agent_messaging.get("d1") is None


@pytest.mark.asyncio
async def test_register_dock_cannot_alias_a_window_pane_id() -> None:
    """former_pane_ids would make a window pane's CLI resolve as the panel."""
    agent_messaging.register("p1", "reviewer", "/ws/alpha")
    agent_messaging.unregister("p1")  # even an id no longer live
    agent_messaging.register("p2", "builder", "/ws/alpha")
    session = _session()
    await app.handle_message(session, {
        "id": "r6",
        "type": "agent_msg.register_dock",
        "payload": {
            "pane_id": "d1",
            "name": "git-claude",
            "workspace_path": "/ws/alpha",
            "surface": "git",
            "former_pane_ids": ["p1", "p2"],
            "spawned_by": "p2",
        },
    })
    assert agent_messaging.current("p2").pane_id == "p2"  # type: ignore[union-attr]
    assert agent_messaging.current("p1") is None
    entry = agent_messaging.get("d1")
    assert entry is not None and entry.spawned_by == ""


@pytest.mark.asyncio
async def test_register_dock_cannot_take_over_another_windows_panel() -> None:
    owner_window, other_window = _session(), _session()
    await app.handle_message(owner_window, {
        "id": "r7",
        "type": "agent_msg.register_dock",
        "payload": {"pane_id": "d1", "name": "pm-claude", "workspace_path": "/ws/alpha", "surface": "pm"},
    })
    await app.handle_message(other_window, {
        "id": "r8",
        "type": "agent_msg.register_dock",
        "payload": {"pane_id": "d1", "name": "evil", "workspace_path": "/ws/beta", "surface": "git"},
    })
    assert other_window.websocket.sent[-1]["error"]["code"] == "FORBIDDEN"  # type: ignore[attr-defined]
    entry = agent_messaging.get("d1")
    assert entry is not None and entry.name == "pm-claude"

    # The owning window itself may re-register (rename / reconnect).
    await app.handle_message(owner_window, {
        "id": "r9",
        "type": "agent_msg.register_dock",
        "payload": {"pane_id": "d1", "name": "pm-claude-2", "workspace_path": "/ws/alpha", "surface": "pm"},
    })
    assert agent_messaging.get("d1").name == "pm-claude-2"  # type: ignore[union-attr]


@pytest.mark.asyncio
async def test_a_panel_left_by_a_disconnected_window_can_be_reclaimed() -> None:
    first, second = _session(), _session()
    await app.handle_message(first, {
        "id": "r10",
        "type": "agent_msg.register_dock",
        "payload": {"pane_id": "d1", "name": "pm-claude", "workspace_path": "/ws/alpha", "surface": "pm"},
    })
    agent_messaging.drop_owner(first)
    await app.handle_message(second, {
        "id": "r11",
        "type": "agent_msg.register_dock",
        "payload": {"pane_id": "d1", "name": "pm-claude", "workspace_path": "/ws/alpha", "surface": "pm"},
    })
    entry = agent_messaging.get("d1")
    assert entry is not None and not entry.offline
