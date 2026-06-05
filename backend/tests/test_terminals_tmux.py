"""Tests for TerminalService tmux spawn/kill/resize logic.

Uses mock subprocess calls so tmux does not need to be installed.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock, call, patch

import pytest

from agent_team_backend.terminals import (
    TerminalService,
    _make_tmux_name,
    _tmux_available,
)


# ── _tmux_available ────────────────────────────────────────────────────────────

def test_tmux_not_installed():
    with patch("agent_team_backend.terminals.shutil.which", return_value=None):
        assert _tmux_available() is False


def test_tmux_version_below_minimum():
    with patch("agent_team_backend.terminals.shutil.which", return_value="/usr/bin/tmux"), \
         patch("agent_team_backend.terminals.subprocess.run") as mock_run:
        mock_run.return_value = SimpleNamespace(stdout="tmux 2.9", stderr="", returncode=0)
        assert _tmux_available() is False


def test_tmux_version_at_minimum():
    with patch("agent_team_backend.terminals.shutil.which", return_value="/usr/bin/tmux"), \
         patch("agent_team_backend.terminals.subprocess.run") as mock_run:
        mock_run.return_value = SimpleNamespace(stdout="tmux 3.0", stderr="", returncode=0)
        assert _tmux_available() is True


def test_tmux_version_above_minimum():
    with patch("agent_team_backend.terminals.shutil.which", return_value="/usr/bin/tmux"), \
         patch("agent_team_backend.terminals.subprocess.run") as mock_run:
        mock_run.return_value = SimpleNamespace(stdout="tmux 3.4a", stderr="", returncode=0)
        assert _tmux_available() is True


def test_tmux_subprocess_error():
    with patch("agent_team_backend.terminals.shutil.which", return_value="/usr/bin/tmux"), \
         patch("agent_team_backend.terminals.subprocess.run", side_effect=OSError("no tmux")):
        assert _tmux_available() is False


# ── _make_tmux_name ────────────────────────────────────────────────────────────

def test_make_tmux_name_format():
    name = _make_tmux_name("abc-def-123-456")
    assert name.startswith("at-")
    assert len(name) <= 50


def test_make_tmux_name_strips_dashes():
    name = _make_tmux_name("abcd-1234-5678")
    assert "-" not in name.replace("at-", "")


# ── TerminalService tmux spawn ─────────────────────────────────────────────────

async def _make_service(use_tmux: bool) -> TerminalService:
    async def _emit(_event):
        pass
    svc = TerminalService(emit=_emit)
    svc._use_tmux = use_tmux
    return svc


def _make_popen_mock(pid: int = 12345):
    mock = MagicMock()
    mock.pid = pid
    mock.returncode = None
    return mock


@pytest.mark.asyncio
async def test_create_tmux_mode_calls_new_session_then_attach(tmp_path):
    """When _use_tmux=True, create() must call tmux new-session then attach-session."""
    import os
    svc = await _make_service(use_tmux=True)
    popen_mock = _make_popen_mock()

    with patch("agent_team_backend.terminals.shutil.which", return_value="/usr/bin/bash"), \
         patch("agent_team_backend.terminals.pty.openpty", return_value=(10, 11)), \
         patch("agent_team_backend.terminals.fcntl.fcntl"), \
         patch("agent_team_backend.terminals.fcntl.ioctl"), \
         patch("agent_team_backend.terminals.os.close"), \
         patch("agent_team_backend.terminals.subprocess.run") as mock_run, \
         patch("agent_team_backend.terminals.subprocess.Popen", return_value=popen_mock) as mock_popen, \
         patch.object(svc._loop, "add_reader"):

        mock_run.return_value = SimpleNamespace(returncode=0, stdout="", stderr="")

        session = svc.create(
            pane_id="pane-1",
            agent_key="claude",
            command=["bash", "-lc", "claude"],
            cwd=str(tmp_path),
            cols=120,
            rows=30,
        )

    assert session.tmux_name.startswith("at-")
    # subprocess.run called for new-session
    new_session_call = mock_run.call_args_list[0]
    args = new_session_call[0][0]
    assert args[0] == "tmux"
    assert "new-session" in args
    assert "-d" in args
    assert "-s" in args
    # Popen called with attach-session
    popen_args = mock_popen.call_args[0][0]
    assert popen_args[0] == "tmux"
    assert "attach-session" in popen_args


@pytest.mark.asyncio
async def test_create_plain_pty_when_tmux_disabled(tmp_path):
    """When _use_tmux=False, create() must not call tmux at all."""
    svc = await _make_service(use_tmux=False)
    popen_mock = _make_popen_mock()

    with patch("agent_team_backend.terminals.shutil.which", return_value="/usr/bin/bash"), \
         patch("agent_team_backend.terminals.pty.openpty", return_value=(10, 11)), \
         patch("agent_team_backend.terminals.fcntl.fcntl"), \
         patch("agent_team_backend.terminals.fcntl.ioctl"), \
         patch("agent_team_backend.terminals.os.close"), \
         patch("agent_team_backend.terminals.subprocess.run") as mock_run, \
         patch("agent_team_backend.terminals.subprocess.Popen", return_value=popen_mock) as mock_popen, \
         patch.object(svc._loop, "add_reader"):

        session = svc.create(
            pane_id="pane-2",
            agent_key="claude",
            command=["bash", "-lc", "claude"],
            cwd=str(tmp_path),
        )

    assert session.tmux_name == ""
    mock_run.assert_not_called()
    # Popen called directly with the command, not tmux attach
    popen_args = mock_popen.call_args[0][0]
    assert popen_args[0] != "tmux"


@pytest.mark.asyncio
async def test_create_falls_back_to_plain_pty_on_tmux_error(tmp_path):
    """If tmux new-session fails, create() must fall back to plain PTY without raising."""
    svc = await _make_service(use_tmux=True)
    popen_mock = _make_popen_mock()

    import subprocess as _sp

    with patch("agent_team_backend.terminals.shutil.which", return_value="/usr/bin/bash"), \
         patch("agent_team_backend.terminals.pty.openpty", return_value=(10, 11)), \
         patch("agent_team_backend.terminals.fcntl.fcntl"), \
         patch("agent_team_backend.terminals.fcntl.ioctl"), \
         patch("agent_team_backend.terminals.os.close"), \
         patch("agent_team_backend.terminals.subprocess.run",
               side_effect=_sp.CalledProcessError(1, "tmux")), \
         patch("agent_team_backend.terminals.subprocess.Popen", return_value=popen_mock), \
         patch.object(svc._loop, "add_reader"):

        session = svc.create(
            pane_id="pane-3",
            agent_key="claude",
            command=["bash", "-lc", "claude"],
            cwd=str(tmp_path),
        )

    assert session.tmux_name == ""


@pytest.mark.asyncio
async def test_kill_calls_tmux_kill_session(tmp_path):
    """kill() must call tmux kill-session when session.tmux_name is set."""
    svc = await _make_service(use_tmux=True)
    popen_mock = _make_popen_mock()
    popen_mock.returncode = 0

    with patch("agent_team_backend.terminals.shutil.which", return_value="/usr/bin/bash"), \
         patch("agent_team_backend.terminals.pty.openpty", return_value=(10, 11)), \
         patch("agent_team_backend.terminals.fcntl.fcntl"), \
         patch("agent_team_backend.terminals.fcntl.ioctl"), \
         patch("agent_team_backend.terminals.os.close"), \
         patch("agent_team_backend.terminals.subprocess.run") as mock_run, \
         patch("agent_team_backend.terminals.subprocess.Popen", return_value=popen_mock), \
         patch.object(svc._loop, "add_reader"), \
         patch.object(svc._loop, "remove_reader"), \
         patch.object(svc._loop, "remove_writer", side_effect=ValueError):

        mock_run.return_value = SimpleNamespace(returncode=0, stdout="", stderr="")
        session = svc.create(
            pane_id="pane-4",
            agent_key="claude",
            command=["bash", "-lc", "claude"],
            cwd=str(tmp_path),
        )
        tmux_name = session.tmux_name
        assert tmux_name  # must have a name

        with patch("agent_team_backend.terminals.os.killpg"):
            svc.kill(session.id)

    # The second subprocess.run call should be tmux kill-session
    kill_calls = [c for c in mock_run.call_args_list if "kill-session" in str(c)]
    assert kill_calls, "tmux kill-session was not called"
    assert tmux_name in str(kill_calls[0])


@pytest.mark.asyncio
async def test_create_kills_orphan_session_when_attach_fails(tmp_path):
    """If new-session succeeds but Popen(attach) raises, the orphan session must be killed."""
    import subprocess as _sp

    svc = await _make_service(use_tmux=True)
    popen_call_count = 0

    def _popen_side_effect(cmd, **kwargs):
        nonlocal popen_call_count
        popen_call_count += 1
        if "attach-session" in cmd:
            raise OSError("attach failed")
        return _make_popen_mock()

    kill_calls = []

    def _run_side_effect(cmd, **kwargs):
        if "kill-session" in cmd:
            kill_calls.append(cmd)
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    with patch("agent_team_backend.terminals.shutil.which", return_value="/usr/bin/bash"), \
         patch("agent_team_backend.terminals.pty.openpty", return_value=(10, 11)), \
         patch("agent_team_backend.terminals.fcntl.fcntl"), \
         patch("agent_team_backend.terminals.fcntl.ioctl"), \
         patch("agent_team_backend.terminals.os.close"), \
         patch("agent_team_backend.terminals.subprocess.run", side_effect=_run_side_effect), \
         patch("agent_team_backend.terminals.subprocess.Popen", side_effect=_popen_side_effect), \
         patch.object(svc._loop, "add_reader"):

        session = svc.create(
            pane_id="pane-6",
            agent_key="claude",
            command=["bash", "-lc", "claude"],
            cwd=str(tmp_path),
        )

    # Fell back to plain PTY — tmux_name cleared
    assert session.tmux_name == ""
    # kill-session must have been called to clean up the orphaned session
    assert any("kill-session" in str(c) for c in kill_calls), \
        "Expected tmux kill-session to compensate for failed attach"


@pytest.mark.asyncio
async def test_create_skip_tmux_bypasses_tmux_even_when_use_tmux_true(tmp_path):
    """When skip_tmux=True, create() must use plain PTY even if _use_tmux=True."""
    svc = await _make_service(use_tmux=True)
    popen_mock = _make_popen_mock()

    with patch("agent_team_backend.terminals.shutil.which", return_value="/usr/bin/bash"), \
         patch("agent_team_backend.terminals.pty.openpty", return_value=(10, 11)), \
         patch("agent_team_backend.terminals.fcntl.fcntl"), \
         patch("agent_team_backend.terminals.fcntl.ioctl"), \
         patch("agent_team_backend.terminals.os.close"), \
         patch("agent_team_backend.terminals.subprocess.run") as mock_run, \
         patch("agent_team_backend.terminals.subprocess.Popen", return_value=popen_mock) as mock_popen, \
         patch.object(svc._loop, "add_reader"):

        session = svc.create(
            pane_id="pane-skip",
            agent_key="claude",
            command=["bash", "-lc", "tmux attach-session -t at-abc123 -d"],
            cwd=str(tmp_path),
            skip_tmux=True,
        )

    # skip_tmux=True → no tmux_name assigned, no tmux subprocess called
    assert session.tmux_name == ""
    mock_run.assert_not_called()
    # Popen called directly with the command, not a tmux attach wrapper
    popen_args = mock_popen.call_args[0][0]
    assert popen_args[0] != "tmux"


@pytest.mark.asyncio
async def test_kill_no_tmux_session_skips_kill_session(tmp_path):
    """kill() must NOT call tmux kill-session when tmux_name is empty."""
    svc = await _make_service(use_tmux=False)
    popen_mock = _make_popen_mock()
    popen_mock.returncode = 0

    with patch("agent_team_backend.terminals.shutil.which", return_value="/usr/bin/bash"), \
         patch("agent_team_backend.terminals.pty.openpty", return_value=(10, 11)), \
         patch("agent_team_backend.terminals.fcntl.fcntl"), \
         patch("agent_team_backend.terminals.fcntl.ioctl"), \
         patch("agent_team_backend.terminals.os.close"), \
         patch("agent_team_backend.terminals.subprocess.run") as mock_run, \
         patch("agent_team_backend.terminals.subprocess.Popen", return_value=popen_mock), \
         patch.object(svc._loop, "add_reader"), \
         patch.object(svc._loop, "remove_reader"), \
         patch.object(svc._loop, "remove_writer", side_effect=ValueError):

        session = svc.create(
            pane_id="pane-5",
            agent_key="claude",
            command=["bash", "-lc", "claude"],
            cwd=str(tmp_path),
        )
        assert session.tmux_name == ""

        with patch("agent_team_backend.terminals.os.killpg"):
            svc.kill(session.id)

    kill_calls = [c for c in mock_run.call_args_list if "kill-session" in str(c)]
    assert not kill_calls, "tmux kill-session should not be called when no tmux_name"
