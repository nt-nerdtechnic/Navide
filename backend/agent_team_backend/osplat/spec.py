"""The contracts a platform implementation has to satisfy.

Named `osplat`, not `platform`, because `platform` is a stdlib module and a
package by that name inside the backend would shadow it for every importer.

Each Protocol here is a seam that already existed as a `sys.platform` branch
somewhere in the backend. Moving the branch here is the whole point: a feature
module asks the seam for a capability and never asks which OS it is running
on, so adding a platform means adding one implementation file rather than
finding every branch that needs a third arm.

A capability an implementation cannot provide reports `available() is False`
rather than raising or guessing. Callers already tolerate that shape — it is
how `proc_rusage` behaved on every non-Darwin platform — so a partial port
degrades to "this panel shows nothing" instead of taking down the request.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Callable, NamedTuple, Protocol


class Paths(Protocol):
    """Where this platform keeps the kinds of directory the backend looks in.

    These are *other* applications' conventions as much as our own: Navide
    reads the state directories of the coding CLIs and IDEs it integrates
    with, and each platform puts them somewhere different. Hard-coding one
    platform's layout is how `cli_vendors/cursor.py` ended up unable to find
    Cursor's database anywhere but macOS, even though the IDE ships on all
    three.
    """

    def app_support_dir(self, app_name: str, *, home: Path | None = None) -> Path:
        """The per-user state directory a desktop application of this name owns.

        macOS puts it under `~/Library/Application Support`, Linux under
        `$XDG_CONFIG_HOME` (or `~/.config`), Windows under `%APPDATA%`. This is
        the convention the whole VS Code family follows, Cursor included.

        `home` overrides the user's home directory, for the per-pane homes the
        credential vault builds. An explicit `home` wins over the XDG
        environment variables, which would otherwise point back at the real
        home and defeat the isolation.
        """
        ...

    def cache_dir(self, *, home: Path | None = None) -> Path:
        """The per-user cache directory: discardable, not backed up."""
        ...

    def state_dir(self, app_name: str) -> Path:
        """Where *this* application keeps its own state (`applog.app_data_dir`).

        Not the same as `app_support_dir` on Linux: the backend has always
        lived under `$XDG_DATA_HOME` (`~/.local/share`) there, and moving it
        to `~/.config` would strand every existing install's state. macOS and
        Windows have one directory for both roles.
        """
        ...

    def config_home(self, home: Path) -> Path:
        """The per-user config root under `home`, as `os.UserConfigDir()` sees it.

        `~/Library/Application Support` on macOS, `~/.config` on Linux,
        `%APPDATA%` (falling back to `home/AppData/Roaming`) on Windows. This
        is the convention Go CLIs follow (glab included), so it is what a
        caller needs to find such a tool's config when it has not been
        overridden by the tool's own environment variable.
        """
        ...

    def roaming_app_data(self) -> Path | None:
        """`%APPDATA%` on Windows; None where the concept does not exist.

        For the few tools that special-case Windows *by name* rather than via
        `config_home` — `gh` keeps `~/.config/gh` everywhere except under
        `%APPDATA%\\GitHub CLI` — so the caller can express "the Windows
        directory if there is one, else the POSIX default" without asking
        which platform it is on.
        """
        ...

    def home_env_var(self) -> str:
        """The environment variable naming the user's home: `HOME` or `USERPROFILE`."""
        ...

    def isolated_home_env(self, home_dir: Path) -> dict[str, str]:
        """Environment entries that move a child process's home and temp dir.

        POSIX children read `HOME` and `TMPDIR`; Windows children read
        `USERPROFILE` plus `TEMP`/`TMP`, and `HOME` too because several Node
        CLIs consult it first.
        """
        ...

    def askpass_launcher(self, helper_py: Path, python_exe: str | None) -> Path:
        """The path git can exec as `GIT_ASKPASS` to run `helper_py`.

        git execs `GIT_ASKPASS` directly, with no shell. POSIX can run the
        script itself through its shebang, so the answer is `helper_py` made
        executable. Windows cannot exec a `.py`, so a sibling `.cmd` that
        invokes `python_exe` on it is written and returned instead; a
        `python_exe` of None means this process carries no interpreter of its
        own (a frozen build) and the one on `PATH` is used, which is what the
        shebang's `/usr/bin/env python3` already relies on elsewhere.
        """
        ...

    def executable_candidates(self, name: str) -> list[str]:
        """The file names a command called `name` may have on disk here.

        POSIX: just `name`. Windows: `name` plus each `PATHEXT` suffix
        (`.exe`, `.cmd`, `.bat`, `.com`) unless `name` already carries one,
        in the order `shutil.which` would try them.
        """
        ...

    def is_executable(self, path: Path) -> bool:
        """Whether an existing file at `path` can be run.

        POSIX asks the mode bits (`os.access(X_OK)`); Windows has no such
        bit — a file is runnable because of its extension, which
        `executable_candidates` already chose — so it answers True.
        """
        ...

    def login_path_probe(self) -> list[str] | None:
        """argv that prints the user's login-shell `PATH`, or None when the
        platform has no login shell whose `PATH` differs from ours.

        Installers on POSIX write `PATH` exports into shell rc files, which a
        GUI-launched backend never read; the probe recovers them. Windows
        keeps `PATH` in the registry and the process already has it, so there
        is nothing to probe — None tells the caller to keep what it has.
        """
        ...

    def backend_entry_on_disk(self, entry: str) -> str:
        """The file a plugin manifest's bare `backend.entry` names on disk.

        Mirrors `backendEntryOnDisk` in the Electron main process: a bare
        name (no extension) gains `.exe` on Windows and stays as it is
        everywhere else; an entry with an explicit extension is never changed.
        """
        ...

    def enforces_posix_modes(self) -> bool:
        """Whether a file's mode bits mean anything on this platform.

        A check that a secret file is `0600` is meaningful on POSIX and
        vacuous on NTFS, where `st_mode` is synthesised and never restricts
        anyone — so a caller that would refuse an over-permissive file
        asks this first.
        """
        ...

    def symlinks_available(self) -> bool:
        """Whether this process may create symbolic links.

        Always on POSIX. On Windows `os.symlink` needs Developer Mode or an
        elevated token and otherwise fails with `WinError 1314`; the answer is
        probed once (a link in a temp dir) and cached, so a shim built from
        hundreds of links learns the answer up front rather than logging one
        failure per file.
        """
        ...

    def shell_command(self, command: str) -> list[str]:
        """argv that runs `command` through the platform's shell.

        `/bin/sh -c` on POSIX; `cmd.exe /d /s /c` on Windows (`/d` skips
        AutoRun, `/s` keeps the outer quotes intact).
        """
        ...


