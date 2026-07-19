"""Tests for reaping breakaway grandchildren on pane kill.

A PTY child is spawned with start_new_session=True, so kill() uses
killpg(child_pgid) to take down the child and everything in its group. But a
grandchild that calls setsid() starts its OWN session/group and escapes that
killpg — it outlives the pane and accumulates as an orphan (observed: dozens of
leftover `claude` processes exhausting RAM). _descendant_pids snapshots the
tree before close; _kill_breakaway SIGKILLs whatever the group kill missed.
"""

import os
import signal
import subprocess
import sys
import time

import pytest

from agent_team_backend import terminals
from agent_team_backend.terminals import _descendant_pids, _kill_breakaway


# ---- _descendant_pids: tree parsing (pure, mocked ps) ----

def _fake_ps(table: str):
    """Return a stub for subprocess.run that yields `table` as ps stdout."""
    def run(cmd, **kwargs):
        return subprocess.CompletedProcess(cmd, 0, stdout=table, stderr="")
    return run


def test_descendant_pids_collects_whole_subtree(monkeypatch):
    # tree: 100 → 200 → 300, 100 → 201, and unrelated 999 → 998
    table = "100 1\n200 100\n300 200\n201 100\n999 1\n998 999\n"
    monkeypatch.setattr(terminals.subprocess, "run", _fake_ps(table))
    assert sorted(_descendant_pids(100)) == [200, 201, 300]
    # unrelated root only sees its own branch
    assert sorted(_descendant_pids(999)) == [998]
    # leaf has no descendants
    assert _descendant_pids(300) == []


def test_descendant_pids_survives_cycle_and_garbage(monkeypatch):
    # a recycled-pid cycle (100→200→100) must not loop forever; junk lines skipped
    table = "100 1\n200 100\n100 200\nBAD LINE\n\n201 100\n"
    monkeypatch.setattr(terminals.subprocess, "run", _fake_ps(table))
    out = sorted(_descendant_pids(100))
    assert out == [200, 201]


def test_descendant_pids_returns_empty_when_ps_fails(monkeypatch):
    def boom(*a, **k):
        raise OSError("no ps")
    monkeypatch.setattr(terminals.subprocess, "run", boom)
    assert _descendant_pids(100) == []


# ---- _kill_breakaway: signalling (mocked os.kill) ----

def test_kill_breakaway_sigkills_each_pid(monkeypatch):
    killed = []
    monkeypatch.setattr(terminals.os, "kill", lambda pid, sig: killed.append((pid, sig)))
    _kill_breakaway([11, 22, 33])
    assert killed == [(11, signal.SIGKILL), (22, signal.SIGKILL), (33, signal.SIGKILL)]


def test_kill_breakaway_ignores_already_dead(monkeypatch):
    def kill(pid, sig):
        if pid == 22:
            raise ProcessLookupError
        if pid == 33:
            raise PermissionError
    monkeypatch.setattr(terminals.os, "kill", kill)
    # must not raise
    _kill_breakaway([11, 22, 33])


# ---- integration: a real setsid grandchild ----

def _alive(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


@pytest.mark.skipif(not hasattr(os, "setsid"), reason="needs POSIX setsid")
def test_breakaway_grandchild_is_reaped_end_to_end():
    # Parent sh backgrounds a python grandchild that setsid()s away from sh's
    # process group, then sleeps. killpg(sh) misses it; _kill_breakaway must not.
    grand_script = "import os, time; os.setsid(); print('ready', flush=True); time.sleep(30)"
    parent = subprocess.Popen(
        ["sh", "-c", f'{sys.executable} -c "{grand_script}" & echo $!; wait'],
        stdout=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    grand_pid = None
    try:
        grand_pid = int(parent.stdout.readline().strip())
        # Wait until the grandchild has actually broken away into its own group.
        deadline = time.time() + 5
        while time.time() < deadline:
            try:
                if os.getpgid(grand_pid) == grand_pid != os.getpgid(parent.pid):
                    break
            except ProcessLookupError:
                pass
            time.sleep(0.02)
        assert os.getpgid(grand_pid) == grand_pid, "grandchild never broke away"

        # Snapshot from the still-alive parent — ancestry intact.
        descendants = _descendant_pids(parent.pid)
        assert grand_pid in descendants

        # The group kill takes the parent but NOT the breakaway grandchild.
        os.killpg(os.getpgid(parent.pid), signal.SIGKILL)
        parent.wait(timeout=2)
        time.sleep(0.1)
        assert _alive(grand_pid), "grandchild should survive the group kill (that's the bug)"

        # The breakaway reaper closes the gap.
        _kill_breakaway(descendants)
        deadline = time.time() + 2
        while _alive(grand_pid) and time.time() < deadline:
            time.sleep(0.02)
        assert not _alive(grand_pid), "grandchild must be reaped by _kill_breakaway"
    finally:
        for pid in filter(None, [grand_pid, parent.pid]):
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
        try:
            parent.wait(timeout=2)
        except Exception:
            pass
