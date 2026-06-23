from __future__ import annotations

import pytest

from agent_team_backend import app


@pytest.fixture(autouse=True)
def _reset_terminal_singleton():
    """The TerminalService is an app-level singleton (terminals outlive a single
    ws connection) bound to the running event loop. pytest-asyncio uses a fresh
    loop per test, so reset the singleton and the active-session pointer before
    and after each test to keep them isolated and bound to the current loop."""
    app._TERMINALS = None
    app._active_session = None
    yield
    app._TERMINALS = None
    app._active_session = None
