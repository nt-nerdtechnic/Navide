"""The backend dies with the app on POSIX.

Electron names itself in AGENT_TEAM_PARENT_PID; the backend polls that pid and
takes the same cooperative exit as the stdin `shutdown` line when it is gone.
Found the hard way: a SIGTERMed Electron on Ubuntu left both backend processes
running, reparented to PID 1, and the next launch started a second backend
beside them.
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


def test_windows_leaves_it_to_the_job_object() -> None:
    assert _windows.WindowsProcessTree().parent_to_follow({"AGENT_TEAM_PARENT_PID": "4242"}) is None


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


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX only: Windows ties the backend to the app with a Job Object")
def test_a_backend_whose_parent_dies_exits_by_itself(tmp_path) -> None:
    """The whole chain: a stand-in parent spawns the real backend with its own
    pid in AGENT_TEAM_PARENT_PID, gets killed, and the backend must be gone
    within the poll interval plus uvicorn's shutdown."""
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
        if parent.poll() is None:
            parent.kill()
        try:
            os.kill(backend_pid, 9)  # only reached when the assertion above failed
        except (ProcessLookupError, NameError):
            pass
