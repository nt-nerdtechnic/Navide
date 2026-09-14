"""_communicate_or_kill must reap the child on timeout.

A bare wait_for(proc.communicate()) that times out leaves the spawned
`security`/`gh`/CLI child running (and never reaped) — each hung probe leaked
one process until app exit.
"""
from __future__ import annotations

import asyncio
import os
import signal
import sys

import pytest

from agent_team_backend import usage_service


async def test_kills_and_reaps_on_timeout() -> None:
    proc = await asyncio.create_subprocess_exec(
        "sleep", "30", stdout=asyncio.subprocess.PIPE
    )
    with pytest.raises(asyncio.TimeoutError):
        await usage_service._communicate_or_kill(proc, timeout=0.1)
    assert proc.returncode is not None


async def test_returns_stdout_within_timeout() -> None:
    proc = await asyncio.create_subprocess_exec(
        "echo", "hello", stdout=asyncio.subprocess.PIPE
    )
    out = await usage_service._communicate_or_kill(proc, timeout=5.0)
    assert out.decode().strip() == "hello"


async def test_cancelling_a_claude_read_kills_the_probe_it_abandons() -> None:
    """Cancellation is the second way to stop waiting on a probe, and it must
    reap the child just like the timeout does.

    An account switch cancels the in-flight read (UsageService.
    _cancel_claude_reads) so the switch does not have to sit out a budget
    measured in minutes. The probe is spawned with start_new_session=True, so
    nothing else ever reaps it: without an explicit kill, every such switch
    abandons a running Claude Code on the machine whose load made the read slow
    in the first place.
    """
    from agent_team_backend.cli_vendors import claude as cv

    spawned: dict[str, int] = {}
    original = asyncio.create_subprocess_exec

    async def spy(*args, **kwargs):
        proc = await original(*args, **kwargs)
        spawned["pid"] = proc.pid
        return proc

    original_args = cv.USAGE_ARGS
    asyncio.create_subprocess_exec = spy
    # The interpreter, not `sleep`: the probe resolves a bare name through the
    # runner's own PATH, and on windows-latest that found something that is not
    # a Windows executable (WinError 11). sys.executable is an absolute path to
    # a real binary everywhere, and sleeps just as well.
    cv.USAGE_ARGS = ("-c", "import time; time.sleep(30)")
    try:
        task = asyncio.create_task(cv.read_usage_panel(sys.executable))
        for _ in range(40):  # wait for the spawn without racing on a fixed sleep
            if "pid" in spawned:
                break
            await asyncio.sleep(0.05)
        assert "pid" in spawned, "probe never spawned"

        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    finally:
        asyncio.create_subprocess_exec = original
        cv.USAGE_ARGS = original_args

    pid = spawned["pid"]
    for _ in range(40):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return  # reaped, which is the whole assertion
        await asyncio.sleep(0.05)
    # SIGTERM, not SIGKILL: Windows has no SIGKILL, and reaching this line is
    # already the failure — it must report it, not raise AttributeError.
    os.kill(pid, signal.SIGTERM)  # don't leave the test's own child behind
    raise AssertionError(f"probe {pid} survived the cancellation")
