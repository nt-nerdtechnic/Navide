"""Regression tests for PTY output UTF-8 decoding.

os.read() returns raw byte chunks that can end in the middle of a multi-byte
UTF-8 character (CJK chars are 3 bytes). The old per-chunk decode turned the
split halves into U+FFFD replacement characters, which desynced the CLI's
cursor math from what xterm rendered — visible as corrupted TUI layout and a
misplaced input cursor. These tests pin the incremental-decoder fix.
"""

import fcntl
import os
from types import SimpleNamespace

import pytest

from agent_team_backend.terminals import TerminalService


def _nonblocking(fd: int) -> None:
    flags = fcntl.fcntl(fd, fcntl.F_GETFL)
    fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)


async def _emit(_event):  # EventSink stub — never actually called on this path
    return None


def _cancel_pending_flush(svc: TerminalService, session_id: str) -> None:
    handle = svc._out_handles.pop(session_id, None)
    if handle:
        handle.cancel()


@pytest.mark.asyncio
async def test_split_multibyte_char_is_reassembled_not_replaced():
    svc = TerminalService(_emit)
    r, w = os.pipe()
    _nonblocking(r)
    session = SimpleNamespace(id="t-utf8", master_fd=r, closed=False)
    svc._sessions["t-utf8"] = session
    try:
        payload = "中文字".encode("utf-8")  # 9 bytes, 3 bytes per char
        os.write(w, payload[:4])  # ends 1 byte into the second character
        svc._on_readable(session)
        os.write(w, payload[4:])
        svc._on_readable(session)

        combined = "".join(svc._out_buffers["t-utf8"])
        assert combined == "中文字"
        assert "�" not in combined
    finally:
        _cancel_pending_flush(svc, "t-utf8")
        os.close(r)
        os.close(w)


@pytest.mark.asyncio
async def test_genuinely_invalid_bytes_still_become_replacement_chars():
    svc = TerminalService(_emit)
    r, w = os.pipe()
    _nonblocking(r)
    session = SimpleNamespace(id="t-bad", master_fd=r, closed=False)
    svc._sessions["t-bad"] = session
    try:
        os.write(w, b"ok\xff\xfeok")  # 0xFF/0xFE can never start a UTF-8 sequence
        svc._on_readable(session)

        combined = "".join(svc._out_buffers["t-bad"])
        assert combined == "ok��ok"
    finally:
        _cancel_pending_flush(svc, "t-bad")
        os.close(r)
        os.close(w)
