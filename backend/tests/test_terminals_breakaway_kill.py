"""Tests for reaping breakaway grandchildren on pane kill.

A PTY child is spawned with start_new_session=True, so kill() uses
killpg(child_pgid) to take down the child and everything in its group. But a
grandchild that calls setsid() starts its OWN session/group and escapes that
killpg — it outlives the pane and accumulates as an orphan (observed: dozens of
leftover `claude` processes exhausting RAM). _descendant_pids snapshots the
tree before close; _kill_breakaway SIGKILLs whatever the group kill missed.

The setsid-grandchild harness and ps stubs are shared with
test_terminals_exit_orphan_reap.py via conftest fixtures.
"""

import os
import signal
import time

import pytest

from agent_team_backend import terminals
from agent_team_backend.terminals import _descendant_pids, _kill_breakaway


# ---- _descendant_pids: tree parsing (pure, mocked ps) ----

def test_descendant_pids_collects_whole_subtree(monkeypatch, fake_ps):
    # columns: pid ppid pgid — tree: 100 → 200 → 300, 100 → 201, and 999 → 998
    table = "100 1 100\n200 100 100\n300 200 300\n201 100 100\n999 1 999\n998 999 999\n"
    monkeypatch.setattr(terminals.subprocess, "run", fake_ps(table))
    assert sorted(_descendant_pids(100)) == [200, 201, 300]
    # unrelated root only sees its own branch
    assert sorted(_descendant_pids(999)) == [998]
    # leaf has no descendants
    assert _descendant_pids(300) == []


def test_descendant_pids_survives_cycle_and_garbage(monkeypatch, fake_ps):
    # a recycled-pid cycle (100→200→100) must not loop forever; junk lines skipped
    table = "100 1 100\n200 100 100\n100 200 100\nBAD LINE\n\n201 100 100\n"
    monkeypatch.setattr(terminals.subprocess, "run", fake_ps(table))
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

@pytest.mark.skipif(not hasattr(os, "setsid"), reason="needs POSIX setsid")
def test_breakaway_grandchild_is_reaped_end_to_end(
    setsid_grandchild, pid_alive, wait_pid_dead
):
    parent, grand_pid = setsid_grandchild

    # Snapshot from the still-alive parent — ancestry intact.
    descendants = _descendant_pids(parent.pid)
    assert grand_pid in descendants

    # The group kill takes the parent but NOT the breakaway grandchild.
    os.killpg(os.getpgid(parent.pid), signal.SIGKILL)
    parent.wait(timeout=2)
    time.sleep(0.1)
    assert pid_alive(grand_pid), "grandchild should survive the group kill (that's the bug)"

    # The breakaway reaper closes the gap.
    _kill_breakaway(descendants)
    assert wait_pid_dead(grand_pid), "grandchild must be reaped by _kill_breakaway"