class ResourceProbe(Protocol):
    """Per-process memory and CPU, read from the kernel without a subprocess.

    Both numbers come back from one call because every platform that can answer
    cheaply answers both at once: Darwin's `proc_pid_rusage` fills one struct,
    and Linux's `/proc/<pid>/` entries are two reads of the same directory.
    Splitting them would double the syscall count for the panel that wants
    both.
    """

    def available(self) -> bool:
        """Whether this probe can be used at all on this machine."""
        ...

    def sample(self, pids: list[int]) -> dict[int, tuple[int, float]]:
        """`{pid: (memory bytes, accumulated CPU seconds)}` for what answered.

        A pid that has died, or that belongs to another user, simply does not
        appear. Never raises.
        """
        ...

    def memory_kind(self) -> str:
        """Which memory counter `sample` reports, for the UI to label honestly.

        The platforms do not measure the same thing: Darwin reports
        `phys_footprint`, Linux reports proportional set size. Both charge
        shared pages once across the processes sharing them, which is the
        property that matters, but they are not interchangeable figures and a
        panel that says "Memory" without qualification invites a bug report
        comparing it against the wrong system tool.
        """
        ...

    def peak_rss_bytes(self) -> int | None:
        """This process's peak resident set size in bytes, or None when unknown.

        POSIX reads `getrusage(RUSAGE_SELF).ru_maxrss` — bytes on Darwin,
        kilobytes on Linux, which is why the conversion lives in the
        implementation and not in the caller. Windows reports `PeakWorkingSetSize`.
        """
        ...


class ProcInfo(NamedTuple):
    """One row of a process-table snapshot.

    A plain tuple on purpose: `terminals` and `pty_registry` index the rows
    positionally, and tests build them as bare tuples.
    """

    #: Parent pid.
    ppid: int
    #: The unit a group kill reaches. POSIX: the process group id. Windows has
    #: no process groups, so every process is its own group (`gid == pid`) and
    #: `kill_group` takes the subtree rooted there instead.
    gid: int
    #: Start-time identity string, "" when unknown. Two rows with the same pid
    #: and the same non-empty `start` are the same process; a recycled pid gets
    #: a different one. POSIX uses `ps lstart`, Windows the creation time.
    start: str


