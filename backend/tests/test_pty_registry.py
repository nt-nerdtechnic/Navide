"""Startup orphan reaper: PTY children recorded on spawn must be reaped by the
next backend start when the previous run died without its shutdown sweep.

Identity is pid + ps lstart (survives the shell's exec of the final command
and defeats pid recycling); entries owned by a live sibling backend are left
untouched."""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
from typing import Any

import pytest

from agent_team_backend import pty_registry
from agent_team_backend.terminals import TerminalService


def _registry() -> dict:
    return json.loads(pty_registry._registry_path().read_text(encoding="utf-8"))


def _set_owner(pid: int, owner: int) -> None:
    """Rewrite an entry's owner so reap treats the recording backend as dead
    (pid 1 = launchd: alive but not an agent_team_backend process)."""
    entries = _registry()
    entries[str(pid)]["owner"] = owner
    pty_registry._save(entries)


def test_register_unregister_roundtrip() -> None:
    proc = subprocess.Popen(["sleep", "30"], start_new_session=True)
    try:
        pty_registry.register(proc.pid, ["sleep", "30"])
        entry = _registry()[str(proc.pid)]
        assert entry["argv0"] == "sleep"
        assert entry["lstart"]
        assert entry["owner"] == os.getpid()
        pty_registry.unregister(proc.pid)
        assert _registry() == {}
    finally:
        proc.kill()
        proc.wait()


def test_reap_kills_recorded_orphan() -> None:
    proc = subprocess.Popen(["sleep", "300"], start_new_session=True)
    pty_registry.register(proc.pid, ["sleep", "300"])
    _set_owner(proc.pid, 1)

    reaped = pty_registry.reap_stale(grace=0.2)

    assert reaped == [proc.pid]
    proc.wait(timeout=5)
    assert _registry() == {}


def test_reap_kills_orphan_behind_shell_exec() -> None:
    # The real app spawns `zsh -lc <cmd>`; zsh execs the final command, so ps
    # shows `sleep 300`, not the shell. Identity must still match via lstart.
    proc = subprocess.Popen(["/bin/zsh", "-lc", "sleep 300"], start_new_session=True)
    pty_registry.register(proc.pid, ["/bin/zsh", "-lc", "sleep 300"])
    _set_owner(proc.pid, 1)

    reaped = pty_registry.reap_stale(grace=0.2)

    assert reaped == [proc.pid]
    proc.wait(timeout=5)
    assert _registry() == {}


def test_reap_never_signals_a_recycled_pid() -> None:
    # Entry whose pid now belongs to a different process (us) with a different
    # start time: must be dropped without being signalled.
    pty_registry.register(os.getpid(), ["definitely-not-this-executable"])
    entries = _registry()
    entries[str(os.getpid())]["lstart"] = "Thu Jan  1 00:00:00 1970"
    entries[str(os.getpid())]["owner"] = 1
    pty_registry._save(entries)

    assert pty_registry.reap_stale(grace=0.0) == []
    assert _registry() == {}


def test_reap_leaves_live_sibling_entries_untouched(monkeypatch) -> None:
    proc = subprocess.Popen(["sleep", "30"], start_new_session=True)
    try:
        pty_registry.register(proc.pid, ["sleep", "30"])
        _set_owner(proc.pid, 99999)
        monkeypatch.setattr(pty_registry, "_backend_alive", lambda pid: pid == 99999)

        assert pty_registry.reap_stale(grace=0.0) == []
        assert proc.poll() is None  # not signalled
        assert str(proc.pid) in _registry()  # entry preserved
    finally:
        proc.kill()
        proc.wait()


async def _noop_emit(event: dict[str, Any]) -> None:
    return None


async def _wait_registry_empty(timeout: float = 5.0) -> None:
    """The entry is dropped only once the child is confirmed dead (kill()'s
    escalation task) — a live TERM-trapping child must stay visible to the
    next start's reap_stale."""
    deadline = asyncio.get_event_loop().time() + timeout
    while asyncio.get_event_loop().time() < deadline:
        if _registry() == {}:
            return
        await asyncio.sleep(0.05)
    assert _registry() == {}


@pytest.mark.asyncio
async def test_terminal_service_registers_and_unregisters() -> None:
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(pane_id="p1", agent_key=None, command=["sleep", "30"], cwd="/")
    assert str(session.proc.pid) in _registry()

    svc.kill(session.id)
    session.proc.wait(timeout=5)
    await _wait_registry_empty()


@pytest.mark.asyncio
async def test_kill_escalates_term_trapping_child_and_unregisters() -> None:
    # A CLI that traps SIGTERM must still be put down (SIGKILL escalation) and
    # only then lose its crash-recovery record.
    svc = TerminalService(emit=_noop_emit)
    session = svc.create(
        pane_id="p1",
        agent_key=None,
        command=["sh", "-c", 'trap "" TERM; sleep 300'],
        cwd="/",
    )
    assert str(session.proc.pid) in _registry()
    # Give the shell a moment to install the TERM trap before signalling.
    await asyncio.sleep(0.3)
    svc.kill(session.id)
    # Entry must survive while the child is still alive under SIGTERM.
    session.proc.wait(timeout=10)
    await _wait_registry_empty()
