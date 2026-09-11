"""Windows implementations of the platform seams.

Process enumeration and identity come from `psutil`; the terminal is a
ConPTY through `pywinpty` (3.x, the `winpty.PTY` class); and every terminal
child is placed in a Job Object created with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`.
The job is what gives Windows the property POSIX gets from process groups plus
the descendant snapshot: `kill_tree` is one `TerminateJobObject`, and if the
backend dies without cleaning up, the kernel closes the job handle and takes
the whole tree with it — the crash-recovery reaper has nothing left to find.

What Windows cannot offer, stated once here rather than hidden in the calls:

* No graceful signal. `force=False` and `force=True` both terminate; a CLI
  never gets a shutdown notice to flush its transcript.
* No foreground process group. `foreground_group()` is the child's pid.
* No reparenting. A process whose parent died keeps the stale ppid, so a
  snapshot reports `ppid=0` for it (see `_stale_parent`) and the EOF-path
  orphan sweep in `terminals` never matches — the job close covers it.
* No selectable fd. A worker thread pumps the ConPTY output pipe into a queue
  and wakes the event loop with `call_soon_threadsafe`; `read` serves the
  queue and raises `BlockingIOError` when it is empty.
* Writes to the ConPTY input pipe are synchronous (`WriteFile` on the loop
  thread) and always consume everything, so `watch_writable` only exists to
  satisfy the contract: it retries the drain after a short delay rather than
  spinning, and in practice is never reached.

`ctypes` calls into kernel32/shell32 are resolved lazily through
`_kernel32()`/`_shell32()` so this module imports on any platform (the
tests exercise it on macOS with those two functions stubbed).
"""

from __future__ import annotations

import asyncio
import codecs
import ctypes
import logging
import os
import shutil
import subprocess
import threading
import time
from collections import deque
from pathlib import Path
from typing import Any, Callable

import psutil

from .proctree import children_map, walk_descendants
from .spec import ProcInfo

log = logging.getLogger(__name__)


class WindowsPaths:
    """`%APPDATA%` / `%LOCALAPPDATA%`, falling back to their standard layout.

    The environment variables are normally set for any interactive session,
    but a service-started process may not have them, so the documented default
    path under the user profile is used rather than raising.
    """

    def app_support_dir(self, app_name: str, *, home: Path | None = None) -> Path:
        if home is not None:
            return home / "AppData" / "Roaming" / app_name
        configured = os.environ.get("APPDATA")
        base = Path(configured) if configured else Path.home() / "AppData" / "Roaming"
        return base / app_name

    def cache_dir(self, *, home: Path | None = None) -> Path:
        if home is not None:
            return home / "AppData" / "Local"
        configured = os.environ.get("LOCALAPPDATA")
        return Path(configured) if configured else Path.home() / "AppData" / "Local"


class WindowsResourceProbe:
    """Per-pid sampling is not ported yet; only the self peak is available."""

    def available(self) -> bool:
        return False

    def sample(self, pids: list[int]) -> dict[int, tuple[int, float]]:
        return {}

    def memory_kind(self) -> str:
        return "unavailable"

    def peak_rss_bytes(self) -> int | None:
        try:
            return int(psutil.Process().memory_info().peak_wset)
        except (psutil.Error, AttributeError, OSError):
            return None


# ---------------------------------------------------------------------------
# Win32 plumbing
# ---------------------------------------------------------------------------

JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
JobObjectExtendedLimitInformation = 9
PROCESS_TERMINATE = 0x0001
PROCESS_SET_QUOTA = 0x0100
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
SYNCHRONIZE = 0x00100000
WAIT_OBJECT_0 = 0x00000000
INFINITE = 0xFFFFFFFF
#: Exit code handed to TerminateProcess/TerminateJobObject.
_TERMINATE_EXIT_CODE = 1


class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_int64),
        ("PerJobUserTimeLimit", ctypes.c_int64),
        ("LimitFlags", ctypes.c_uint32),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", ctypes.c_uint32),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", ctypes.c_uint32),
        ("SchedulingClass", ctypes.c_uint32),
    ]


