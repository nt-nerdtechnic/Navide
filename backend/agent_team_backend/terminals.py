from __future__ import annotations

import asyncio
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
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import IO, Any, Awaitable, Callable
from uuid import uuid4


def _tmux_available() -> bool:
    """Return True if tmux ≥ 3.0 is installed and usable."""
    if shutil.which("tmux") is None:
        return False
    try:
        result = subprocess.run(
            ["tmux", "-V"], capture_output=True, text=True, timeout=5
        )
        out = (result.stdout or "") + (result.stderr or "")
        m = re.search(r"tmux (\d+)\.(\d+)", out)
        if m:
            major, minor = int(m.group(1)), int(m.group(2))
            return (major, minor) >= (3, 0)
    except (subprocess.SubprocessError, OSError):
        pass
    return False


def _make_tmux_name(pane_id: str) -> str:
    """Generate a short, unique tmux session name (≤ 50 chars)."""
    suffix = pane_id.replace("-", "")[:12]
    return f"at-{suffix}"

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
    sequence: int = 0
    closed: bool = False
    metadata: dict[str, Any] = field(default_factory=dict)
    output_log_fp: IO[str] | None = field(default=None, repr=False)
    # Per-session vendor-parser state — used by vendor_parsers.parse_chunk to
    # compute deltas against the last seen cumulative token totals.
    vendor_parser_state: dict[str, Any] = field(default_factory=dict)
    # tmux session name when spawned via tmux; "" means plain PTY mode.
    tmux_name: str = ""


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
        self._MAX_SESSIONS = 32
        self._token_event_sink = token_event_sink
        self._loop = asyncio.get_event_loop()
        # Per-session output batching state
        self._out_buffers: dict[str, list[str]] = {}   # session_id -> pending chunks
        self._out_handles: dict[str, asyncio.TimerHandle] = {}  # session_id -> timer
        # Per-session pending INPUT bytes not yet accepted by the non-blocking
        # PTY master (EAGAIN / partial write). Drained via add_writer.
        self._in_buffers: dict[str, bytearray] = {}    # session_id -> pending bytes
        self._use_tmux: bool = _tmux_available()

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
        skip_tmux: bool = False,
    ) -> TerminalSession:
        if len(self._sessions) >= self._MAX_SESSIONS:
            raise RuntimeError(f"Too many terminal sessions (max {self._MAX_SESSIONS})")
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

        tmux_name = ""
        if self._use_tmux and not skip_tmux:
            tmux_name = _make_tmux_name(pane_id)
            _session_created = False
            try:
                subprocess.run(
                    ["tmux", "new-session", "-d", "-s", tmux_name,
                     "-x", str(cols), "-y", str(rows)] + argv,
                    cwd=cwd,
                    env=final_env,
                    check=True,
                    capture_output=True,
                )
                _session_created = True
                proc = subprocess.Popen(
                    ["tmux", "attach-session", "-t", tmux_name, "-d"],
                    stdin=slave,
                    stdout=slave,
                    stderr=slave,
                    cwd=cwd,
                    env=final_env,
                    close_fds=True,
                    start_new_session=True,
                )
            except (subprocess.CalledProcessError, OSError) as err:
                log.warning("tmux spawn failed (%s); falling back to plain PTY", err)
                if _session_created:
                    # new-session succeeded but attach failed — clean up to avoid orphan session
                    subprocess.run(
                        ["tmux", "kill-session", "-t", tmux_name],
                        capture_output=True, check=False,
                    )
                tmux_name = ""
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
        else:
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
        os.close(slave)

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
            metadata=metadata or {},
            output_log_fp=log_fp,
            tmux_name=tmux_name,
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
        if session.tmux_name:
            try:
                subprocess.run(
                    ["tmux", "resize-window", "-t", session.tmux_name,
                     "-x", str(cols), "-y", str(rows)],
                    capture_output=True,
                )
            except OSError:
                pass

    def interrupt(self, session_id: str) -> None:
        session = self._require(session_id)
        if session.closed:
            return
        try:
            os.write(session.master_fd, b"\x03")
        except OSError as err:
            log.warning("interrupt session %s failed: %s", session_id, err)

    def kill(self, session_id: str) -> None:
        session = self._sessions.get(session_id)
        if not session or session.closed:
            return
        tmux_name = session.tmux_name
        self._close(session, reason="killed")
        try:
            os.killpg(os.getpgid(session.proc.pid), signal.SIGTERM)
        except ProcessLookupError:
            pass
        if tmux_name:
            try:
                subprocess.run(
                    ["tmux", "kill-session", "-t", tmux_name],
                    capture_output=True,
                )
            except OSError:
                pass

    def shutdown(self) -> None:
        for session in list(self._sessions.values()):
            self.kill(session.id)

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
        decoded = chunk.decode("utf-8", errors="replace")
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

        # Cap individual WS messages at 64 KB to stay well below the point
        # where the Electron Network service becomes overwhelmed.
        _MAX_BYTES = 64 * 1024
        encoded = combined.encode("utf-8")
        if len(encoded) <= _MAX_BYTES:
            self._send_chunk(session, combined)
        else:
            # Split at valid UTF-8 character boundaries so multi-byte characters
            # (emoji, CJK, etc.) are never cut in half and replaced with U+FFFD.
            pos = 0
            while pos < len(encoded):
                end = min(pos + _MAX_BYTES, len(encoded))
                # Walk back to the start of a multi-byte sequence if we landed
                # inside one (continuation bytes have the form 10xxxxxx).
                while end > pos and (encoded[end] & 0xC0) == 0x80:
                    end -= 1
                self._send_chunk(session, encoded[pos:end].decode("utf-8"))
                pos = end

        # Persist cleaned output to the conversation log (if one was opened).
        if session.output_log_fp:
            try:
                session.output_log_fp.write(_clean_for_log(combined))
            except Exception as err:  # noqa: BLE001
                log.warning("output log write failed: %s", err)

    def _send_chunk(self, session: TerminalSession, data: str) -> None:
        session.sequence += 1
        event = make_event(
            "terminal.output",
            {
                "terminal_session_id": session.id,
                "pane_id": session.pane_id,
                "sequence": session.sequence,
                "data": data,
                "stream": "stdout",
            },
        )
        asyncio.create_task(self._emit(event))

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
        self._flush_output(session)
        # Best-effort wait for child to avoid zombies
        try:
            session.proc.poll()
        except Exception:
            pass
        exit_code = session.proc.returncode
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
            },
        )
        asyncio.create_task(self._emit(event))
        self._sessions.pop(session.id, None)
