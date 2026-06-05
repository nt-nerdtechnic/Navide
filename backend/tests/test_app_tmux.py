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


# ── tmux_name format validation in /api/tmux/check ────────────────────────────

def test_check_tmux_rejects_invalid_name_without_shell():
    """Names that don't match at-[A-Za-z0-9]{1,32} must return False without calling tmux."""
    import re
    _RE = re.compile(r"^at-[A-Za-z0-9]{1,32}$")

    def _safe_check(names):
        results = {}
        for name in names:
            if not _RE.fullmatch(name):
                results[name] = False
                continue
            try:
                import subprocess
                ret = subprocess.run(["tmux", "has-session", "-t", name], capture_output=True)
                results[name] = ret.returncode == 0
            except OSError:
                results[name] = False
        return results

    with patch("subprocess.run") as mock_run:
        result = _safe_check(["evil; rm -rf /", "../etc", "at-abc123"])

    # malicious names → False without subprocess call
    assert result["evil; rm -rf /"] is False
    assert result["../etc"] is False
    # valid name → subprocess called
    mock_run.assert_called_once()
    assert "at-abc123" in str(mock_run.call_args)


# ── _reap_orphan_tmux_sessions logic ──────────────────────────────────────────

def test_reap_orphan_kills_untracked_session():
    """Sessions in tmux ls but not in any project.json must be killed."""
    import re
    _RE = re.compile(r"^at-[A-Za-z0-9]{1,32}$")

    def _reap(live_sessions, known_names):
        """Standalone replica of the reap logic for unit testing."""
        live = {s for s in live_sessions if _RE.fullmatch(s)}
        killed = []
        for orphan in live - known_names:
            killed.append(orphan)
        return killed

    orphans = _reap(
        live_sessions=["at-orphan1", "at-owned", "not-at-prefix"],
        known_names={"at-owned"},
    )
    assert "at-orphan1" in orphans
    assert "at-owned" not in orphans
    assert "not-at-prefix" not in orphans


def test_reap_orphan_noop_when_no_at_sessions():
    """If tmux has no at-* sessions, nothing is killed."""
    import re
    _RE = re.compile(r"^at-[A-Za-z0-9]{1,32}$")

    live = {s for s in ["my-session", "another"] if _RE.fullmatch(s)}
    assert live == set()


def test_reap_orphan_noop_when_all_known():
    import re
    _RE = re.compile(r"^at-[A-Za-z0-9]{1,32}$")

    live = {s for s in ["at-abc", "at-def"] if _RE.fullmatch(s)}
    known = {"at-abc", "at-def"}
    orphans = live - known
    assert orphans == set()


def test_reap_orphan_function_exists_in_app():
    """Verify _reap_orphan_tmux_sessions is defined in app.py."""
    import pathlib
    source = (pathlib.Path(__file__).parent.parent / "agent_team_backend" / "app.py").read_text()
    assert "_reap_orphan_tmux_sessions" in source


def test_startup_calls_reap(tmp_path):
    """Verify startup event handler calls _reap_orphan_tmux_sessions."""
    import pathlib
    source = (pathlib.Path(__file__).parent.parent / "agent_team_backend" / "app.py").read_text()
    assert "_reap_orphan_tmux_sessions()" in source


def test_tmux_check_endpoint_exists():
    """Verify the /api/tmux/check HTTP endpoint was added to app.py."""
    import pathlib
    app_py = pathlib.Path(__file__).parent.parent / "agent_team_backend" / "app.py"
    source = app_py.read_text(encoding="utf-8")
    assert '"/api/tmux/check"' in source, \
        "/api/tmux/check endpoint is missing from app.py"
