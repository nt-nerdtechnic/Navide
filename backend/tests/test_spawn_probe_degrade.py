"""Spawn probe degrades transient failures instead of blocking every CLI.

The pre-spawn `claude --version` probe used a 3s timeout and RAISED on timeout,
so a momentarily overloaded machine (swap storm) made every CLI unlaunchable
even though the binary was fine (a `--version` probe is ~40ms when idle). Now
timeout / exec-error degrade to a warning and let the spawn proceed; only
definitive failures (missing binary, nonzero exit) still block.
"""

import subprocess
import sys
import time
from pathlib import Path

import psutil
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
    """Make the launch seam resolve claude to a fake path so the probe runs."""
    monkeypatch.setattr(
        app.osplat.paths, "resolve_program", lambda _name, *, path=None: "/fake/bin/claude"
    )


def _run_returns(monkeypatch, *, returncode=0, stdout="2.1.205 (Claude Code)"):
    def run(command):
        return subprocess.CompletedProcess(command, returncode, stdout=stdout, stderr="")
    monkeypatch.setattr(app, "_run_spawn_probe", run)


def _run_raises(monkeypatch, exc):
    def run(_command):
        raise exc
    monkeypatch.setattr(app, "_run_spawn_probe", run)


def _probe_child(path):
    try:
        return psutil.Process(int(path.read_text(encoding="utf-8")))
    except psutil.NoSuchProcess:
        return None


def _wait_for_probe_child(monkeypatch, pid_file: Path):
    """Wait for the probe child to be observable before its timeout starts."""
    popen = app.subprocess.Popen

    def popen_and_wait(*args, **kwargs):
        proc = popen(*args, **kwargs)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                int(pid_file.read_text(encoding="utf-8"))
                break
            except (OSError, ValueError):
                time.sleep(0.01)
        else:
            proc.kill()
            proc.wait(timeout=5)
            raise AssertionError("probe child did not report its pid")
        return proc

    monkeypatch.setattr(app.subprocess, "Popen", popen_and_wait)


def _kill_probe_child(process):
    if process is None:
        return
    try:
        if process.is_running():
            process.kill()
    except psutil.NoSuchProcess:
        return
    _, still_alive = psutil.wait_procs([process], timeout=5)
    assert not still_alive


def test_timeout_degrades_and_lets_spawn_proceed(fake_claude, monkeypatch):
    _run_raises(monkeypatch, subprocess.TimeoutExpired(cmd="claude", timeout=8))
    result = _probe_agent_cli_for_spawn("claude", "claude --resume abc")
    assert result is not None
    assert result["reason"] == "timeout"
    assert result["degraded"] is True  # no raise → terminal.create keeps going


def test_timeout_kills_probe_descendants(tmp_path, monkeypatch):
    """A timed-out probe must not leave its child alive."""
    child_pid_file = tmp_path / "child.pid"
    shim = [
        sys.executable,
        "-u",
        "-c",
        "import subprocess, sys, time; "
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(5)']); "
        "open(sys.argv[1], 'w').write(str(child.pid)); time.sleep(5)",
        str(child_pid_file),
    ]
    monkeypatch.setattr(app, "_SPAWN_PROBE_TIMEOUT_S", 0.5)
    monkeypatch.setattr(
        app.osplat.paths, "resolve_program", lambda _name, *, path=None: sys.executable
    )
    monkeypatch.setattr(app.osplat.paths, "launch_argv", lambda _exe, _args: shim)
    _wait_for_probe_child(monkeypatch, child_pid_file)

    started = time.monotonic()
    result = _probe_agent_cli_for_spawn("claude")
    elapsed = time.monotonic() - started

    child = _probe_child(child_pid_file)
    try:
        assert result is not None and result["reason"] == "timeout"
        assert elapsed < 3, "probe timeout waited for the child's inherited output pipe"
        deadline = time.monotonic() + 2
        while child is not None and child.is_running() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert child is None or not child.is_running()
    finally:
        _kill_probe_child(child)


