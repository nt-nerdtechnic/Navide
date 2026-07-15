from __future__ import annotations

import asyncio
import codecs
import errno
import fcntl
import logging
import os
import pty
import re
import shlex
import shutil
import signal
import struct
import subprocess
import termios
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import IO, Any, Awaitable, Callable
from uuid import uuid4

from . import pty_registry


# Strip ALL ANSI/VT escape sequences for clean log output:
#   CSI:  \x1b[ ... final-byte
#   OSC:  \x1b] ... \x07  (window title, colour palettes, etc.)
#   OSC (ST-terminated): \x1b] ... \x1b\\
#   DCS:  \x1b P ... \x1b\\
#   APC:  \x1b _ ... \x1b\\
#   SOS:  \x1b X ... \x1b\\
#   PM:   \x1b ^ ... \x1b\\
#   Single-char:  \x1b followed by any byte 0x20-0x7E (includes \x1b7, \x1b8, etc.)
_ANSI_RE = re.compile(
    r"\x1b(?:"
    r"\[[0-?]*[ -/]*[@-~]"          # CSI sequences
    r"|\][^\x07\x1b]*(?:\x07|\x1b\\)"  # OSC (BEL or ST terminated)
    r"|[PX^_][^\x1b]*\x1b\\"        # DCS / APC / SOS / PM
    r"|[@-Z\\-~]"                   # single-byte Fe sequences (incl. \x1b7 \x1b8 = \x1b8)
    r")"
)

# TUI chrome lines we never want in the conversation log.
_TUI_NOISE_RE = re.compile(
    r"bypasspermissions|shift\+tab|esc to interrupt|esctointerrupt"
    r"|tointerrupt|for agents|/effort"
    r"|\[end of text\]"
    r"|^\s*$",   # blank lines (handled separately below)
    re.IGNORECASE,
)


def _clean_for_log(raw: str) -> str:
    """Strip ANSI codes, lone carriage returns, and TUI chrome from terminal output.

    The result is human-readable plain text suitable for a conversation log.
    """
    # 1. Strip all ANSI / VT escape sequences.
    text = _ANSI_RE.sub("", raw)
    # 2. Lone \\r (carriage-return without \\n) means "overwrite this line"
    #    in terminal semantics. Replace with newline so we don't lose content
    #    but accept that some duplicate/overwritten lines may appear.
    text = re.sub(r"\r(?!\n)", "\n", text)
    # 3. Filter out TUI chrome lines and collapse consecutive blank lines.
    lines_out: list[str] = []
    blank_run = 0
    for line in text.splitlines():
        stripped = line.rstrip()
        if _TUI_NOISE_RE.search(stripped):
            continue
        if not stripped:
            blank_run += 1
            if blank_run <= 1:
                lines_out.append("")
        else:
            blank_run = 0
            lines_out.append(stripped)
    return "\n".join(lines_out)

from .ipc import make_event

log = logging.getLogger("agent_team_backend.terminals")

EventSink = Callable[[dict[str, Any]], Awaitable[None]]
# Kept as a deprecated, no-op type alias — historical token sink callback.
# Tokens are now sourced from log files (see agent_team_backend.log_readers).
TokenEventSink = Callable[..., Awaitable[None]]


@dataclass
class TerminalSession:
    id: str
    pane_id: str
    agent_key: str | None
    command: list[str]
    cwd: str
    master_fd: int
    proc: subprocess.Popen[bytes]
    started_monotonic: float = field(default_factory=time.monotonic)
    sequence: int = 0
    closed: bool = False
    close_reason: str | None = None
    exit_code: int | None = None
    uptime_ms: int | None = None
    exit_signal: str | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    output_log_fp: IO[str] | None = field(default=None, repr=False)
    # Per-session vendor-parser state — used by vendor_parsers.parse_chunk to
    # compute deltas against the last seen cumulative token totals.
    vendor_parser_state: dict[str, Any] = field(default_factory=dict)