class _IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_uint64),
        ("WriteOperationCount", ctypes.c_uint64),
        ("OtherOperationCount", ctypes.c_uint64),
        ("ReadTransferCount", ctypes.c_uint64),
        ("WriteTransferCount", ctypes.c_uint64),
        ("OtherTransferCount", ctypes.c_uint64),
    ]


class _JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", _JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", _IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


_k32: Any = None
_sh32: Any = None


def _kernel32() -> Any:
    """kernel32 with the prototypes this module uses, resolved once."""
    global _k32
    if _k32 is None:
        from ctypes import wintypes

        k = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
        k.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
        k.CreateJobObjectW.restype = wintypes.HANDLE
        k.SetInformationJobObject.argtypes = [
            wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
        ]
        k.SetInformationJobObject.restype = wintypes.BOOL
        k.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
        k.AssignProcessToJobObject.restype = wintypes.BOOL
        k.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
        k.TerminateJobObject.restype = wintypes.BOOL
        k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        k.OpenProcess.restype = wintypes.HANDLE
        k.CloseHandle.argtypes = [wintypes.HANDLE]
        k.CloseHandle.restype = wintypes.BOOL
        k.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        k.WaitForSingleObject.restype = wintypes.DWORD
        k.GetExitCodeProcess.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
        k.GetExitCodeProcess.restype = wintypes.BOOL
        k.LocalFree.argtypes = [ctypes.c_void_p]
        k.LocalFree.restype = ctypes.c_void_p
        _k32 = k
    return _k32


def _shell32() -> Any:
    global _sh32
    if _sh32 is None:
        from ctypes import wintypes

        s = ctypes.WinDLL("shell32", use_last_error=True)  # type: ignore[attr-defined]
        s.CommandLineToArgvW.argtypes = [wintypes.LPCWSTR, ctypes.POINTER(ctypes.c_int)]
        s.CommandLineToArgvW.restype = ctypes.POINTER(wintypes.LPWSTR)
        _sh32 = s
    return _sh32


def _win_error() -> OSError:
    return ctypes.WinError(ctypes.get_last_error())  # type: ignore[attr-defined]


def _split_command_line(command: str) -> list[str]:
    """`CommandLineToArgvW`: the OS's own parsing, so what we split is what
    the child would have seen had the string been handed to CreateProcess."""
    if not command.strip():
        return []
    k = _kernel32()
    argc = ctypes.c_int(0)
    argv = _shell32().CommandLineToArgvW(command, ctypes.byref(argc))
    if not argv:
        raise _win_error()
    try:
        return [argv[i] for i in range(argc.value)]
    finally:
        k.LocalFree(argv)


def _create_kill_on_close_job() -> int:
    """A job whose every process dies when its last handle closes."""
    k = _kernel32()
    job = k.CreateJobObjectW(None, None)
    if not job:
        raise _win_error()
    info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not k.SetInformationJobObject(
        job, JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info)
    ):
        err = _win_error()
        k.CloseHandle(job)
        raise err
    return int(job)


def _assign_to_job(job: int, pid: int) -> None:
    k = _kernel32()
    handle = k.OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, False, pid)
    if not handle:
        raise _win_error()
    try:
        if not k.AssignProcessToJobObject(job, handle):
            raise _win_error()
    finally:
        k.CloseHandle(handle)


#: Root pid -> job handle for every live terminal. `kill_tree` on a root pid
#: terminates the job instead of walking the table, which also reaches
#: grandchildren that were spawned after the last snapshot.
_jobs: dict[int, int] = {}
_jobs_lock = threading.Lock()


def _register_job(pid: int, job: int) -> None:
    with _jobs_lock:
        _jobs[pid] = job


def _release_job(pid: int) -> None:
    """Close the job handle — with KILL_ON_JOB_CLOSE that ends the tree."""
    with _jobs_lock:
        job = _jobs.pop(pid, None)
    if job is not None:
        _kernel32().CloseHandle(job)


