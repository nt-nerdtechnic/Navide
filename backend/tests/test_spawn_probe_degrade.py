"""Spawn probe degrades transient failures instead of blocking every CLI.

The pre-spawn `claude --version` probe used a 3s timeout and RAISED on timeout,
so a momentarily overloaded machine (swap storm) made every CLI unlaunchable
even though the binary was fine (a `--version` probe is ~40ms when idle). Now
timeout / exec-error degrade to a warning and let the spawn proceed; only
definitive failures (missing binary, nonzero exit) still block.

The probe also has to survive a CLI (or a descendant it leaves behind) that
never closes its output pipes. `subprocess.run(capture_output=True, timeout=…)`
does not: on Windows its timeout branch drains the pipes again with no
deadline, wedging the probe's executor worker forever. `_run_spawn_probe`
bounds both the reads and the reap, and kills the process tree on every exit
path.
"""

import logging
import signal
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

#: A budget small enough to keep the suite fast, long enough for a python shim
#: to start on a loaded CI runner.
_PROBE_TEST_BUDGET_S = 0.5
#: The probe must return well under this even when its tree kill is sabotaged.
_PROBE_TEST_CEILING_S = 5.0


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


def _point_probe_at_shim(monkeypatch, shim: list[str]) -> None:
    """Run the probe's resolved CLI through a python shim instead."""
    monkeypatch.setattr(
        app.osplat.paths, "resolve_program", lambda _name, *, path=None: sys.executable
    )
    monkeypatch.setattr(app.osplat.paths, "launch_argv", lambda _exe, _args: shim)
    monkeypatch.setattr(app, "_SPAWN_PROBE_TIMEOUT_S", _PROBE_TEST_BUDGET_S)


def _wait_for_pid_file(monkeypatch, pid_file: Path) -> None:
    """Start the probe's timeout only once the shim reported its descendant.

    The probe clock starts after `Popen` returns, so if the shim has not yet
    spawned the process whose pipe it holds, the probe could time out before
    the scenario it is meant to exercise even exists.
    """
    real_popen = app.subprocess.Popen

    def popen_and_wait(*args, **kwargs):
        proc = real_popen(*args, **kwargs)
        command = args[0] if args else kwargs.get("args")
        if not isinstance(command, (list, tuple)) or str(pid_file) not in command:
            return proc  # not the shim: never delay some other spawn
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            try:
                int(pid_file.read_text(encoding="utf-8"))
                return proc
            except (OSError, ValueError):
                time.sleep(0.01)
        proc.kill()
        proc.wait(timeout=5)
        raise AssertionError("probe shim did not report its descendant pid")

    monkeypatch.setattr(app.subprocess, "Popen", popen_and_wait)


def _process(pid_file: Path) -> psutil.Process | None:
    try:
        return psutil.Process(int(pid_file.read_text(encoding="utf-8")))
    except (psutil.NoSuchProcess, OSError, ValueError):
        return None


def _assert_dead(process: psutil.Process | None, timeout: float = 5.0) -> None:
    if process is None:
        return
    try:
        process.wait(timeout=timeout)
    except psutil.TimeoutExpired:
        pytest.fail(f"probe left process {process.pid} running")
    except psutil.NoSuchProcess:
        pass


def _reap(process: psutil.Process | None) -> None:
    """Test-side cleanup, so a failing assertion cannot strand a process."""
    if process is None:
        return
    try:
        if process.is_running():
            process.kill()
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return
    try:
        psutil.wait_procs([process], timeout=5)
    except psutil.Error:
        pass


def test_timeout_degrades_and_lets_spawn_proceed(fake_claude, monkeypatch):
    _run_raises(monkeypatch, subprocess.TimeoutExpired(cmd="claude", timeout=8))
    result = _probe_agent_cli_for_spawn("claude", "claude --resume abc")
    assert result is not None
    assert result["reason"] == "timeout"
    assert result["degraded"] is True  # no raise → terminal.create keeps going


def test_probe_returns_when_a_descendant_holds_the_pipe_open(tmp_path, monkeypatch):
    """A CLI that leaves a helper inheriting its stdout must not wedge the probe.

    This is the shape that hangs `subprocess.run` on Windows: the direct child
    exits (or is killed), but the helper keeps the pipe write end open, so the
    timeout branch's un-deadlined second `communicate()` never returns. The
    bounded runner kills the tree — which closes the pipe — and returns.
    """
    descendant_pid = tmp_path / "descendant.pid"
    shim = [
        sys.executable, "-u", "-c",
        "import subprocess, sys, time\n"
        "helper = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])\n"
        "open(sys.argv[1], 'w').write(str(helper.pid))\n"
        "time.sleep(30)\n",
        str(descendant_pid),
    ]
    _point_probe_at_shim(monkeypatch, shim)
    _wait_for_pid_file(monkeypatch, descendant_pid)

    started = time.monotonic()
    result = _probe_agent_cli_for_spawn("claude")
    elapsed = time.monotonic() - started

    descendant = _process(descendant_pid)
    try:
        assert result is not None and result["reason"] == "timeout"
        assert result["degraded"] is True
        assert elapsed < _PROBE_TEST_CEILING_S, "probe waited on a pipe a descendant held open"
        _assert_dead(descendant)
    finally:
        _reap(descendant)


