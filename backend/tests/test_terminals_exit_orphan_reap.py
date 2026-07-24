"""Tests for reaping orphans after a PTY child dies on its own.

kill() (pane close) snapshots the descendant tree while the child is alive and
sweeps breakaway grandchildren. But when the child dies by itself — crash,
external SIGKILL — the EOF path runs _close with no sweep, and grandchildren
that live in their own process group (e.g. MCP servers a CLI spawns detached)
leak as orphans (observed: `npm exec @upstash/context7-mcp` pairs reparented to
the backend, surviving for days). The fix: a rolling per-session descendant
snapshot (pid -> lstart) plus _reap_exit_orphans, which kills snapshot pids
that are now orphaned (reparented to launchd or this process), identity-checked
via lstart to defeat pid recycling, along with their current subtrees.

The setsid-grandchild harness and ps stubs are shared with
test_terminals_breakaway_kill.py via conftest fixtures.
"""
from __future__ import annotations

import asyncio
import os
import signal
import time
from typing import Any

import pytest

from agent_team_backend import terminals
from agent_team_backend.terminals import (
    TerminalService,
    _children_map,
    _ps_snapshot,
    _walk_descendants,
)


async def _noop_emit(event: dict[str, Any]) -> None:
    return None


# ---- _ps_snapshot: parsing ----

def test_ps_snapshot_parses_lstart_and_skips_garbage(monkeypatch, fake_ps):
    table = "100 1 Thu Jul 24 10:05:00 2026\n200 100 Thu Jul 24 10:05:03 2026\nBAD\n\n300 200\n"
    monkeypatch.setattr(terminals.subprocess, "run", fake_ps(table))
    assert _ps_snapshot() == {
        100: (1, "Thu Jul 24 10:05:00 2026"),
        200: (100, "Thu Jul 24 10:05:03 2026"),
        300: (200, ""),
    }


def test_ps_snapshot_empty_on_failure(monkeypatch):
    def boom(*a, **k):
        raise OSError("no ps")
    monkeypatch.setattr(terminals.subprocess, "run", boom)
    assert _ps_snapshot() == {}


# ---- _refresh_descendants: rolling snapshot ----

async def test_refresh_descendants_updates_live_sessions():
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(pane_id="p1", agent_key=None, command=["sleep", "30"], cwd="/")
    try:
        pid = session.proc.pid
        # tree: child -> 900 -> 901, unrelated 999
        snap = {
            pid: (os.getpid(), "L-child"),
            900: (pid, "L900"),
            901: (900, "L901"),
            999: (1, "L999"),
        }
        svc._refresh_descendants(snap)
        assert session.descendants == {900: "L900", 901: "L901"}
    finally:
        await svc.kill_all(grace=0.3)


async def test_refresh_keeps_last_snapshot_on_ps_failure_or_missing_root():
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(pane_id="p1", agent_key=None, command=["sleep", "30"], cwd="/")
    try:
        pid = session.proc.pid
        svc._refresh_descendants({pid: (os.getpid(), "L"), 900: (pid, "L900")})
        assert session.descendants == {900: "L900"}
        # ps failure ({}) must not wipe the good snapshot.
        svc._refresh_descendants({})
        assert session.descendants == {900: "L900"}
        # Child absent from the table (death racing EOF) — keep the snapshot.
        svc._refresh_descendants({999: (1, "L999")})
        assert session.descendants == {900: "L900"}
    finally:
        await svc.kill_all(grace=0.3)


# ---- _reap_exit_orphans: orphan check + lstart identity + subtree kill ----

async def test_reap_kills_orphaned_snapshot_pids_and_their_subtree(monkeypatch):
    svc = TerminalService(emit=_noop_emit)
    me = os.getpid()
    # Snapshot was {200, 300, 400}. Now: 200 reparented to launchd with a
    # fresh child 250; 300 reparented to this backend; 400 still has a live
    # parent (555) — must be spared, as must unrelated 999.
    snap = {
        200: (1, "L200"),
        250: (200, "L250"),
        300: (me, "L300"),
        400: (555, "L400"),
        555: (1, "L555"),
        999: (1, "L999"),
    }
    monkeypatch.setattr(terminals, "_ps_snapshot", lambda: snap)
    killed: list[int] = []
    monkeypatch.setattr(
        terminals, "_kill_breakaway", lambda pids: killed.extend(pids)
    )
    await svc._reap_exit_orphans({200: "L200", 300: "L300", 400: "L400"}, grace=0)
    assert sorted(killed) == [200, 250, 300]