class ProcessTree(Protocol):
    """Enumerate, identify and kill processes and their descendants.

    Every kill raises `ProcessLookupError` when the target is already gone and
    `PermissionError` when it belongs to someone else, whatever the platform,
    so callers keep one `except` clause.

    `force` selects the signal on POSIX: False sends SIGTERM (the CLI gets to
    flush its transcript), True sends SIGKILL. Windows has no graceful signal
    at all — both map to `TerminateProcess`/`TerminateJobObject`, so a Windows
    CLI never sees a shutdown notice before it dies.
    """

    def snapshot(self) -> dict[int, ProcInfo]:
        """Every visible process, from one table read. Empty when the probe failed."""
        ...

    def descendants(self, pid: int) -> list[int]:
        """Every pid below `pid` (children, grandchildren, ...) from one snapshot."""
        ...

    def group_of(self, pid: int) -> int:
        """The group id a `kill_group` on this process needs; ProcessLookupError when gone."""
        ...

    def start_time(self, pid: int) -> str:
        """The `ProcInfo.start` identity string for one pid, "" when unknown."""
        ...

    def identity(self, pid: int) -> str:
        """`"<pid>:<start_time>"` — stable across exec, different after pid reuse."""
        ...

    def command_of(self, pid: int) -> str | None:
        """The process's command line; "" when no such process, None when the probe failed."""
        ...

    def is_alive(self, pid: int) -> bool:
        """Whether a process with this pid currently exists."""
        ...

    def kill(self, pid: int, *, force: bool) -> None:
        """Signal one process (SIGTERM/SIGKILL; TerminateProcess on Windows)."""
        ...

    def kill_group(self, gid: int, *, force: bool) -> None:
        """Signal a whole group: killpg on POSIX, the job/subtree rooted at `gid` on Windows."""
        ...

    def kill_tree(self, pid: int, *, force: bool) -> None:
        """Kill `pid` and every descendant, including ones that left its group."""
        ...


class ChildProcess(Protocol):
    """The slice of `subprocess.Popen` a terminal session relies on."""

    pid: int
    returncode: int | None

    def poll(self) -> int | None:
        """Exit code once the child has exited, None while it runs."""
        ...

    def wait(self, timeout: float | None = None) -> int:
        """Block for the exit code; `subprocess.TimeoutExpired` after `timeout`."""
        ...


class TerminalHandle(Protocol):
    """One spawned terminal: its byte streams, its size and its child.

    Readability reaches the event loop through `start_reading`: on POSIX the
    handle registers its master fd with `loop.add_reader`, on Windows a worker
    thread pumps the ConPTY pipe and wakes the loop with
    `call_soon_threadsafe`. Either way the callback runs on the loop thread
    and drains with `read` until `BlockingIOError`, so the caller has exactly
    one code path.
    """

    #: The child's pid.
    pid: int
    #: The child, for `poll`/`wait`/`returncode`.
    proc: ChildProcess

    def read(self, max_bytes: int) -> bytes | None:
        """Up to `max_bytes` of output; None at EOF; BlockingIOError when nothing is ready."""
        ...

    def write(self, data: bytes) -> int:
        """Bytes accepted (may be fewer); BlockingIOError when none could be taken now."""
        ...

    def resize(self, rows: int, cols: int) -> None:
        """Change the terminal size (SIGWINCH on POSIX, ResizePseudoConsole on Windows)."""
        ...

    def foreground_group(self) -> int:
        """The group in front of the tty (tcgetpgrp), 0 when unknown; the child's pid on Windows."""
        ...

    def start_reading(
        self, loop: asyncio.AbstractEventLoop, callback: Callable[[], None]
    ) -> None:
        """Arrange for `callback()` on the loop thread whenever output is readable."""
        ...

    def pause_reading(self) -> None:
        """Stop readability callbacks (backpressure); output stays queued in the kernel/pump."""
        ...

    def resume_reading(self) -> None:
        """Undo `pause_reading`; ValueError/OSError when the handle can no longer be watched."""
        ...

    def stop_reading(self) -> None:
        """Detach the readability callback for good (close path)."""
        ...

    def watch_writable(
        self, loop: asyncio.AbstractEventLoop, callback: Callable[[], None]
    ) -> None:
        """Arrange for `callback()` once `write` would accept more bytes."""
        ...

    def unwatch_writable(self) -> None:
        """Cancel `watch_writable`; a no-op when nothing is being watched."""
        ...

    def close(self) -> None:
        """Release the terminal (master fd / pseudoconsole and job). Idempotent."""
        ...


