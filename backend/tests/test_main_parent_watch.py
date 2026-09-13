"""The backend dies with the app, on every platform.

Electron names itself in AGENT_TEAM_PARENT_PID; the backend polls that pid and
takes the same cooperative exit as the stdin `shutdown` line when it is gone.
Found the hard way twice: a SIGTERMed Electron on Ubuntu left both backend
processes running, reparented to PID 1, and the next launch started a second
backend beside them — and later, on Windows, a Task-Manager kill of the app
left the backend and its CLI tree orphaned because that path trusted a Job
Object the app never actually created. Windows now follows the pid too, guarded
against its fast pid reuse by the parent's `identity` (pid + start time).
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time

import pytest

from agent_team_backend import osplat
from agent_team_backend.__main__ import _watch_parent_for_shutdown
from agent_team_backend.osplat import _posix, _windows


class _Server:
    should_exit = False


def test_posix_follows_the_pid_the_app_named() -> None:
    tree = _posix.PosixProcessTree()
    assert tree.parent_to_follow({"AGENT_TEAM_PARENT_PID": "4242"}) == 4242
    # Nobody spawned this backend from the app: nothing to follow.
    assert tree.parent_to_follow({}) is None
    assert tree.parent_to_follow({"AGENT_TEAM_PARENT_PID": ""}) is None
    assert tree.parent_to_follow({"AGENT_TEAM_PARENT_PID": "not-a-pid"}) is None
    assert tree.parent_to_follow({"AGENT_TEAM_PARENT_PID": "0"}) is None


def test_windows_follows_the_pid_the_app_named() -> None:
    tree = _windows.WindowsProcessTree()
    # No Job Object ties the backend to the app on Windows, so it follows the
    # named pid just like POSIX (it used to return None and orphan on a crash).
    assert tree.parent_to_follow({"AGENT_TEAM_PARENT_PID": "4242"}) == 4242
    assert tree.parent_to_follow({}) is None
    assert tree.parent_to_follow({"AGENT_TEAM_PARENT_PID": ""}) is None
    assert tree.parent_to_follow({"AGENT_TEAM_PARENT_PID": "not-a-pid"}) is None
    assert tree.parent_to_follow({"AGENT_TEAM_PARENT_PID": "0"}) is None


def test_a_reused_parent_pid_still_counts_as_gone() -> None:
    # Windows reuses pids fast: the parent can die and its number belong to
    # another process before the next poll, so a bare liveness check reads it as
    # alive. The identity (pid + start time) changes on reuse, and that must end
    # the watch just as a vanished pid does.
    server = _Server()
    identities = iter(["4242:START-A", "4242:START-A", "4242:START-B"])
    thread = threading.Thread(
        target=_watch_parent_for_shutdown,
        args=(server, 4242),
        kwargs={
            "interval_s": 0.05,
            "is_alive": lambda _pid: True,  # the pid is always "alive" (reused)
            "identity": lambda _pid: next(identities, "4242:START-B"),
        },
        daemon=True,
    )
    thread.start()
    thread.join(timeout=2)
    assert server.should_exit is True


def test_an_unreadable_parent_identity_falls_back_to_liveness() -> None:
    # If the parent's identity cannot be read at startup ("") the watch must not
    # exit on an empty match — it falls back to the liveness check alone.
    server = _Server()
    alive = {"value": True}
    thread = threading.Thread(
        target=_watch_parent_for_shutdown,
        args=(server, 4242),
        kwargs={
            "interval_s": 0.05,
            "is_alive": lambda _pid: alive["value"],
            "identity": lambda _pid: "",
        },
        daemon=True,
    )
    thread.start()
    time.sleep(0.2)
    assert server.should_exit is False  # empty identity does not trigger exit
    alive["value"] = False
    thread.join(timeout=2)
    assert server.should_exit is True


def test_the_watcher_takes_the_cooperative_exit_once_the_parent_is_gone() -> None:
    server = _Server()
    alive = {"value": True}
    thread = threading.Thread(
        target=_watch_parent_for_shutdown,
        args=(server, 4242),
        kwargs={"interval_s": 0.05, "is_alive": lambda _pid: alive["value"]},
        daemon=True,
    )
    thread.start()
    time.sleep(0.2)
    assert server.should_exit is False  # a live parent changes nothing
    alive["value"] = False
    thread.join(timeout=2)
    assert server.should_exit is True


def test_a_shutdown_from_elsewhere_ends_the_watcher() -> None:
    server = _Server()
    server.should_exit = True  # the stdin line got there first
    _watch_parent_for_shutdown(server, 4242, interval_s=0.05, is_alive=lambda _pid: True)


def test_a_backend_whose_parent_dies_exits_by_itself(tmp_path) -> None:
    """The whole chain, on every platform: a stand-in parent spawns the real
    backend with its own pid in AGENT_TEAM_PARENT_PID, gets killed, and the
    backend must be gone within the poll interval plus uvicorn's shutdown.
    Runs on Windows too now that the backend follows the pid there."""
    env = dict(os.environ, AGENT_TEAM_DATA_DIR=str(tmp_path))
    parent_script = (
        "import os, subprocess, sys, time\n"
        "child = subprocess.Popen(\n"
        "    [sys.executable, '-m', 'agent_team_backend', '--port', '0', '--log-level', 'warning'],\n"
        "    env=dict(os.environ, AGENT_TEAM_PARENT_PID=str(os.getpid())),\n"
        "    stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,\n"
        ")\n"
        "print(child.pid, flush=True)\n"
        "time.sleep(120)\n"
    )
    parent = subprocess.Popen(
        [sys.executable, "-c", parent_script], env=env, stdout=subprocess.PIPE, text=True
    )
    try:
        line = parent.stdout.readline() if parent.stdout else ""
        backend_pid = int(line.strip())
        # Let the backend get past its imports and into the server loop; the
        # port file is the first thing main() writes.
        deadline = time.monotonic() + 40
        while not (tmp_path / "backend-port").exists():
            assert time.monotonic() < deadline, "the backend never started"
            assert osplat.process_tree.is_alive(backend_pid), "the backend died before its parent did"
            time.sleep(0.2)
        time.sleep(1.0)
        assert osplat.process_tree.is_alive(backend_pid)

        parent.kill()
        parent.wait(timeout=10)

        deadline = time.monotonic() + 20
        while osplat.process_tree.is_alive(backend_pid):
            assert time.monotonic() < deadline, "the backend outlived its parent"
            time.sleep(0.25)
    finally:
        # Release our handle so the parent's pid is fully gone rather than a
        # handle-held zombie, the way it is in production once the app is gone.
        if parent.poll() is None:
            parent.kill()
            parent.wait(timeout=5)
        # Only a backend that outlived its parent is still here to kill. POSIX
        # raises ProcessLookupError for an already-dead pid; Windows raises
        # OSError (WinError 87) — catch both, or a passing run dies in cleanup.
        try:
            os.kill(backend_pid, 9)
        except (ProcessLookupError, NameError, OSError):
            pass


@pytest.mark.skipif(sys.platform != "win32", reason="Windows GetExitCodeProcess path")
def test_windows_is_alive_uses_the_exit_code_not_just_pid_exists() -> None:
    # A running process is alive; once it exits it is not — even in the window
    # where a held handle keeps its pid around. The hardened check asks the
    # kernel for the exit code rather than trusting pid_exists alone.
    import subprocess

    from agent_team_backend.osplat import _windows

    tree = _windows.WindowsProcessTree()
    proc = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        assert tree.is_alive(proc.pid) is True
        proc.kill()
        proc.wait(timeout=5)
        # The Popen object still holds a handle to the now-dead process here.
        assert tree.is_alive(proc.pid) is False
    finally:
        if proc.poll() is None:
            proc.kill()