def test_probe_kills_a_child_that_ignores_termination(tmp_path, monkeypatch):
    """A CLI that ignores the graceful signal must still be killed and reaped."""
    child_pid = tmp_path / "child.pid"
    shim = [
        sys.executable, "-u", "-c",
        "import os, signal, sys, time\n"
        "if hasattr(signal, 'SIGTERM'):\n"
        "    signal.signal(signal.SIGTERM, signal.SIG_IGN)\n"
        "open(sys.argv[1], 'w').write(str(os.getpid()))\n"
        "time.sleep(30)\n",
        str(child_pid),
    ]
    _point_probe_at_shim(monkeypatch, shim)
    _wait_for_pid_file(monkeypatch, child_pid)

    started = time.monotonic()
    result = _probe_agent_cli_for_spawn("claude")
    elapsed = time.monotonic() - started

    child = _process(child_pid)
    try:
        assert result is not None and result["reason"] == "timeout"
        assert elapsed < _PROBE_TEST_CEILING_S, "a SIGTERM-ignoring child pinned the probe"
        _assert_dead(child)
    finally:
        _reap(child)


def test_probe_still_returns_when_tree_cleanup_fails(tmp_path, monkeypatch, caplog):
    """A failed tree kill must not turn the probe into an unbounded wait."""
    descendant_pid = tmp_path / "descendant.pid"
    shim = [
        sys.executable, "-u", "-c",
        "import subprocess, sys, time\n"
        "helper = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])\n"
        "open(sys.argv[1], 'w').write(str(helper.pid))\n"
        "time.sleep(30)\n",
        str(descendant_pid),
    ]
    _point_probe_at_shim(monkeypatch, shim)
    monkeypatch.setattr(app, "_SPAWN_PROBE_CLEANUP_TIMEOUT_S", 0.25)

    def fail_tree_cleanup(_pid, *, force):
        raise OSError("simulated tree cleanup failure")

    monkeypatch.setattr(app.osplat.process_tree, "kill_group", fail_tree_cleanup)
    _wait_for_pid_file(monkeypatch, descendant_pid)

    started = time.monotonic()
    with caplog.at_level(logging.WARNING):
        result = _probe_agent_cli_for_spawn("claude")
    elapsed = time.monotonic() - started

    descendant = _process(descendant_pid)
    try:
        assert result is not None and result["reason"] == "timeout"
        assert elapsed < _PROBE_TEST_CEILING_S, "failed tree cleanup delayed the timed probe"
        assert "simulated tree cleanup failure" in caplog.text
    finally:
        # The fallback killed the direct child; the helper is the test's to reap.
        _reap(descendant)


def test_spawn_probe_isolates_stdin_and_its_own_session(monkeypatch):
    """The probe must not inherit the backend's stdin, nor its process group."""
    captured: dict[str, object] = {}

    class _FakePipe:
        def read(self, _n: int) -> str:
            return ""

        def close(self) -> None:
            pass

    class _FakeProc:
        pid = 4242
        returncode = 0
        stdout = _FakePipe()
        stderr = _FakePipe()

        def wait(self, timeout=None):
            return 0

        def kill(self) -> None:
            pass

    def popen(command, **kwargs):
        captured["command"] = command
        captured.update(kwargs)
        return _FakeProc()

    monkeypatch.setattr(app.subprocess, "Popen", popen)
    result = app._run_spawn_probe(["claude", "--version"])

    assert captured["stdin"] is subprocess.DEVNULL
    assert captured["stdout"] is subprocess.PIPE
    assert captured["stderr"] is subprocess.PIPE
    # POSIX: kill_group on the probe can never reach the backend's group.
    assert captured["start_new_session"] is True
    assert result.returncode == 0 and result.stdout == ""


def test_spawn_probe_reads_a_real_command():
    """The bounded runner still returns a normal command's exit and output."""
    result = app._run_spawn_probe(
        [sys.executable, "-c", "print('2.1.205 (Claude Code)')"]
    )
    assert result.returncode == 0
    assert "2.1.205 (Claude Code)" in result.stdout


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