def test_timeout_still_degrades_if_tree_cleanup_fails(tmp_path, monkeypatch, caplog):
    child_pid_file = tmp_path / "child.pid"
    shim = [
        sys.executable,
        "-u",
        "-c",
        "import subprocess, sys, time; "
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(5)']); "
        "open(sys.argv[1], 'w').write(str(child.pid)); time.sleep(5)",
        str(child_pid_file),
    ]
    monkeypatch.setattr(app, "_SPAWN_PROBE_TIMEOUT_S", 0.5)
    monkeypatch.setattr(app, "_SPAWN_PROBE_CLEANUP_TIMEOUT_S", 0.25)
    monkeypatch.setattr(
        app.osplat.paths, "resolve_program", lambda _name, *, path=None: sys.executable
    )
    monkeypatch.setattr(app.osplat.paths, "launch_argv", lambda _exe, _args: shim)
    _wait_for_probe_child(monkeypatch, child_pid_file)

    def fail_tree_cleanup(_pid, *, force):
        raise OSError("simulated tree cleanup failure")

    monkeypatch.setattr(app.osplat.process_tree, "kill_tree", fail_tree_cleanup)
    started = time.monotonic()
    result = _probe_agent_cli_for_spawn("claude")
    elapsed = time.monotonic() - started

    child = _probe_child(child_pid_file)
    try:
        assert result is not None and result["reason"] == "timeout"
        assert elapsed < 3, "failed tree cleanup delayed the timed probe"
        assert child is not None and child.is_running()
        assert "simulated tree cleanup failure" in caplog.text
    finally:
        _kill_probe_child(child)


def test_exec_error_degrades(fake_claude, monkeypatch):
    _run_raises(monkeypatch, OSError("Resource temporarily unavailable"))
    result = _probe_agent_cli_for_spawn("claude")
    assert result is not None
    assert result["reason"] == "exec_error"
    assert result["degraded"] is True


def test_missing_binary_degrades_and_lets_the_shell_try(monkeypatch):
    """The probe reads the backend's PATH; the pane runs an interactive login
    shell, which reads the rc files that put nvm/volta/npm-global on PATH. A
    miss here is a hint, not a verdict — blocking made every `npm install -g`
    CLI unlaunchable on a macOS box whose login-shell probe had timed out."""
    monkeypatch.setattr(
        app.osplat.paths, "resolve_program", lambda _name, *, path=None: None
    )
    result = _probe_agent_cli_for_spawn("claude")
    assert result is not None
    assert result["reason"] == "not_found"
    assert result["degraded"] is True
    assert result["binary_path"] == ""  # nothing resolved, so nothing to report


@pytest.mark.parametrize("command", [
    ["/bin/zsh", "-ilc", "claude --version"],   # AiCliDock, POSIX agent pane
    ["/bin/bash", "-lc", "claude resume abc"],  # same, non-zsh login shell
])
def test_shell_wrapped_spawns_degrade(monkeypatch, command):
    """argv[0] is the shell, which resolves the name again against rc files
    this process never read — so the miss is a hint, not a verdict."""
    monkeypatch.setattr(
        app.osplat.paths, "resolve_program", lambda _name, *, path=None: None
    )
    result = _probe_agent_cli_for_spawn("claude", command)
    assert result is not None and result["degraded"] is True


@pytest.mark.parametrize("command", [
    ["claude", "--dangerously-skip-permissions"],  # plugin ai.cli.start argv
    "claude --dangerously-skip-permissions",       # Windows agent pane string
])
def test_direct_exec_spawns_still_block(monkeypatch, command):
    """No shell stands between the spawn and the CLI on these two paths, so
    nothing will re-resolve the name — the miss IS the verdict. Degrading here
    would only hand the user terminals.create's bare FileNotFoundError in
    place of an error naming the CLI and the probe command."""
    monkeypatch.setattr(
        app.osplat.paths, "resolve_program", lambda _name, *, path=None: None
    )
    with pytest.raises(app.AgentCliProbeError) as ei:
        _probe_agent_cli_for_spawn("claude", command)
    assert ei.value.details["reason"] == "not_found"
    assert ei.value.details["probe_command"] == ["claude", "--version"]


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