def _terminate_job(pid: int) -> bool:
    with _jobs_lock:
        job = _jobs.get(pid)
    if job is None:
        return False
    return bool(_kernel32().TerminateJobObject(job, _TERMINATE_EXIT_CODE))


# ---------------------------------------------------------------------------
# Process tree
# ---------------------------------------------------------------------------


def _start_str(create_time: float | None) -> str:
    return "" if create_time is None else repr(float(create_time))


def _translate(exc: psutil.Error) -> OSError:
    """psutil's exceptions are not OSError subclasses; callers expect the
    POSIX ones so they can keep a single `except` clause."""
    if isinstance(exc, psutil.NoSuchProcess):
        return ProcessLookupError(exc.pid)
    if isinstance(exc, psutil.AccessDenied):
        return PermissionError(str(exc))
    return OSError(str(exc))


class WindowsProcessTree:
    """`psutil` for the table, Job Objects / `TerminateProcess` for kills."""

    def snapshot(self) -> dict[int, ProcInfo]:
        rows: dict[int, tuple[int, float | None]] = {}
        try:
            for proc in psutil.process_iter(["ppid", "create_time"]):
                info = proc.info
                try:
                    ppid = int(info.get("ppid") or 0)
                except (TypeError, ValueError):
                    ppid = 0
                rows[proc.pid] = (ppid, info.get("create_time"))
        except psutil.Error:
            return {}
        snap: dict[int, ProcInfo] = {}
        for pid, (ppid, created) in rows.items():
            if _stale_parent(rows, ppid, created):
                ppid = 0
            snap[pid] = ProcInfo(ppid, pid, _start_str(created))
        return snap

    def descendants(self, pid: int) -> list[int]:
        return walk_descendants(children_map(self.snapshot()), pid)

    def group_of(self, pid: int) -> int:
        if not psutil.pid_exists(pid):
            raise ProcessLookupError(pid)
        return pid

    def start_time(self, pid: int) -> str:
        try:
            return _start_str(psutil.Process(pid).create_time())
        except psutil.Error:
            return ""

    def identity(self, pid: int) -> str:
        return f"{pid}:{self.start_time(pid)}"

    def command_of(self, pid: int) -> str | None:
        try:
            proc = psutil.Process(pid)
            return subprocess.list2cmdline(proc.cmdline()) or proc.name()
        except psutil.NoSuchProcess:
            return ""
        except psutil.Error:
            return None

    def is_alive(self, pid: int) -> bool:
        return psutil.pid_exists(pid)

    def kill(self, pid: int, *, force: bool) -> None:
        # Both `force` values are TerminateProcess: Windows has no SIGTERM.
        try:
            psutil.Process(pid).kill()
        except psutil.Error as exc:
            raise _translate(exc) from None

    def kill_group(self, gid: int, *, force: bool) -> None:
        # No process groups: the "group" is the subtree rooted at gid.
        self.kill_tree(gid, force=force)

    def kill_tree(self, pid: int, *, force: bool) -> None:
        if _terminate_job(pid):
            return
        try:
            root = psutil.Process(pid)
            children = root.children(recursive=True)
            # Root first so it cannot fork replacements while the list dies.
            root.kill()
        except psutil.Error as exc:
            raise _translate(exc) from None
        for child in children:
            try:
                child.kill()
            except psutil.Error:
                pass


def _stale_parent(
    rows: dict[int, tuple[int, float | None]], ppid: int, created: float | None
) -> bool:
    """Whether a ppid points at a process that is not really the parent.

    Windows never reparents: a process whose parent exited keeps the old ppid,
    and once that number is recycled the table shows an unrelated process as
    its parent. A parent that started after its child cannot be its parent.
    """
    parent = rows.get(ppid)
    if parent is None:
        return True
    parent_created = parent[1]
    if parent_created is None or created is None:
        return False
    return parent_created > created


