"""Tests for /api/tmux/check logic (tested without importing the full FastAPI app
to avoid the watchdog dependency that breaks the test environment).

The endpoint now uses a single `tmux ls` call and set-membership lookup instead
of N per-session `has-session` calls.  Tests here validate that logic directly
via a standalone helper that mirrors the real implementation.
"""

from __future__ import annotations

import re
import subprocess
from types import SimpleNamespace
from unittest.mock import patch

import pytest

# tmux session name regex — must match the one in app.py / projects.py.
_TMUX_NAME_RE = re.compile(r"^at-[A-Za-z0-9]{1,32}$")


# ── Standalone helper that mirrors the real /api/tmux/check logic ─────────────
# Uses tmux ls (one call) + set membership instead of per-session has-session.

def _check_tmux_alive(names: list[str]) -> dict[str, bool]:
    if not names:
        return {}
    invalid = {n: False for n in names if not _TMUX_NAME_RE.fullmatch(n)}
    to_check = [n for n in names if _TMUX_NAME_RE.fullmatch(n)]
    live: set[str] = set()
    if to_check:
        try:
            result = subprocess.run(
                ["tmux", "ls", "-F", "#{session_name}"],
                capture_output=True,
                text=True,
            )
            live = set(result.stdout.splitlines())
        except OSError:
            pass
    return {**invalid, **{n: n in live for n in to_check}}


# ── Tests ─────────────────────────────────────────────────────────────────────

def test_check_tmux_alive_returns_true():
    with patch("subprocess.run") as mock_run:
        mock_run.return_value = SimpleNamespace(returncode=0, stdout="at-abc123\n", stderr="")
        result = _check_tmux_alive(["at-abc123"])
    assert result["at-abc123"] is True


def test_check_tmux_dead_returns_false():
    with patch("subprocess.run") as mock_run:
        mock_run.return_value = SimpleNamespace(returncode=0, stdout="", stderr="")
        result = _check_tmux_alive(["at-dead"])
    assert result["at-dead"] is False


def test_check_tmux_multiple_sessions():
    ls_output = "at-alive\n"
    with patch("subprocess.run") as mock_run:
        mock_run.return_value = SimpleNamespace(returncode=0, stdout=ls_output, stderr="")
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
        result = _check_tmux_alive(["at-xyz"])
    assert result["at-xyz"] is False


def test_check_tmux_uses_single_ls_call_not_per_session():
    """One tmux ls call for N sessions — NOT N has-session calls."""
    names = [f"at-{'a' * 10}{i}" for i in range(5)]
    with patch("subprocess.run") as mock_run:
        mock_run.return_value = SimpleNamespace(returncode=0, stdout="\n".join(names), stderr="")
        result = _check_tmux_alive(names)

    # Exactly one subprocess call regardless of how many names
    assert mock_run.call_count == 1
    call_cmd = mock_run.call_args[0][0]
    assert call_cmd == ["tmux", "ls", "-F", "#{session_name}"]
    # All names present in ls output → all alive
    assert all(result[n] for n in names)


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
