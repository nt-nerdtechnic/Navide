"""The Windows terminal seam against a real ConPTY and a real child.

Every other Windows terminal test stubs `winpty` and kernel32, which is what
makes them runnable on any host — but it also means nothing there proves that
a ConPTY actually delivers output, that a child's exit turns into EOF, or that
closing a handle takes the process tree with it. Those are properties of the
operating system, not of our call order, so this file runs only on Windows and
drives `osplat.terminal_backend.spawn` the way `terminals` does: start the
reader on the loop, drain with `read` until it would block, and close.

Mirrors `test_terminals_e2e_input.py` (the POSIX end-to-end) one level lower,
at the seam rather than at `TerminalService`. Every test is bounded by a
timeout well under ten seconds, and the fixture force-kills whatever is left.
"""

from __future__ import annotations

import asyncio
import os
import sys
from typing import Callable

import psutil
import pytest

from agent_team_backend import osplat

pytestmark = pytest.mark.skipif(
    sys.platform != "win32",
    reason="drives a real ConPTY; the other hosts run the stubbed suite instead",
)

#: Long enough for a child that must still be running when the test acts on it,
#: short enough that a leaked one cannot outlive the run by much.
_LONG_SLEEP = "30"


@pytest.fixture
def spawn(tmp_path):
    """Spawn a Python child on a real ConPTY; kill whatever survives the test."""
    handles = []

    def make(code: str, *, rows: int = 24, cols: int = 80):
        handle = osplat.terminal_backend.spawn(
            [sys.executable, "-u", "-c", code],
            cwd=str(tmp_path),
            env={**os.environ, "TERM": "xterm-256color", "PYTHONIOENCODING": "utf-8"},
            rows=rows,
            cols=cols,
        )
        handles.append(handle)
        return handle

    yield make

    for handle in handles:
        try:
            handle.close()
        except Exception:  # noqa: BLE001 - teardown must not mask a failure
            pass
        _force_kill_tree(handle.pid)


def _force_kill_tree(pid: int) -> None:
    try:
        root = psutil.Process(pid)
        targets = root.children(recursive=True) + [root]
    except psutil.Error:
        return
    for proc in targets:
        try:
            proc.kill()
        except psutil.Error:
            pass


async def _drain_until(
    handle, matched: Callable[[bytes], bool], *, timeout_s: float
) -> tuple[str, bytes]:
    """Run the handle's reader on this loop until `matched` or EOF.

    Returns ("match" | "eof" | "timeout", everything read so far). The drain
    loop is `terminals._on_readable` in miniature: read until `BlockingIOError`,
    treat None as EOF.
    """
    loop = asyncio.get_running_loop()
    seen: list[bytes] = []
    done: asyncio.Future[str] = loop.create_future()

    def on_readable() -> None:
        while True:
            try:
                chunk = handle.read(4096)
            except BlockingIOError:
                break
            except OSError:
                chunk = None
            if chunk is None:
                if not done.done():
                    done.set_result("eof")
                return
            seen.append(chunk)
        if matched(b"".join(seen)) and not done.done():
            done.set_result("match")

    handle.start_reading(loop, on_readable)
    try:
        outcome = await asyncio.wait_for(done, timeout_s)
    except (asyncio.TimeoutError, TimeoutError):
        outcome = "timeout"
    return outcome, b"".join(seen)


async def _wait_gone(pids: list[int], *, timeout_s: float) -> list[int]:
    """Poll until none of `pids` exists; returns whatever is still there."""
    deadline = asyncio.get_running_loop().time() + timeout_s
    alive = list(pids)
    while alive and asyncio.get_running_loop().time() < deadline:
        alive = [pid for pid in alive if psutil.pid_exists(pid)]
        if not alive:
            break
        await asyncio.sleep(0.1)
    return alive


async def test_child_output_reaches_the_reader_callback(spawn):
    """What the child writes comes back through the pump, the loop and `read`."""
    handle = spawn(
        "import time; print('MARKER-OUT', flush=True); time.sleep(" + _LONG_SLEEP + ")"
    )
    outcome, seen = await _drain_until(
        handle, lambda buf: b"MARKER-OUT" in buf, timeout_s=8.0
    )
    assert outcome == "match", f"never saw the marker ({outcome}); read: {seen!r}"


async def test_a_child_that_exits_reaches_eof(spawn):
    """The exit watcher's whole job: ConPTY keeps the pipe open, we make EOF.

    Without it the pump stays parked in ReadFile after the child is gone and
    the pane never closes — which is what POSIX gets free from the kernel.
    """
    handle = spawn("print('BYE', flush=True)")
    outcome, seen = await _drain_until(handle, lambda buf: False, timeout_s=8.0)
    assert outcome == "eof", f"no EOF after the child exited ({outcome}): {seen!r}"
    assert b"BYE" in seen, f"output written before the exit was lost: {seen!r}"


async def test_close_kills_the_whole_tree_of_a_running_child(spawn):
    """`close()` on a live child ends it *and* what it spawned.

    The job object is what makes the grandchild reachable: it was started after
    the spawn, so no snapshot taken at create time would list it.
    """
    handle = spawn(
        "import subprocess, sys, time; "
        "kid = subprocess.Popen([sys.executable, '-c', "
        "'import time; time.sleep(" + _LONG_SLEEP + ")']); "
        "print('KID:' + str(kid.pid), flush=True); "
        "time.sleep(" + _LONG_SLEEP + ")"
    )
    outcome, seen = await _drain_until(
        handle, lambda buf: b"KID:" in buf, timeout_s=8.0
    )
    assert outcome == "match", f"the child never reported its kid ({outcome}): {seen!r}"
    kid_pid = int(seen.split(b"KID:", 1)[1].split()[0])
    assert psutil.pid_exists(kid_pid)

    handle.close()

    still_alive = await _wait_gone([handle.pid, kid_pid], timeout_s=5.0)
    assert not still_alive, f"close left these processes running: {still_alive}"


async def test_resize_does_not_raise(spawn):
    """`ResizePseudoConsole` on a live pane, both bigger and smaller."""
    handle = spawn("import time; time.sleep(" + _LONG_SLEEP + ")", rows=24, cols=80)
    handle.resize(40, 120)
    handle.resize(10, 40)
    handle.resize(24, 80)
