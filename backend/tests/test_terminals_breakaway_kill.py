"""Tests for reaping breakaway grandchildren on pane kill.

A PTY child is spawned with start_new_session=True, so kill() uses
killpg(child_pgid) to take down the child and everything in its group. But a
grandchild that calls setsid() starts its OWN session/group and escapes that
killpg — it outlives the pane and accumulates as an orphan (observed: dozens of
leftover `claude` processes exhausting RAM). _descendant_pids snapshots the
tree before close (pid -> start-time identity); _kill_breakaway SIGKILLs
whatever the group kill missed, but only pids that are still the recorded
process — a pid recycled in between belongs to someone else.

The setsid-grandchild harness and ps stubs are shared with
test_terminals_exit_orphan_reap.py via conftest fixtures.
"""

import os
import signal
import time

import pytest

from agent_team_backend import terminals
from agent_team_backend.osplat import _posix
from agent_team_backend.terminals import _descendant_pids, _kill_breakaway


# ---- _descendant_pids: tree parsing (pure, mocked ps) ----
# _descendant_pids delegates to whichever tree osplat wired for the host; the
# ps-table parser under test is the POSIX one, so it is driven directly.

def test_descendant_pids_collects_whole_subtree(monkeypatch, fake_ps):
    # columns: pid ppid pgid — tree: 100 → 200 → 300, 100 → 201, and 999 → 998
    table = "100 1 100\n200 100 100\n300 200 300\n201 100 100\n999 1 999\n998 999 999\n"
    monkeypatch.setattr(_posix.subprocess, "run", fake_ps(table))
    assert sorted(_posix.process_tree.descendants(100)) == [200, 201, 300]
    # unrelated root only sees its own branch
    assert sorted(_posix.process_tree.descendants(999)) == [998]
    # leaf has no descendants
    assert _posix.process_tree.descendants(300) == []


def test_descendant_pids_survives_cycle_and_garbage(monkeypatch, fake_ps):
    # a recycled-pid cycle (100→200→100) must not loop forever; junk lines skipped
    table = "100 1 100\n200 100 100\n100 200 100\nBAD LINE\n\n201 100 100\n"
    monkeypatch.setattr(_posix.subprocess, "run", fake_ps(table))
    out = sorted(_posix.process_tree.descendants(100))
    assert out == [200, 201]


def test_descendant_pids_returns_empty_when_ps_fails(monkeypatch):
    def boom(*a, **k):
        raise OSError("no ps")
    monkeypatch.setattr(terminals.subprocess, "run", boom)
    assert _descendant_pids(100) == {}


def test_descendant_pids_records_each_start_time_identity(monkeypatch):
    # pid -> (ppid, pgid, start): 100 → 200 → 300, and an unrelated 999
    snap = {
        100: (1, 100, "L100"),
        200: (100, 100, "L200"),
        300: (200, 300, "L300"),
        999: (1, 999, "L999"),
    }
    monkeypatch.setattr(terminals, "_ps_snapshot", lambda: snap)
    assert _descendant_pids(100) == {200: "L200", 300: "L300"}


# ---- _kill_breakaway: signalling ----
# Which pids get signalled is platform-neutral, but HOW they are signalled is
# not: POSIX goes through `os.kill`, Windows through psutil. A test about the
# choice of pids therefore stubs the seam (`process_tree.kill`), and only the
# one test that is about SIGKILL itself stubs `os.kill` — and skips elsewhere.

@pytest.mark.skipif(not hasattr(signal, "SIGKILL"), reason="POSIX SIGKILL via os.kill")
def test_kill_breakaway_sigkills_each_pid(monkeypatch):
    killed = []
    monkeypatch.setattr(terminals.os, "kill", lambda pid, sig: killed.append((pid, sig)))
    monkeypatch.setattr(
        terminals, "_ps_snapshot",
        lambda: {11: (1, 11, "L11"), 22: (1, 22, "L22"), 33: (1, 33, "L33")},
    )
    _kill_breakaway({11: "L11", 22: "L22", 33: "L33"})
    assert killed == [(11, signal.SIGKILL), (22, signal.SIGKILL), (33, signal.SIGKILL)]


def test_kill_breakaway_ignores_already_dead(monkeypatch):
    def kill(pid, *, force):
        if pid == 22:
            raise ProcessLookupError
        if pid == 33:
            raise PermissionError
    monkeypatch.setattr(terminals.osplat.process_tree, "kill", kill)
    monkeypatch.setattr(
        terminals, "_ps_snapshot",
        lambda: {11: (1, 11, "L11"), 22: (1, 22, "L22"), 33: (1, 33, "L33")},
    )
    # must not raise
    _kill_breakaway({11: "L11", 22: "L22", 33: "L33"})


def test_kill_breakaway_spares_a_recycled_or_unverifiable_pid(monkeypatch):
    killed = []
    monkeypatch.setattr(
        terminals.osplat.process_tree, "kill",
        lambda pid, *, force: killed.append(pid),
    )
    monkeypatch.setattr(
        terminals, "_ps_snapshot",
        lambda: {
            11: (1, 11, "L11"),        # same process — killed
            22: (1, 22, "L22-new"),    # pid recycled since the snapshot
            33: (1, 33, ""),           # identity unreadable now
            44: (1, 44, "L44"),        # identity unreadable at snapshot time
            # 55 is gone from the table
        },
    )
    _kill_breakaway({11: "L11", 22: "L22", 33: "L33", 44: "", 55: "L55"})
    assert killed == [11]


def test_kill_breakaway_kills_nothing_when_the_snapshot_fails(monkeypatch):
    killed = []
    monkeypatch.setattr(
        terminals.osplat.process_tree, "kill",
        lambda pid, *, force: killed.append(pid),
    )
    monkeypatch.setattr(terminals, "_ps_snapshot", lambda: {})
    _kill_breakaway({11: "L11"})
    assert killed == []


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