async def test_reap_spares_recycled_pid_via_lstart_mismatch(monkeypatch):
    svc = TerminalService(emit=_noop_emit)
    # pid 200 was recycled: same number, launchd-parented, different lstart.
    snap = {200: (1, "L-new-process")}
    monkeypatch.setattr(terminals, "_ps_snapshot", lambda: snap)
    killed: list[int] = []
    monkeypatch.setattr(
        terminals, "_kill_breakaway", lambda pids: killed.extend(pids)
    )
    await svc._reap_exit_orphans({200: "L-original"}, grace=0)
    assert killed == []


async def test_reap_noop_when_ps_fails(monkeypatch):
    svc = TerminalService(emit=_noop_emit)
    monkeypatch.setattr(terminals, "_ps_snapshot", lambda: {})
    killed: list[int] = []
    monkeypatch.setattr(
        terminals, "_kill_breakaway", lambda pids: killed.extend(pids)
    )
    await svc._reap_exit_orphans({200: "L200"}, grace=0)
    assert killed == []


# ---- _close wiring: only natural-death reasons trigger the reaper ----

async def test_close_schedules_reap_on_exit_but_not_on_kill(monkeypatch):
    reaped: list[list[int]] = []

    async def fake_reap(self, descendants, grace=0):
        reaped.append(list(descendants))

    monkeypatch.setattr(TerminalService, "_reap_exit_orphans", fake_reap)

    svc = TerminalService(emit=_noop_emit)
    # Natural exit: short-lived child, snapshot pre-seeded.
    s1 = svc.create(pane_id="p1", agent_key=None, command=["sh", "-c", "exit 0"], cwd="/")
    s1.descendants = {111: ""}
    for _ in range(100):
        if s1.closed:
            break
        await asyncio.sleep(0.05)
    assert s1.closed
    await asyncio.sleep(0.05)  # let the scheduled reap task run
    assert reaped == [[111]]

    # kill() path: must NOT schedule the exit reaper (it sweeps on its own).
    s2 = svc.create(pane_id="p2", agent_key=None, command=["sleep", "30"], cwd="/")
    s2.descendants = {222: ""}
    svc.kill(s2.id, force=True)
    await asyncio.sleep(0.2)
    assert reaped == [[111]]
    await svc.kill_all(grace=0.3)


# ---- integration: a real detached grandchild orphaned by parent death ----

@pytest.mark.skipif(not hasattr(os, "setsid"), reason="needs POSIX setsid")
async def test_exit_orphan_reaped_end_to_end(
    setsid_grandchild, pid_alive, wait_pid_dead
):
    # SIGKILL the parent (simulating a CLI crash — no kill() sweep runs): the
    # setsid grandchild is orphaned. _reap_exit_orphans with the pre-death
    # snapshot must take it down (real lstart identities match).
    parent, grand_pid = setsid_grandchild

    # Rolling snapshot (with real lstart) taken while the parent lives.
    snap = _ps_snapshot()
    pids = _walk_descendants(_children_map(snap), parent.pid)
    descendants = {pid: snap[pid][1] for pid in pids}
    assert grand_pid in descendants

    # Parent dies ungracefully; grandchild survives as an orphan.
    os.killpg(os.getpgid(parent.pid), signal.SIGKILL)
    parent.wait(timeout=2)
    time.sleep(0.1)
    assert pid_alive(grand_pid), "grandchild should survive the parent's death"

    svc = TerminalService(emit=_noop_emit)
    await svc._reap_exit_orphans(descendants, grace=0.1)
    assert wait_pid_dead(grand_pid), "orphan must be reaped by _reap_exit_orphans"
