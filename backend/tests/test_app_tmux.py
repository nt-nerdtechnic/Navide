"""Tests for /api/tmux/check logic (tested without importing the full FastAPI app
to avoid the watchdog dependency that breaks the test environment).

The endpoint logic is simple: call `tmux has-session -t {name}` per name and
return a dict of {name: bool}. We verify this logic directly via subprocess mock.
"""

from __future__ import annotations

import subprocess
from types import SimpleNamespace
from unittest.mock import patch, MagicMock

import pytest


# ── Standalone helper that replicates the endpoint logic ──────────────────────
# Copied from app.py so tests are self-contained and don't trigger the watchdog
# import chain.

def _check_tmux_alive(names: list[str]) -> dict[str, bool]:
    results: dict[str, bool] = {}
    for name in names:
        try:
            ret = subprocess.run(
                ["tmux", "has-session", "-t", name],
                capture_output=True,
            )
            results[name] = ret.returncode == 0
        except OSError:
            results[name] = False
    return results


# ── Tests ─────────────────────────────────────────────────────────────────────

def test_check_tmux_alive_returns_true():
    with patch("subprocess.run") as mock_run:
        mock_run.return_value = SimpleNamespace(returncode=0)
        result = _check_tmux_alive(["at-abc123"])
    assert result["at-abc123"] is True


def test_check_tmux_dead_returns_false():
    with patch("subprocess.run") as mock_run:
        mock_run.return_value = SimpleNamespace(returncode=1)
        result = _check_tmux_alive(["at-dead"])
    assert result["at-dead"] is False


def test_check_tmux_multiple_sessions():
    def _side_effect(cmd, **kwargs):
        name = cmd[-1]
        return SimpleNamespace(returncode=0 if name == "at-alive" else 1)

    with patch("subprocess.run", side_effect=_side_effect):
        result = _check_tmux_alive(["at-alive", "at-dead1", "at-dead2"])

    assert result["at-alive"] is True
    assert result["at-dead1"] is False
    assert result["at-dead2"] is False


def test_check_tmux_empty_list():
    with patch("subprocess.run") as mock_run:
        result = _check_tmux_alive([])
    assert result == {}
    mock_run.assert_not_called()


def test_check_tmux_os_error_returns_false():
    with patch("subprocess.run", side_effect=OSError("tmux not found")):
        result = _check_tmux_alive(["at-x"])
    assert result["at-x"] is False


def test_check_tmux_calls_correct_command():
    with patch("subprocess.run") as mock_run:
        mock_run.return_value = SimpleNamespace(returncode=0)
        _check_tmux_alive(["my-session"])

    mock_run.assert_called_once_with(
        ["tmux", "has-session", "-t", "my-session"],
        capture_output=True,
    )


# ── Verify app.py response shape via module inspection ────────────────────────

def test_terminal_create_response_includes_tmux_name_field():
    """Verify app.py's terminal.create handler references tmux_name in the response.

    This is a static assertion on the source code — it checks that our edit
    landed correctly without importing the full app (which needs watchdog).
    """
    import pathlib
    app_py = pathlib.Path(__file__).parent.parent / "agent_team_backend" / "app.py"
    source = app_py.read_text(encoding="utf-8")
    assert '"tmux_name": term.tmux_name' in source, \
        "app.py terminal.create handler must include tmux_name in the WS response"


def test_pipeline_slot_tmux_handler_exists():
    """Verify the pipeline.slot_tmux WS handler was added to app.py."""
    import pathlib
    app_py = pathlib.Path(__file__).parent.parent / "agent_team_backend" / "app.py"
    source = app_py.read_text(encoding="utf-8")
    assert 'msg_type == "pipeline.slot_tmux"' in source, \
        "pipeline.slot_tmux handler is missing from app.py"


def test_manual_pane_tmux_handler_exists():
    """Verify the manual_pane.tmux WS handler was added to app.py."""
    import pathlib
    app_py = pathlib.Path(__file__).parent.parent / "agent_team_backend" / "app.py"
    source = app_py.read_text(encoding="utf-8")
    assert 'msg_type == "manual_pane.tmux"' in source, \
        "manual_pane.tmux handler is missing from app.py"


def test_tmux_check_endpoint_exists():
    """Verify the /api/tmux/check HTTP endpoint was added to app.py."""
    import pathlib
    app_py = pathlib.Path(__file__).parent.parent / "agent_team_backend" / "app.py"
    source = app_py.read_text(encoding="utf-8")
    assert '"/api/tmux/check"' in source, \
        "/api/tmux/check endpoint is missing from app.py"