# ---------------------------------------------------------------------------
# Terminal
# ---------------------------------------------------------------------------


class _WindowsChild:
    """`subprocess.Popen`'s `pid/poll/wait/returncode` over a process handle.

    Holds its own `OpenProcess` handle rather than the one pywinpty keeps, so
    the exit code is still readable after the pseudoconsole has been released.
    """

    def __init__(self, pid: int, handle: int) -> None:
        self.pid = pid
        self.returncode: int | None = None
        self._handle = handle

    def poll(self) -> int | None:
        if self.returncode is not None:
            return self.returncode
        k = _kernel32()
        if k.WaitForSingleObject(self._handle, 0) != WAIT_OBJECT_0:
            return None
        code = ctypes.c_uint32(0)
        if k.GetExitCodeProcess(self._handle, ctypes.byref(code)):
            self.returncode = int(code.value)
        else:
            self.returncode = _TERMINATE_EXIT_CODE
        k.CloseHandle(self._handle)
        return self.returncode

    def wait(self, timeout: float | None = None) -> int:
        if self.returncode is not None:
            return self.returncode
        millis = INFINITE if timeout is None else max(0, int(timeout * 1000))
        if _kernel32().WaitForSingleObject(self._handle, millis) != WAIT_OBJECT_0:
            raise subprocess.TimeoutExpired(str(self.pid), timeout or 0)
        code = self.poll()
        return code if code is not None else _TERMINATE_EXIT_CODE


#: Sleep between two consecutive empty reads while the child is still alive
#: (the reader channel came back empty but the process has not gone yet).
_PUMP_IDLE_S = 0.001
#: How long `watch_writable` waits before retrying a drain (see module doc).
_WRITE_RETRY_S = 0.05