class TerminalBackend(Protocol):
    """Spawn a child on a pseudo-terminal."""

    def parse_command(self, command: str) -> list[str]:
        """Split a command-line string into argv the way this platform's shell would."""
        ...

    def spawn(
        self,
        argv: list[str] | str,
        *,
        cwd: str,
        env: dict[str, str],
        rows: int,
        cols: int,
    ) -> TerminalHandle:
        """Start `argv` (a string is a ready-made command line on Windows) on a new terminal.

        The returned handle owns everything the spawn created; on failure
        nothing is left open. `FileNotFoundError` when argv[0] cannot be found.
        """
        ...


class SecretFiles(Protocol):
    """Files that hold a secret: private keys, tokens, vault fallbacks.

    POSIX protects these with mode bits — `0600` on the file, `0700` on the
    directory — and `os.chmod` does exactly that. On NTFS the same call
    silently does nothing (Python maps it to the read-only attribute), which
    is how a "0600" private key ends up readable by every account on a shared
    Windows machine. The seam exists so a feature module says *what* it wants
    ("this is a secret") and the platform decides *how*.

    Two write shapes, because two audiences read these files:

    - `write_private` is for content only this backend reads back (device
      keys, MCP auth tokens, credential-vault slots). Windows encrypts it with
      DPAPI, so the file is useless to any other account — and to any other
      *program* too, which is why it must not be used for the second kind.
    - `write_private_plain` is for a secret another process consumes as-is:
      the ws token Electron reads, the header file curl loads, the MCP config
      a CLI parses. POSIX gives it the same 0600; Windows can only write it
      in the clear (an owner-only ACL is the missing piece — see `_windows`).
    """

    def write_private(self, path: Path, data: bytes) -> None:
        """Atomically replace `path` with `data`, readable by this user's backend only."""
        ...

    def write_private_plain(self, path: Path, data: bytes) -> None:
        """Atomically replace `path` with `data` as-is, owner-only where the platform can."""
        ...

    def read_private(self, path: Path) -> bytes:
        """The content written by `write_private`, or a legacy plaintext file.

        Raises `OSError` (including `FileNotFoundError`) like a plain read.
        """
        ...

    def harden_file(self, path: Path) -> None:
        """Take an existing file down to owner-only, if the platform can express it."""
        ...

    def make_private_dir(self, path: Path) -> None:
        """Create `path` (and parents) and make the leaf owner-only."""
        ...


class SchedulerError(Exception):
    """A scheduler operation failed for an operational reason.

    Callers surface the message to the user verbatim (it usually carries the
    failing command's stderr), so keep messages human-readable.
    """


class Scheduler(Protocol):
    """The machine's registered background jobs, by kind.

    Kinds are the `executions.*` WebSocket contract: `"crontab"` (the user's
    cron table) and `"launchagent"` (launchd jobs under
    `~/Library/LaunchAgents` and the two system directories). A kind the
    platform does not have — launchd off macOS, both on Windows — lists as
    `{"supported": False, "entries": [], ...}` rather than raising, and its
    mutations raise `SchedulerError` naming the platform. Nothing here may
    spawn a helper for a kind it reports unsupported.

    Windows Task Scheduler (`schtasks`) is deliberately not wired: it is a
    different model (triggers, principals, XML task definitions) and would
    need its own kind and UI, so the Windows implementation reports both
    kinds unsupported and stays inert.
    """

    async def list_jobs(self, kind: str) -> dict:
        """`{"supported", "entries", "error", ...}` for one kind; never raises."""
        ...

    async def set_enabled(self, kind: str, target: str, enabled: bool) -> None:
        """Enable or disable one job; `SchedulerError` on failure."""
        ...

    async def remove(self, kind: str, target: str) -> None:
        """Delete one job; `SchedulerError` on failure."""
        ...
