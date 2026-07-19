"""Spawn probe degrades transient failures instead of blocking every CLI.

The pre-spawn `claude --version` probe used a 3s timeout and RAISED on timeout,
so a momentarily overloaded machine (swap storm) made every CLI unlaunchable
even though the binary was fine (a `--version` probe is ~40ms when idle). Now
timeout / exec-error degrade to a warning and let the spawn proceed; only
definitive failures (missing binary, nonzero exit) still block.
"""

import subprocess

import pytest

from agent_team_backend import app
# AgentCliProbeError is referenced as app.AgentCliProbeError (not a bare import)
# so pytest.raises resolves the class through the live module: other tests
# importlib.reload agent_team_backend.app, which rebinds the class to a new
# identity, and a name bound here at import time would no longer match.
from agent_team_backend.app import (
    _SPAWN_PROBE_TIMEOUT_S,
    _probe_agent_cli_for_spawn,
)


@pytest.fixture
def fake_claude(monkeypatch):
    """Make shutil.which resolve claude to a fake path so the probe runs."""
    monkeypatch.setattr(app.shutil, "which", lambda _name: "/fake/bin/claude")


def _run_returns(monkeypatch, *, returncode=0, stdout="2.1.205 (Claude Code)"):
    def run(cmd, **kwargs):
        assert kwargs.get("timeout") == _SPAWN_PROBE_TIMEOUT_S  # uses the aligned timeout
        return subprocess.CompletedProcess(cmd, returncode, stdout=stdout, stderr="")
    monkeypatch.setattr(app.subprocess, "run", run)


def _run_raises(monkeypatch, exc):
    def run(cmd, **kwargs):
        raise exc
    monkeypatch.setattr(app.subprocess, "run", run)


def test_timeout_degrades_and_lets_spawn_proceed(fake_claude, monkeypatch):
    _run_raises(monkeypatch, subprocess.TimeoutExpired(cmd="claude", timeout=8))
    result = _probe_agent_cli_for_spawn("claude", "claude --resume abc")
    assert result is not None
    assert result["reason"] == "timeout"
    assert result["degraded"] is True  # no raise → terminal.create keeps going


def test_exec_error_degrades(fake_claude, monkeypatch):
    _run_raises(monkeypatch, OSError("Resource temporarily unavailable"))
    result = _probe_agent_cli_for_spawn("claude")
    assert result is not None
    assert result["reason"] == "exec_error"
    assert result["degraded"] is True


def test_missing_binary_still_blocks(monkeypatch):
    monkeypatch.setattr(app.shutil, "which", lambda _name: None)
    with pytest.raises(app.AgentCliProbeError) as ei:
        _probe_agent_cli_for_spawn("claude")
    assert ei.value.details["reason"] == "not_found"


def test_nonzero_exit_still_blocks(fake_claude, monkeypatch):
    _run_returns(monkeypatch, returncode=1, stdout="boom")
    with pytest.raises(app.AgentCliProbeError) as ei:
        _probe_agent_cli_for_spawn("claude")
    assert ei.value.details["reason"] == "nonzero_exit"


def test_healthy_probe_returns_version(fake_claude, monkeypatch):
    _run_returns(monkeypatch, returncode=0, stdout="2.1.205 (Claude Code)")
    result = _probe_agent_cli_for_spawn("claude")
    assert result is not None
    assert result.get("degraded") is not True
    assert result["version"] == "2.1.205"


def test_probe_timeout_is_aligned_to_eight_seconds():
    assert _SPAWN_PROBE_TIMEOUT_S == 8