class WindowsTerminalHandle:
    """A ConPTY plus the job that owns its child.

    Output flows pump thread -> `_chunks` -> `read()` on the loop thread; the
    pump wakes the loop at most once per batch (`_scheduled`), and the
    delivery callback re-arms itself while chunks remain so a caller that
    drains in bounded slices keeps getting called, the way a level-triggered
    `add_reader` would.
    """

    def __init__(self, pty: Any, pid: int, job: int | None, process_handle: int) -> None:
        self._pty: Any = pty
        self.pid = pid
        self._job = job
        self.proc = _WindowsChild(pid, process_handle)
        self._chunks: deque[bytes] = deque()
        self._lock = threading.Lock()
        self._eof = False
        self._closed = False
        self._loop: asyncio.AbstractEventLoop | None = None
        self._callback: Callable[[], None] | None = None
        self._paused = False
        self._scheduled = False
        self._pump: threading.Thread | None = None
        self._write_retry: asyncio.TimerHandle | None = None
        # Input arrives as UTF-8 bytes and pywinpty wants text; a chunk that
        # ends mid-character keeps its tail here until the rest arrives.
        self._input_decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")

    # -- output ---------------------------------------------------------------

    def read(self, max_bytes: int) -> bytes | None:
        with self._lock:
            if not self._chunks:
                if self._eof:
                    return None
                raise BlockingIOError(11, "no output pending")
            head = self._chunks[0]
            if len(head) <= max_bytes:
                self._chunks.popleft()
                return head
            self._chunks[0] = head[max_bytes:]
            return head[:max_bytes]

    def start_reading(
        self, loop: asyncio.AbstractEventLoop, callback: Callable[[], None]
    ) -> None:
        with self._lock:
            self._loop = loop
            self._callback = callback
            self._paused = False
            start = self._pump is None and not self._closed
            if start:
                self._pump = threading.Thread(
                    target=self._run_pump,
                    args=(self._pty,),
                    name=f"conpty-pump-{self.pid}",
                    daemon=True,
                )
        if start:
            self._pump.start()  # type: ignore[union-attr]
        else:
            self._notify()

    def pause_reading(self) -> None:
        with self._lock:
            self._paused = True

    def resume_reading(self) -> None:
        with self._lock:
            self._paused = False
        self._notify()

    def stop_reading(self) -> None:
        with self._lock:
            self._callback = None
            self._paused = True

    def _run_pump(self, pty: Any) -> None:
        """Worker: block on the ConPTY output until EOF, queueing every chunk.

        `PTY.read(blocking=True)` raises once winpty-rs's own reader has hit
        EOF or had its I/O cancelled, and returns "" once that reader thread
        has gone; an empty result while the child still lives is idled on
        briefly rather than spun on.
        """
        try:
            while not self._closed:
                try:
                    text = pty.read(blocking=True)
                except Exception:  # noqa: BLE001 — WinptyError: EOF or cancelled
                    break
                if text:
                    self._enqueue(text.encode("utf-8", "replace"))
                    continue
                try:
                    if pty.iseof() or not pty.isalive():
                        break
                except Exception:  # noqa: BLE001
                    break
                time.sleep(_PUMP_IDLE_S)
        finally:
            with self._lock:
                self._eof = True
            self._notify()

    def _enqueue(self, data: bytes) -> None:
        with self._lock:
            self._chunks.append(data)
        self._notify()

    def _notify(self) -> None:
        with self._lock:
            loop = self._loop
            if (
                loop is None
                or self._callback is None
                or self._paused
                or self._scheduled
                or not (self._chunks or self._eof)
            ):
                return
            self._scheduled = True
        loop.call_soon_threadsafe(self._deliver)

    def _deliver(self) -> None:
        with self._lock:
            self._scheduled = False
            callback = self._callback
            paused = self._paused
        if callback is None or paused:
            return
        callback()
        # Level-triggered: a bounded drain leaves the rest for the next tick.
        with self._lock:
            rearm = bool(self._chunks) and self._callback is not None and not self._paused
            if rearm and not self._scheduled and self._loop is not None:
                self._scheduled = True
                self._loop.call_soon(self._deliver)

    # -- input ----------------------------------------------------------------

    def write(self, data: bytes) -> int:
        if self._closed:
            raise OSError("terminal is closed")
        text = self._input_decoder.decode(data)
        if text:
            try:
                self._pty.write(text)
            except Exception as exc:  # noqa: BLE001 — WinptyError has no errno
                raise OSError(str(exc)) from None
        return len(data)

    def watch_writable(
        self, loop: asyncio.AbstractEventLoop, callback: Callable[[], None]
    ) -> None:
        self.unwatch_writable()
        self._write_retry = loop.call_later(_WRITE_RETRY_S, callback)

    def unwatch_writable(self) -> None:
        if self._write_retry is not None:
            self._write_retry.cancel()
            self._write_retry = None

    # -- control --------------------------------------------------------------

    def resize(self, rows: int, cols: int) -> None:
        try:
            self._pty.set_size(cols, rows)
        except Exception as exc:  # noqa: BLE001
            raise OSError(str(exc)) from None

    def foreground_group(self) -> int:
        return self.pid

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self.unwatch_writable()
        # Closing the job handle is the kill (KILL_ON_JOB_CLOSE) — the same
        # outcome the POSIX close reaches through SIGHUP on the master.
        if self._job is not None:
            _release_job(self.pid)
        else:
            try:
                process_tree.kill_tree(self.pid, force=True)
            except OSError:
                pass
        pty, self._pty = self._pty, None
        if pty is not None:
            try:
                # Unblock a pump parked in ReadFile so it can exit and drop the
                # last reference; the pseudoconsole is released when it does.
                pty.cancel_io()
            except Exception:  # noqa: BLE001
                pass


