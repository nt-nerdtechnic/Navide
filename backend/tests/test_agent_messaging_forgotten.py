"""The registry remembers which pane ids it has forgotten, so the MCP caller
check can tell a pane that went away from an id that was never registered."""

from __future__ import annotations

from typing import Any

import pytest

from agent_team_backend import agent_messaging


@pytest.fixture(autouse=True)
def _clean_registry() -> Any:
    agent_messaging._reset_for_test()
    yield
    agent_messaging._reset_for_test()


def test_an_unregistered_id_is_remembered_as_forgotten() -> None:
    agent_messaging.register("p1", "sender", "/ws/alpha")
    assert not agent_messaging.was_forgotten("p1")
    agent_messaging.unregister("p1")
    assert agent_messaging.was_forgotten("p1")
    assert not agent_messaging.was_forgotten("never-seen")


def test_an_expired_offline_pane_is_remembered_as_forgotten() -> None:
    window = object()
    agent_messaging.register("p1", "sender", "/ws/alpha", owner=window)
    agent_messaging.drop_owner(window)
    entry = agent_messaging._PANES["p1"]
    assert entry.offline_since is not None
    entry.offline_since -= agent_messaging.OFFLINE_GRACE_S + 1
    agent_messaging.purge_expired()
    assert agent_messaging.was_forgotten("p1")


def test_registering_again_clears_the_forgotten_mark() -> None:
    agent_messaging.register("p1", "sender", "/ws/alpha")
    agent_messaging.unregister("p1")
    agent_messaging.register("p1", "sender", "/ws/alpha")
    assert not agent_messaging.was_forgotten("p1")


def test_the_forgotten_set_is_bounded() -> None:
    for i in range(agent_messaging.FORGOTTEN_IDS_MAX + 50):
        agent_messaging.register(f"p{i}", f"n{i}", "/ws/alpha")
        agent_messaging.unregister(f"p{i}")
    assert len(agent_messaging._FORGOTTEN) == agent_messaging.FORGOTTEN_IDS_MAX
    assert agent_messaging.was_forgotten(f"p{agent_messaging.FORGOTTEN_IDS_MAX + 49}")
    assert not agent_messaging.was_forgotten("p0")
