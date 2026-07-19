"""Tests for the adaptive output-flush fast path.

Keystroke echo used to wait the full 50ms batch window before reaching the
renderer, making typing feel laggy (worst for IME input, where the wait lands
on the commit). Low-rate output now flushes on the next loop tick; sustained
streams still fall back to 50ms batching so the Electron flood protection
holds.
"""

import asyncio
import fcntl
import os
from types import SimpleNamespace

import pytest

from agent_team_backend.terminals import (
    _FAST_PATH_MAX_CHUNKS,
    _FAST_PATH_WINDOW_S,
    _OUTPUT_BATCH_MS,
    TerminalService,
)


def _nonblocking(fd: int) -> None:
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)


async def _emit(_event):  # EventSink stub for tests that never flush
    return None


def _make_session(session_id: str, master_fd: int) -> SimpleNamespace:
    return SimpleNamespace(
        id=session_id,
        master_fd=master_fd,
        closed=False,
        pane_id="pane-1",
        sequence=0,
        output_log_fp=None,
    )


def _pending_delay(svc: TerminalService, session_id: str) -> float:
    handle = svc._out_handles[session_id]
    return handle.when() - svc._loop.time()


def _cancel_pending_flush(svc: TerminalService, session_id: str) -> None:
    handle = svc._out_handles.pop(session_id, None)
    if handle:
        handle.cancel()


@pytest.mark.asyncio
async def test_single_chunk_schedules_immediate_flush():
    svc = TerminalService(_emit)
    r, w = os.pipe()
    _nonblocking(r)
    session = _make_session("t-fast", r)
    svc._sessions["t-fast"] = session
    try:
        os.write(w, b"x")
        svc._on_readable(session)
        # Interactive rate: flush is scheduled for the next loop tick, not
        # the 50ms batch window.
        assert _pending_delay(svc, "t-fast") < _OUTPUT_BATCH_MS / 1000 / 2
    finally:
        _cancel_pending_flush(svc, "t-fast")
        os.close(r)
        os.close(w)


@pytest.mark.asyncio
async def test_sustained_stream_falls_back_to_batching():
    svc = TerminalService(_emit)
    r, w = os.pipe()
    _nonblocking(r)
    session = _make_session("t-stream", r)
    svc._sessions["t-stream"] = session
    try:
        # Feed chunks back-to-back, re-arming the timer each time so every
        # chunk gets a fresh delay decision (in production the pending timer
        # would swallow the intermediate ones).
        for _ in range(_FAST_PATH_MAX_CHUNKS):
            os.write(w, b"y")
            _cancel_pending_flush(svc, "t-stream")
            svc._on_readable(session)
        # By the Nth chunk the window is saturated: batching kicks in.
        assert _pending_delay(svc, "t-stream") > _OUTPUT_BATCH_MS / 1000 / 2
    finally:
        _cancel_pending_flush(svc, "t-stream")
        os.close(r)
        os.close(w)


@pytest.mark.asyncio
async def test_quiet_period_restores_fast_path():
    svc = TerminalService(_emit)
    now = svc._loop.time()
    from collections import deque

    stale = now - _FAST_PATH_WINDOW_S * 10
    svc._chunk_times["t-idle"] = deque(
        [stale] * _FAST_PATH_MAX_CHUNKS, maxlen=_FAST_PATH_MAX_CHUNKS
    )
    assert svc._flush_delay("t-idle") == 0.0
    # And a saturated recent window batches.
    svc._chunk_times["t-busy"] = deque(
        [now] * _FAST_PATH_MAX_CHUNKS, maxlen=_FAST_PATH_MAX_CHUNKS
    )
    assert svc._flush_delay("t-busy") == _OUTPUT_BATCH_MS / 1000


@pytest.mark.asyncio
async def test_fast_path_emits_within_a_tick():
    emitted: list[dict] = []

    async def collect(event):
        emitted.append(event)

    svc = TerminalService(collect)
    r, w = os.pipe()
    _nonblocking(r)
    session = _make_session("t-emit", r)
    svc._sessions["t-emit"] = session
    try:
        os.write(w, "中".encode("utf-8"))
        svc._on_readable(session)
        # A couple of loop ticks — far less than the 50ms batch window.
        await asyncio.sleep(0.01)
        assert len(emitted) == 1
        assert emitted[0]["payload"]["data"] == "中"
    finally:
        _cancel_pending_flush(svc, "t-emit")
        try:
            svc._loop.remove_reader(r)  # re-added by _flush_output's drain task
        except (ValueError, KeyError):
            pass
        os.close(r)
        os.close(w)