# Batch PTY output chunks for up to this many milliseconds before sending a
# single WebSocket message.  Without batching, a streaming agent can produce
# hundreds of tiny messages per second and overwhelm Electron's Network service
# process, causing it to crash (exit_code=15 / white-screen).
# 50ms keeps latency acceptable (<1 frame at 60fps perceived) while cutting
# the message rate by ~10-20x vs unbatched — empirically prevents the crash.
_OUTPUT_BATCH_MS = 50


class TerminalService:
    def __init__(
        self,
        emit: EventSink,
        token_event_sink: TokenEventSink | None = None,
    ) -> None:
        self._sessions: dict[str, TerminalSession] = {}
        self._emit = emit
        self._token_event_sink = token_event_sink
        self._loop = asyncio.get_event_loop()
        # Per-session output batching state
        self._out_buffers: dict[str, list[str]] = {}   # session_id -> pending chunks
        self._out_handles: dict[str, asyncio.TimerHandle] = {}  # session_id -> timer
        # Per-session pending INPUT bytes not yet accepted by the non-blocking
        # PTY master (EAGAIN / partial write). Drained via add_writer.
        self._in_buffers: dict[str, bytearray] = {}    # session_id -> pending bytes
        # Per-session incremental UTF-8 decoders. PTY reads are raw byte chunks
        # that can split a multi-byte character (CJK is 3 bytes/char); decoding
        # each chunk independently turns the halves into U+FFFD, which desyncs
        # the CLI's cursor math from what xterm renders (layout corruption).
        self._decoders: dict[str, codecs.IncrementalDecoder] = {}

    def create(
        self,
        *,
        pane_id: str,
        agent_key: str | None,
        command: str | list[str],
        cwd: str,
        cols: int = 100,
        rows: int = 30,
        env: dict[str, str] | None = None,
        metadata: dict[str, Any] | None = None,
        output_log_file: str = "",
    ) -> TerminalSession:
        argv = self._resolve_command(command)
        if not os.path.isdir(cwd):
            raise FileNotFoundError(f"cwd does not exist: {cwd}")
        if not shutil.which(argv[0]):
            raise FileNotFoundError(f"executable not found: {argv[0]}")

        master, slave = pty.openpty()
        self._set_winsize(master, rows, cols)
        flags = fcntl.fcntl(master, fcntl.F_GETFL)
        fcntl.fcntl(master, fcntl.F_SETFL, flags | os.O_NONBLOCK)

        final_env = os.environ.copy()
        final_env["TERM"] = final_env.get("TERM", "xterm-256color")
        final_env["COLUMNS"] = str(cols)
        final_env["LINES"] = str(rows)
        if env:
            final_env.update(env)

        started_monotonic = time.monotonic()
        try:
            proc = subprocess.Popen(
                argv,
                stdin=slave,
                stdout=slave,
                stderr=slave,
                cwd=cwd,
                env=final_env,
                close_fds=True,
                start_new_session=True,
            )
        except Exception:
            os.close(master)
            os.close(slave)
            raise
        os.close(slave)
        # Record the child so a future backend start can reap it if this
        # process dies without running its shutdown sweep. register runs a ps
        # probe + registry-file I/O — keep it off the event loop so the
        # terminal.create ack isn't delayed behind it.
        try:
            asyncio.get_running_loop().run_in_executor(
                None, pty_registry.register, proc.pid, argv
            )
        except RuntimeError:
            # No running loop (non-async caller) — fall back to inline.
            pty_registry.register(proc.pid, argv)

        # Open output log file if requested (pipeline panes pass a path).
        log_fp: IO[str] | None = None
        if output_log_file:
            try:
                os.makedirs(os.path.dirname(output_log_file), exist_ok=True)
                log_fp = open(output_log_file, "a", encoding="utf-8", buffering=1)  # noqa: SIM115
            except Exception as err:  # noqa: BLE001
                log.warning("cannot open output log %s: %s", output_log_file, err)

        session = TerminalSession(
            id=str(uuid4()),
            pane_id=pane_id,
            agent_key=agent_key,
            command=argv,
            cwd=cwd,
            master_fd=master,
            proc=proc,
            started_monotonic=started_monotonic,
            metadata=metadata or {},
            output_log_fp=log_fp,
        )
        self._sessions[session.id] = session
        self._loop.add_reader(master, self._on_readable, session)
        log.info(
            "terminal session created id=%s pane=%s pid=%s cmd=%s",
            session.id,
            pane_id,
            proc.pid,
            argv,
        )
        return session

    def write(self, session_id: str, data: str) -> None:
        session = self._require(session_id)
        if session.closed:
            return
        # Queue the bytes and try to drain now. The PTY master is non-blocking,
        # so a full kernel buffer raises EAGAIN. The old code dropped the chunk
        # on EAGAIN (silent data loss — the agent's input box stayed empty while
        # the caller still logged "✓ sent"). Instead we buffer whatever the
        # kernel won't take and finish it from an add_writer callback. partial
        # writes (os.write accepting < len) are handled the same way.
        buf = self._in_buffers.setdefault(session_id, bytearray())
        buf.extend(data.encode("utf-8"))
        self._flush_input(session)

    def _flush_input(self, session: TerminalSession) -> None:
        """Drain a session's pending input into the PTY master without blocking.

        Loops on partial writes; on EAGAIN leaves the remainder buffered and
        registers an add_writer callback to resume once the fd is writable.
        """
        buf = self._in_buffers.get(session.id)
        if buf is None or session.closed:
            return
        while buf:
            try:
                n = os.write(session.master_fd, buf)
            except BlockingIOError:
                break  # kernel buffer full — resume on writable
            except OSError as err:
                log.warning("write to session %s failed: %s", session.id, err)
                buf.clear()
                self._unwatch_writable(session)
                return
            if n <= 0:
                break
            del buf[:n]
        if buf:
            self._watch_writable(session)
        else:
            self._unwatch_writable(session)

    def _on_writable(self, session: TerminalSession) -> None:
        self._flush_input(session)

    def _watch_writable(self, session: TerminalSession) -> None:
        self._loop.add_writer(session.master_fd, self._on_writable, session)

    def _unwatch_writable(self, session: TerminalSession) -> None:
        try:
            self._loop.remove_writer(session.master_fd)
        except (ValueError, KeyError, OSError):
            pass

    def log_sent(self, session_id: str, label: str, text: str) -> None:
        """Append a human-readable record of injected text to the session log.

        Call this BEFORE chunked write() calls so the log shows the full
        message in one block rather than fragmented 512-byte slices.
        The output_log_fp is only set for pipeline panes — silently ignored
        for manual/interactive panes.
        """
        session = self._sessions.get(session_id)
        if not session or not session.output_log_fp:
            return
        ts = datetime.now(timezone.utc).strftime("%H:%M:%S")
        marker = f"[→ {label.upper()} @ {ts}]"
        sep = "─" * min(60, len(marker) + 4)
        try:
            session.output_log_fp.write(
                f"\n{sep}\n{marker}\n{sep}\n{text}\n{sep}\n\n"
            )
        except Exception as err:  # noqa: BLE001
            log.warning("log_sent write failed: %s", err)

    def resize(self, session_id: str, cols: int, rows: int) -> None:
        session = self._require(session_id)
        if session.closed:
            return
        self._set_winsize(session.master_fd, rows, cols)

    def force_redraw(self, session_id: str, cols: int, rows: int) -> None:
        """Nudge the PTY size to raise SIGWINCH so a TUI repaints after reattach.
        Resizing to the identical current size would not signal the program, so
        set a transient off-by-one row then the real size. This is how a
        reattaching renderer recovers the screen — there is no output buffer."""
        session = self._sessions.get(session_id)
        if not session or session.closed:
            return
        self._set_winsize(session.master_fd, max(rows - 1, 1), cols)
        self._set_winsize(session.master_fd, rows, cols)

    async def drain_output(self, session_id: str) -> None:
        """Flush all pending and kernel-buffered output before the caller's
        next send (the resize ack), AWAITING each emit so it lands first.

        Output is normally batched behind a 50ms timer (`_out_handles`) and
        emitted via `create_task`, so old-width bytes can reach the frontend
        AFTER the resize ack — xterm then re-wraps stale-width content and the
        CLI's cursor-up repaints strand corrupt frames in scrollback. Draining
        makes the ack a true ordering barrier: old-width output < ack < any
        new-width output.
        """
        session = self._sessions.get(session_id)
        if not session or session.closed:
            return
        # 1. Slurp any kernel-buffered bytes the reader hasn't picked up yet,
        #    reusing the incremental decoder so a split multi-byte char isn't
        #    turned into U+FFFD.
        decoder = self._decoders.get(session.id)
        if decoder is None:
            decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
            self._decoders[session.id] = decoder
        while True:
            try:
                chunk = os.read(session.master_fd, 4096)
            except (BlockingIOError, OSError):
                break
            if not chunk:
                break
            decoded = decoder.decode(chunk)
            if decoded:
                self._out_buffers.setdefault(session.id, []).append(decoded)
        # 2. Cancel the pending batch timer; we emit synchronously below.
        handle = self._out_handles.pop(session.id, None)
        if handle:
            handle.cancel()
        # 3. Emit everything buffered, awaiting so it precedes the ack on the wire.
        chunks = self._out_buffers.pop(session.id, None)
        if not chunks:
            return
        combined = "".join(chunks)
        for piece in self._split_chunks(combined):
            await self._emit(self._build_output_event(session, piece))
        if session.output_log_fp:
            try:
                session.output_log_fp.write(_clean_for_log(combined))
            except Exception as err:  # noqa: BLE001
                log.warning("output log write failed: %s", err)

    def interrupt(self, session_id: str) -> None:
        session = self._require(session_id)
        if session.closed:
            return
        try:
            os.write(session.master_fd, b"\x03")
        except OSError as err:
            log.warning("interrupt session %s failed: %s", session_id, err)

    def kill(self, session_id: str, force: bool = False) -> None:
        session = self._sessions.get(session_id)
        if not session or session.closed:
            return
            
        try:
            pgid = os.getpgid(session.proc.pid)
            if force:
                os.killpg(pgid, signal.SIGKILL)
            else:
                os.killpg(pgid, signal.SIGTERM)
        except ProcessLookupError:
            # Group already gone — closing the PTY master HUPs the child, so
            # it often dies before the SIGTERM lands. The escalation task
            # still runs to reap it and drop its crash-recovery record.
            pgid = 0
            
        self._close(session, reason="killed")
            
        # A CLI that traps SIGTERM would survive the close and, being gone
        # from _sessions, escape the shutdown sweep — escalate to SIGKILL
        # after a grace period and only then drop its crash-recovery record.
        self._loop.create_task(self._escalate_kill(session, pgid))

    async def _escalate_kill(self, session: TerminalSession, pgid: int, grace: float = 1.0) -> None:
        deadline = self._loop.time() + grace
        while session.proc.poll() is None and self._loop.time() < deadline:
            await asyncio.sleep(0.05)
        if session.proc.poll() is None and pgid > 0:
            try:
                os.killpg(pgid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
            try:
                # Reap the zombie so poll() flips before we unregister.
                await asyncio.to_thread(session.proc.wait, 1.0)
            except Exception:  # noqa: BLE001
                pass
        if session.proc.poll() is not None:
            await asyncio.to_thread(pty_registry.unregister, session.proc.pid)

    async def kill_all(self, grace: float = 1.0) -> None:
        """Terminate every live PTY child. Children run with
        start_new_session=True (own process group), so killing the backend
        never propagates to them — without this explicit sweep on shutdown
        they outlive the app as orphans."""
        targets: list[tuple[TerminalSession, int]] = []
        for session in list(self._sessions.values()):
            if session.closed:
                continue
            try:
                targets.append((session, os.getpgid(session.proc.pid)))
            except ProcessLookupError:
                # Child already gone — still close so the session is removed
                # and its registry entry is dropped.
                self._close(session, reason="shutdown")
        for _, pgid in targets:
            try:
                os.killpg(pgid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
        deadline = self._loop.time() + grace
        while (
            any(s.proc.poll() is None for s, _ in targets)
            and self._loop.time() < deadline
        ):
            await asyncio.sleep(0.05)
        for session, pgid in targets:
            if session.proc.poll() is None:
                try:
                    os.killpg(pgid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
                try:
                    # Reap immediately (SIGKILL is not trappable) so _close's
                    # death-confirmed unregister drops the registry entry.
                    session.proc.wait(timeout=1.0)
                except Exception:  # noqa: BLE001
                    pass
            self._close(session, reason="shutdown")

    def _require(self, session_id: str) -> TerminalSession:
        session = self._sessions.get(session_id)
        if not session:
            raise KeyError(f"unknown terminal session: {session_id}")
        return session

    def _resolve_command(self, command: str | list[str]) -> list[str]:
        if isinstance(command, list):
            argv = list(command)
        else:
            argv = shlex.split(command)
        if not argv:
            raise ValueError("command is empty")
        return argv

    def _set_winsize(self, fd: int, rows: int, cols: int) -> None:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

    def _on_readable(self, session: TerminalSession) -> None:
        if session.closed:
            return
        try:
            chunk = os.read(session.master_fd, 4096)
        except BlockingIOError:
            return
        except OSError as err:
            if err.errno in (errno.EIO,):
                # PTY closed (child exited and tty was released)
                self._close(session, reason="exit")
                return
            log.warning("read session %s failed: %s", session.id, err)
            self._close(session, reason="error")
            return

        if not chunk:
            self._close(session, reason="exit")
            return

        # Accumulate decoded bytes; schedule a flush if not already pending.
        _BUF_CAP = 5 * 1024 * 1024  # 5 MB — force an immediate flush if exceeded
        decoder = self._decoders.get(session.id)
        if decoder is None:
            decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
            self._decoders[session.id] = decoder
        decoded = decoder.decode(chunk)
        if not decoded:
            return  # chunk ended mid-character; bytes held until the rest arrives
        buf = self._out_buffers.setdefault(session.id, [])
        buf.append(decoded)
        buf_size = sum(len(s) for s in buf)
        if buf_size >= _BUF_CAP:
            # Cancel the pending debounce timer and flush now to avoid OOM.
            existing = self._out_handles.pop(session.id, None)
            if existing:
                existing.cancel()
            self._flush_output(session)
        elif session.id not in self._out_handles:
            handle = self._loop.call_later(
                _OUTPUT_BATCH_MS / 1000,
                self._flush_output,
                session,
            )
            self._out_handles[session.id] = handle

    def _flush_output(self, session: TerminalSession) -> None:
        """Send all buffered output for this session as a single WS message.

        If the combined payload exceeds _MAX_WS_PAYLOAD_BYTES we split it into
        chunks so the Electron Network service is never given a single massive
        frame (large frames have been observed to trigger the crash).
        """
        self._out_handles.pop(session.id, None)
        chunks = self._out_buffers.pop(session.id, None)
        if not chunks:
            return
        combined = "".join(chunks)

        # Suspend reading from the PTY while we drain the network buffer.
        # This provides natural backpressure so the CLI blocks when writing
        # instead of OOMing the Python backend or Electron WebSocket receiver.
        try:
            self._loop.remove_reader(session.master_fd)
        except (ValueError, KeyError):
            pass

        async def _drain() -> None:
            try:
                for piece in self._split_chunks(combined):
                    if session.closed:
                        break
                    await self._emit(self._build_output_event(session, piece))
            finally:
                if not session.closed:
                    try:
                        self._loop.add_reader(session.master_fd, self._on_readable, session)
                    except Exception:
                        pass

        self._loop.create_task(_drain())

        # Persist cleaned output to the conversation log (if one was opened).
        if session.output_log_fp:
            try:
                session.output_log_fp.write(_clean_for_log(combined))
            except Exception as err:  # noqa: BLE001
                log.warning("output log write failed: %s", err)

    @staticmethod
    def _split_chunks(combined: str) -> list[str]:
        """Split a payload into <=64 KB pieces at valid UTF-8 boundaries.

        Caps individual WS messages well below the point where the Electron
        Network service becomes overwhelmed, never cutting a multi-byte
        character (emoji, CJK, etc.) in half into U+FFFD.
        """
        _MAX_BYTES = 64 * 1024
        encoded = combined.encode("utf-8")
        if len(encoded) <= _MAX_BYTES:
            return [combined]
        pieces: list[str] = []
        pos = 0
        while pos < len(encoded):
            end = min(pos + _MAX_BYTES, len(encoded))
            # Walk back to the start of a multi-byte sequence if we landed
            # inside one (continuation bytes have the form 10xxxxxx).
            while end > pos and end < len(encoded) and (encoded[end] & 0xC0) == 0x80:
                end -= 1
            pieces.append(encoded[pos:end].decode("utf-8"))
            pos = end
        return pieces

    def _build_output_event(self, session: TerminalSession, data: str) -> dict[str, Any]:
        session.sequence += 1
        return make_event(
            "terminal.output",
            {
                "terminal_session_id": session.id,
                "pane_id": session.pane_id,
                "sequence": session.sequence,
                "data": data,
                "stream": "stdout",
            },
        )

    def _send_chunk(self, session: TerminalSession, data: str) -> None:
        self._loop.create_task(self._emit(self._build_output_event(session, data)))

    def _close(self, session: TerminalSession, *, reason: str) -> None:
        if session.closed:
            return
        session.closed = True
        try:
            self._loop.remove_reader(session.master_fd)
        except (ValueError, KeyError):
            pass
        # Stop any pending input drain and discard unwritten bytes before the
        # fd is closed (remove_writer needs a still-valid fd).
        self._unwatch_writable(session)
        self._in_buffers.pop(session.id, None)
        try:
            os.close(session.master_fd)
        except OSError:
            pass
        # Cancel pending batch timer and flush any buffered output before the
        # exit event so the client sees all output in order.
        handle = self._out_handles.pop(session.id, None)
        if handle:
            handle.cancel()
        # Drain any bytes the incremental decoder is still holding (a final
        # chunk that ended mid-character) so the tail isn't silently dropped.
        decoder = self._decoders.pop(session.id, None)
        if decoder:
            tail = decoder.decode(b"", final=True)
            if tail:
                self._out_buffers.setdefault(session.id, []).append(tail)
        self._flush_output(session)
        # Best-effort wait for child to avoid zombies
        try:
            session.proc.poll()
        except Exception:
            pass
        exit_code = session.proc.returncode
        uptime_ms = max(0, round((time.monotonic() - session.started_monotonic) * 1000))
        exit_signal: str | None = None
        if exit_code is not None and exit_code < 0:
            try:
                exit_signal = signal.Signals(-exit_code).name
            except ValueError:
                exit_signal = f"SIG{-exit_code}"
        session.close_reason = reason
        session.exit_code = exit_code
        session.uptime_ms = uptime_ms
        session.exit_signal = exit_signal
        log.info("terminal session closed id=%s reason=%s exit=%s", session.id, reason, exit_code)
        if session.output_log_fp:
            try:
                session.output_log_fp.close()
            except Exception:  # noqa: BLE001
                pass
            session.output_log_fp = None
        event = make_event(
            "terminal.exit",
            {
                "terminal_session_id": session.id,
                "pane_id": session.pane_id,
                "reason": reason,
                "exit_code": exit_code,
                "uptime_ms": uptime_ms,
                "signal": exit_signal,
                "startup_probe": session.metadata.get("startup_probe"),
            },
        )
        self._loop.create_task(self._emit(event))
        self._sessions.pop(session.id, None)
        # Drop the crash-recovery record only once the child is confirmed
        # dead: a still-live child (e.g. a TERM-trapping CLI) must stay
        # visible to the next start's reap_stale. kill()'s escalation task
        # and kill_all() unregister the survivors they put down.
        if session.proc.poll() is not None:
            self._loop.run_in_executor(None, pty_registry.unregister, session.proc.pid)
