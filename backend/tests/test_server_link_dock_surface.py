"""Embedded AI panels (AiCliDock) name their window on the network view too.

A panel's roster entry carries `surface` / `window_kind`; the network snapshot
and the published session add them as OPTIONAL keys. A window pane carries
neither, so its published session and snapshot row are exactly what they were,
and a peer on an older build — whose parser reads named keys only — sees no
change at all.
"""

from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import agent_messaging, remote_roster, server_link

_OLD_SESSION_KEYS = {"title", "agentKey", "status", "taskId", "workspacePath", "workspace", "paneId"}


@pytest.fixture()
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    remote_roster.clear()
    yield
    agent_messaging._reset_for_test()
    remote_roster.clear()


def _link() -> server_link.ServerLink:
    link = server_link.ServerLink(connect=lambda url: None, config_loader=lambda: None)
    link._device_id = "me"
    return link


def test_a_window_panes_published_session_is_unchanged(_clean_registry: Any) -> None:
    entry = agent_messaging.register("p1", "worker", "/ws/alpha", agent_key="claude")
    assert set(server_link._session_payload(entry)) == _OLD_SESSION_KEYS


def test_a_panels_published_session_names_its_window(_clean_registry: Any) -> None:
    entry = agent_messaging.register(
        "d1", "pm-claude", "/ws/alpha", agent_key="claude", surface="pm", window_kind="main"
    )
    payload = server_link._session_payload(entry)
    assert set(payload) == _OLD_SESSION_KEYS | {"surface", "windowKind"}
    assert (payload["surface"], payload["windowKind"]) == ("pm", "main")


def _local_row(link: server_link.ServerLink, pane_id: str) -> dict[str, Any]:
    device = next(d for d in link.network_snapshot()["devices"] if d["deviceId"] == "me")
    return next(p for p in device["panes"] if p["paneId"] == pane_id)


def test_this_devices_panel_row_names_its_window(_clean_registry: Any) -> None:
    """The server keeps fixed columns and drops the two keys, so for this
    machine's own rows the local registry says which window a panel lives in."""
    agent_messaging.register("d1", "pm-claude", "/ws/alpha", agent_key="claude", surface="pm", window_kind="main")
    agent_messaging.register("p1", "worker", "/ws/alpha", agent_key="claude")
    link = _link()
    link._directory = [
        {"deviceId": "me", "paneId": "d1", "sessionId": "s1", "title": "pm-claude", "workspace": "alpha"},
        {"deviceId": "me", "paneId": "p1", "sessionId": "s2", "title": "worker", "workspace": "alpha"},
    ]
    panel = _local_row(link, "d1")
    assert (panel["surface"], panel["windowKind"]) == ("pm", "main")
    window_pane = _local_row(link, "p1")
    assert "surface" not in window_pane
    assert "windowKind" not in window_pane


def test_a_peers_row_passes_the_keys_through_only_when_sent(_clean_registry: Any) -> None:
    link = _link()
    link._directory = [
        {"deviceId": "peer", "paneId": "d9", "sessionId": "s9", "title": "plans-codex",
         "workspace": "beta", "surface": "plans", "windowKind": "plans"},
        {"deviceId": "peer", "paneId": "p9", "sessionId": "s8", "title": "worker", "workspace": "beta"},
    ]
    device = next(d for d in link.network_snapshot()["devices"] if d["deviceId"] == "peer")
    rows = {p["paneId"]: p for p in device["panes"]}
    assert (rows["d9"]["surface"], rows["d9"]["windowKind"]) == ("plans", "plans")
    assert "surface" not in rows["p9"]
    assert "windowKind" not in rows["p9"]


def test_the_remote_roster_parser_ignores_the_new_keys(_clean_registry: Any) -> None:
    """What an older build does with a row a newer peer published: the parser
    reads named keys only, so the extra two change nothing."""
    base = {"deviceId": "peer", "sessionId": "s1", "paneId": "d1", "title": "pm-claude",
            "workspace": "alpha", "agentKey": "claude", "status": "running"}
    remote_roster.replace([base], local_device_id="me")
    [plain] = remote_roster.list_panes()
    remote_roster.replace([{**base, "surface": "pm", "windowKind": "main"}], local_device_id="me")
    [extended] = remote_roster.list_panes()
    assert extended == plain