class WindowsTerminalBackend:
    """`winpty.PTY` (ConPTY) with the child assigned to a kill-on-close job."""

    def parse_command(self, command: str) -> list[str]:
        return _split_command_line(command)

    def spawn(
        self,
        argv: list[str] | str,
        *,
        cwd: str,
        env: dict[str, str],
        rows: int,
        cols: int,
    ) -> WindowsTerminalHandle:
        # A ready-made command line is parsed by the OS's own rules and
        # rebuilt with the same quoting, so both shapes take one path below.
        words = self.parse_command(argv) if isinstance(argv, str) else list(argv)
        if not words:
            raise ValueError("command is empty")
        # PATHEXT lookup: `claude` resolves to npm's `claude.cmd` shim. The
        # application name is left NULL at CreateProcess (winpty-rs puts it at
        # the head of the command line instead), which is what makes Windows
        # run a .cmd through the interpreter at all.
        exe = shutil.which(words[0], path=env.get("PATH") or None)
        if not exe:
            raise FileNotFoundError(f"executable not found: {words[0]}")
        appname = subprocess.list2cmdline([exe])
        cmdline = subprocess.list2cmdline(words[1:]) or None
        env_block = "\0".join(f"{k}={v}" for k, v in env.items()) + "\0"
        try:
            import winpty
        except ImportError as exc:  # pragma: no cover - dependency marker
            raise RuntimeError("pywinpty is required for terminals on Windows") from exc
        pty = winpty.PTY(cols, rows)
        try:
            pty.spawn(appname, cmdline=cmdline, cwd=cwd, env=env_block)
        except Exception as exc:  # noqa: BLE001 — WinptyError carries only text
            raise OSError(f"spawn failed: {exc}") from None
        pid = pty.pid
        if not pid:
            raise OSError("spawn failed: no pid")
        pid = int(pid)
        k = _kernel32()
        process_handle = k.OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, False, pid
        )
        if not process_handle:
            err = _win_error()
            _kill_orphaned_spawn(pty, pid)
            raise err
        job: int | None
        try:
            job = _create_kill_on_close_job()
            _assign_to_job(job, pid)
        except OSError as exc:
            # Degraded, not fatal: the pane still works, kill_tree falls
            # back to walking the table, and a backend crash leaks the tree.
            log.warning("job object unavailable for pid %s: %s", pid, exc)
            job = None
        if job is not None:
            _register_job(pid, job)
        return WindowsTerminalHandle(pty, pid, job, int(process_handle))


def _kill_orphaned_spawn(pty: Any, pid: int) -> None:
    try:
        psutil.Process(pid).kill()
    except psutil.Error:
        pass
    try:
        pty.cancel_io()
    except Exception:  # noqa: BLE001
        pass


paths = WindowsPaths()
resource_probe = WindowsResourceProbe()
process_tree = WindowsProcessTree()
terminal_backend = WindowsTerminalBackend()


# ---- appended: Paths members and SecretFiles for the Windows port -----------
#
# Re-added after a whole-file rewrite of this module clobbered the first
# version. A subclass rather than edits to `WindowsPaths` above, so this lands
# as a pure append; `paths` is rebound below to the complete implementation.

import tempfile  # noqa: E402


class WindowsLayout(WindowsPaths):
    def state_dir(self, app_name: str) -> Path:
        # One directory for both roles on Windows: `%APPDATA%\<app>`.
        return self.app_support_dir(app_name)

    def config_home(self, home: Path) -> Path:
        configured = os.environ.get("APPDATA")
        return Path(configured) if configured else home / "AppData" / "Roaming"

    def roaming_app_data(self) -> Path | None:
        configured = os.environ.get("APPDATA")
        return Path(configured) if configured else None

    def home_env_var(self) -> str:
        return "USERPROFILE"

    def isolated_home_env(self, home_dir: Path) -> dict[str, str]:
        home = str(home_dir)
        return {"USERPROFILE": home, "HOME": home, "TEMP": home, "TMP": home}

    def askpass_launcher(self, helper_py: Path, python_exe: str | None) -> Path:
        """A sibling `.cmd` that runs the helper through an interpreter.

        git execs `GIT_ASKPASS` with no shell and Windows cannot exec a
        `.py`. `python_exe` None (a frozen build) falls back to `python` on
        PATH. Rewritten only when its content differs, so a launcher that is
        already right keeps its mtime and no other process sees it flicker.
        """
        launcher = helper_py.with_suffix(".cmd")
        interpreter = python_exe or "python"
        content = f'@"{interpreter}" "{helper_py}" %*\r\n'.encode("utf-8")
        try:
            if launcher.read_bytes() == content:
                return launcher
        except OSError:
            pass
        launcher.write_bytes(content)
        return launcher


# -- DPAPI-backed secret files --------------------------------------------------
#
# `os.chmod(0o600)` is a no-op on NTFS, so mode bits cannot protect a secret
# here. `write_private` wraps the content with `CryptProtectData` instead:
# only the same Windows account can unwrap it, whichever ACL the file ends up
# with. `write_private_plain` stays in the clear because another program has
# to read it; an owner-only ACL for that case is the missing piece.

#: Header that marks a DPAPI-wrapped file; anything without it is read as-is.
DPAPI_MAGIC = b"NAVIDE-DPAPI-1\n"
#: `CRYPTPROTECT_UI_FORBIDDEN`: a headless backend must never pop a dialog.
CRYPTPROTECT_UI_FORBIDDEN = 0x1


class _DATA_BLOB(ctypes.Structure):
    _fields_ = [("cbData", ctypes.c_uint32), ("pbData", ctypes.POINTER(ctypes.c_char))]


_c32: Any = None


def _crypt32() -> Any:
    global _c32
    if _c32 is None:
        c = ctypes.WinDLL("crypt32", use_last_error=True)  # type: ignore[attr-defined]
        blob = ctypes.POINTER(_DATA_BLOB)
        c.CryptProtectData.argtypes = [
            blob, ctypes.c_wchar_p, blob, ctypes.c_void_p, ctypes.c_void_p,
            ctypes.c_uint32, blob,
        ]
        c.CryptProtectData.restype = ctypes.c_int
        c.CryptUnprotectData.argtypes = [
            blob, ctypes.POINTER(ctypes.c_wchar_p), blob, ctypes.c_void_p,
            ctypes.c_void_p, ctypes.c_uint32, blob,
        ]
        c.CryptUnprotectData.restype = ctypes.c_int
        _c32 = c
    return _c32


def _local_free(pointer: Any) -> None:
    """DPAPI output buffers are LocalAlloc'd by the system."""
    _kernel32().LocalFree(pointer)


def _dpapi(name: str, data: bytes) -> bytes:
    source = ctypes.create_string_buffer(data, len(data))
    blob_in = _DATA_BLOB(len(data), ctypes.cast(source, ctypes.POINTER(ctypes.c_char)))
    blob_out = _DATA_BLOB()
    ok = getattr(_crypt32(), name)(
        ctypes.byref(blob_in), None, None, None, None,
        CRYPTPROTECT_UI_FORBIDDEN, ctypes.byref(blob_out),
    )
    if not ok:
        try:
            raise _win_error()
        except AttributeError:  # not on Windows: no WinError to consult
            raise OSError(f"{name} failed") from None
    try:
        return ctypes.string_at(blob_out.pbData, blob_out.cbData)
    finally:
        _local_free(blob_out.pbData)


def _write_atomic(path: Path, data: bytes) -> None:
    """Same-directory temp file moved into place; nothing left on failure."""
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=path.name + ".")
    tmp = Path(tmp_name)
    try:
        try:
            os.write(handle, data)
        finally:
            os.close(handle)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


class WindowsSecretFiles:
    """`SecretFiles` through DPAPI; directory ACLs are out of scope for now."""

    def write_private(self, path: Path, data: bytes) -> None:
        # Wrap first: a DPAPI failure must leave no file behind at all.
        wrapped = DPAPI_MAGIC + _dpapi("CryptProtectData", data)
        _write_atomic(path, wrapped)

    def write_private_plain(self, path: Path, data: bytes) -> None:
        _write_atomic(path, data)

    def read_private(self, path: Path) -> bytes:
        raw = path.read_bytes()
        if not raw.startswith(DPAPI_MAGIC):
            return raw  # legacy plaintext, or copied over from a POSIX machine
        return _dpapi("CryptUnprotectData", raw[len(DPAPI_MAGIC):])

    def harden_file(self, path: Path) -> None:
        # No ACL rewrite yet; still reports a missing file like the POSIX one.
        path.stat()

    def make_private_dir(self, path: Path) -> None:
        path.mkdir(parents=True, exist_ok=True)




# ---- appended: discovery, shell and symlink members of Paths ----------------

_DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD"


def _pathext() -> list[str]:
    raw = os.environ.get("PATHEXT") or _DEFAULT_PATHEXT
    # Always ";": PATHEXT is a Windows variable even when read on another OS.
    return [ext.lower() for ext in raw.split(";") if ext.startswith(".")]


#: Result of the one-time symlink probe; None until first asked.
_symlinks_available: bool | None = None


def _probe_symlinks() -> bool:
    """Create one link in a temp dir. `WinError 1314` (privilege not held)
    is the ordinary answer on a box without Developer Mode."""
    with tempfile.TemporaryDirectory(prefix="navide-symlink-") as tmp:
        target = Path(tmp) / "target"
        target.write_bytes(b"")
        try:
            os.symlink(target, Path(tmp) / "link")
        except OSError as err:
            log.warning(
                "symbolic links are not available to this process (%s); "
                "per-pane CLI homes and managed skills stay unwired — enable "
                "Windows Developer Mode (Settings > For developers) or run "
                "Navide elevated",
                err,
            )
            return False
    return True


class WindowsDiscoveryLayout(WindowsLayout):
    def executable_candidates(self, name: str) -> list[str]:
        exts = _pathext()
        if any(name.lower().endswith(ext) for ext in exts):
            return [name]
        return [name + ext for ext in exts]

    def is_executable(self, path: Path) -> bool:
        # No execute bit on NTFS: runnability is the extension, and
        # `executable_candidates` only ever names runnable ones.
        return True

    def login_path_probe(self) -> list[str] | None:
        # No login shell: PATH comes from the registry and the process
        # already carries it.
        return None

    def backend_entry_on_disk(self, entry: str) -> str:
        if Path(entry).suffix:
            return entry
        return entry + ".exe"

    def enforces_posix_modes(self) -> bool:
        return False

    def symlinks_available(self) -> bool:
        global _symlinks_available
        if _symlinks_available is None:
            _symlinks_available = _probe_symlinks()
        return _symlinks_available

    def shell_command(self, command: str) -> list[str]:
        return ["cmd.exe", "/d", "/s", "/c", command]


class WindowsScheduler:
    """Inert: neither cron nor launchd exists here, and Task Scheduler is
    not wired (see `spec.Scheduler`). Lists as unsupported without spawning
    anything; mutations name the platform."""

    async def list_jobs(self, kind: str) -> dict:
        if kind == "crontab":
            return {"supported": False, "entries": [], "unparsed": 0, "error": None}
        if kind == "launchagent":
            return {"supported": False, "entries": [], "unreadable": 0, "error": None}
        raise ValueError(f"unknown execution kind: {kind!r}")

    async def set_enabled(self, kind: str, target: str, enabled: bool) -> None:
        self._refuse(kind)

    async def remove(self, kind: str, target: str) -> None:
        self._refuse(kind)

    @staticmethod
    def _refuse(kind: str) -> None:
        if kind not in ("crontab", "launchagent"):
            raise ValueError(f"unknown execution kind: {kind!r}")
        from .spec import SchedulerError

        raise SchedulerError(
            f"{kind} jobs cannot be managed on Windows (no cron or launchd; "
            "Task Scheduler is not integrated)"
        )


paths = WindowsDiscoveryLayout()
secret_files = WindowsSecretFiles()
scheduler = WindowsScheduler()
