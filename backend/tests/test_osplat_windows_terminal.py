"""The Windows process-tree and terminal seams, exercised on any platform.

`winpty`, `psutil` and kernel32 are stubbed, so what is tested is everything
*around* the Win32 calls — the Job Object call order, which name reaches
CreateProcess and how, how the pump thread hands chunks to the event loop,
how a split UTF-8 write is held — and not the calls themselves. Those need a
Windows box; CI runs the same suite there against the real modules.
"""

from __future__ import annotations

import asyncio
import subprocess
import sys
import types
from types import SimpleNamespace

import psutil
import pytest

from agent_team_backend.osplat import _windows
from agent_team_backend.osplat.spec import ProcInfo

WAIT_TIMEOUT = 0x00000102


class _FakeKernel32:
    """Records every kernel32 call; handles are dealt from a counter."""

    def __init__(self) -> None:
        self.calls: list[tuple] = []
        self._next = iter(range(100, 1000))
        self.wait_result = WAIT_TIMEOUT
        self.exit_code = 0

    def CreateJobObjectW(self, attrs, name):
        job = next(self._next)
        self.calls.append(("CreateJobObjectW", job))
        return job

    def SetInformationJobObject(self, job, info_class, info, size):
        flags = info._obj.BasicLimitInformation.LimitFlags
        self.calls.append(("SetInformationJobObject", job, info_class, flags))
        return 1

    def OpenProcess(self, access, inherit, pid):
        handle = next(self._next)
        self.calls.append(("OpenProcess", access, pid, handle))
        return handle

    def AssignProcessToJobObject(self, job, handle):
        self.calls.append(("AssignProcessToJobObject", job, handle))
        return 1

    def TerminateJobObject(self, job, code):
        self.calls.append(("TerminateJobObject", job, code))
        return 1

    def CloseHandle(self, handle):
        self.calls.append(("CloseHandle", handle))
        return 1

    def WaitForSingleObject(self, handle, millis):
        self.calls.append(("WaitForSingleObject", handle, millis))
        return self.wait_result

    def GetExitCodeProcess(self, handle, out):
        out._obj.value = self.exit_code
        return 1

    def LocalFree(self, pointer):
        return None

    def names(self) -> list[str]:
        return [call[0] for call in self.calls]


class _FakePTY:
    """`winpty.PTY` as pywinpty 3.0.5 declares it (`_winpty.pyi`)."""

    last: "_FakePTY | None" = None

    def __init__(self, cols: int, rows: int, backend=None) -> None:
        self.size = (cols, rows)
        self.spawn_args: tuple | None = None
        self.pid = 4242
        self.written: list[str] = []
        self.reads: list = []
        self.alive = True
        self.cancelled = False
        _FakePTY.last = self

    def spawn(self, appname, cmdline=None, cwd=None, env=None) -> bool:
        self.spawn_args = (appname, cmdline, cwd, env)
        return True

    def read(self, blocking: bool = False) -> str:
        if not self.reads:
            raise RuntimeError("Standard out reached EOF")
        item = self.reads.pop(0)
        if isinstance(item, Exception):
            raise item
        return item

    def write(self, text: str) -> int:
        self.written.append(text)
        return len(text)

    def set_size(self, cols: int, rows: int) -> None:
        self.size = (cols, rows)

    def isalive(self) -> bool:
        return self.alive

    def iseof(self) -> bool:
        return not self.alive

    def cancel_io(self) -> bool:
        self.cancelled = True
        return True


@pytest.fixture
def kernel32(monkeypatch) -> _FakeKernel32:
    fake = _FakeKernel32()
    monkeypatch.setattr(_windows, "_kernel32", lambda: fake)
    monkeypatch.setattr(_windows, "_jobs", {})
    return fake


@pytest.fixture
def winpty(monkeypatch) -> types.ModuleType:
    module = types.ModuleType("winpty")
    module.PTY = _FakePTY  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "winpty", module)
    _FakePTY.last = None
    return module


@pytest.fixture
def which_cmd_shim(monkeypatch):
    """`shutil.which` with PATHEXT: `claude` resolves to npm's `.cmd` shim."""
    monkeypatch.setattr(
        _windows.shutil, "which",
        lambda name, path=None: r"C:\npm\claude.cmd" if name == "claude" else None,
    )


# ---- spawn -----------------------------------------------------------------


class TestSpawn:
    def test_resolves_the_cmd_shim_and_boxes_the_child_in_a_job(
        self, kernel32, winpty, which_cmd_shim
    ):
        handle = _windows.terminal_backend.spawn(
            ["claude", "--resume", "abc def"],
            cwd=r"C:\ws", env={"PATH": "x", "TERM": "xterm-256color"}, rows=30, cols=100,
        )
        pty = _FakePTY.last
        assert pty is not None
        assert pty.size == (100, 30)
        # The shim path goes first on the command line (winpty-rs prepends
        # `appname` and leaves lpApplicationName NULL — which is exactly what
        # lets CreateProcess run a .cmd); the rest is list2cmdline-quoted.
        assert pty.spawn_args == (
            r"C:\npm\claude.cmd", '--resume "abc def"', r"C:\ws",
            "PATH=x\0TERM=xterm-256color\0",
        )
        assert handle.pid == 4242
        assert handle.proc.pid == 4242
        assert handle.foreground_group() == 4242  # no ConPTY equivalent
        assert kernel32.names() == [
            "OpenProcess",            # the exit-code handle the child adapter keeps
            "CreateJobObjectW",
            "SetInformationJobObject",
            "OpenProcess",            # PROCESS_SET_QUOTA | PROCESS_TERMINATE for the assign
            "AssignProcessToJobObject",
            "CloseHandle",            # that assign handle, not the job
        ]
        _, job = kernel32.calls[1]
        assert kernel32.calls[2] == (
            "SetInformationJobObject", job,
            _windows.JobObjectExtendedLimitInformation,
            _windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        )
        _, access, pid, assign_handle = kernel32.calls[3]
        assert access == _windows.PROCESS_SET_QUOTA | _windows.PROCESS_TERMINATE
        assert pid == 4242
        assert kernel32.calls[4] == ("AssignProcessToJobObject", job, assign_handle)
        assert kernel32.calls[5] == ("CloseHandle", assign_handle)
        assert _windows._jobs == {4242: job}

    def test_a_command_line_string_is_parsed_by_the_os_rules_then_rebuilt(
        self, kernel32, winpty, which_cmd_shim, monkeypatch
    ):
        seen: list[str] = []

        def split(command: str) -> list[str]:
            seen.append(command)
            return ["claude", "-p", "hi there"]

        monkeypatch.setattr(_windows, "_split_command_line", split)
        _windows.terminal_backend.spawn(
            'claude -p "hi there"', cwd="C:\\", env={}, rows=1, cols=1
        )
        assert seen == ['claude -p "hi there"']
        assert _FakePTY.last.spawn_args[:2] == (r"C:\npm\claude.cmd", '-p "hi there"')

    def test_a_bare_executable_passes_no_command_line(
        self, kernel32, winpty, which_cmd_shim
    ):
        _windows.terminal_backend.spawn(["claude"], cwd="C:\\", env={}, rows=1, cols=1)
        assert _FakePTY.last.spawn_args[1] is None

    def test_missing_executable_raises_before_any_pty_exists(
        self, kernel32, winpty, monkeypatch
    ):
        monkeypatch.setattr(_windows.shutil, "which", lambda name, path=None: None)
        with pytest.raises(FileNotFoundError):
            _windows.terminal_backend.spawn(["nope"], cwd="C:\\", env={}, rows=1, cols=1)
        assert _FakePTY.last is None
        assert kernel32.calls == []

    # A job that cannot be created degrades to table-walking kills; the pane
    # still opens. That is a warning, not a failed spawn.
    def test_job_failure_is_degraded_not_fatal(
        self, kernel32, winpty, which_cmd_shim, monkeypatch, caplog
    ):
        kernel32.CreateJobObjectW = lambda attrs, name: 0  # type: ignore[method-assign]
        monkeypatch.setattr(_windows, "_win_error", lambda: OSError("no job"))
        handle = _windows.terminal_backend.spawn(
            ["claude"], cwd="C:\\", env={}, rows=1, cols=1
        )
        assert handle.pid == 4242
        assert _windows._jobs == {}
        assert "job object unavailable" in caplog.text

    # A job that exists but cannot take the child is closed, not leaked: it
    # holds no process, so KILL_ON_JOB_CLOSE has nothing to kill.
    def test_job_is_closed_when_the_assign_fails(
        self, kernel32, winpty, which_cmd_shim, monkeypatch, caplog
    ):
        kernel32.AssignProcessToJobObject = lambda job, handle: 0  # type: ignore[method-assign]
        monkeypatch.setattr(_windows, "_win_error", lambda: OSError("no assign"))
        handle = _windows.terminal_backend.spawn(
            ["claude"], cwd="C:\\", env={}, rows=1, cols=1
        )
        assert handle.pid == 4242
        assert _windows._jobs == {}
        _, job = kernel32.calls[1]
        _, _, _, assign_handle = kernel32.calls[3]
        assert kernel32.names()[3:] == ["OpenProcess", "CloseHandle", "CloseHandle"]
        assert kernel32.calls[4:] == [("CloseHandle", assign_handle), ("CloseHandle", job)]
        assert "job object unavailable" in caplog.text


# ---- kills -------------------------------------------------------------------


class TestKills:
    def test_kill_tree_terminates_the_job_when_the_root_has_one(self, kernel32):
        _windows._jobs[77] = 555
        _windows.process_tree.kill_tree(77, force=False)
        _windows.process_tree.kill_group(77, force=True)  # a "group" is the tree
        assert kernel32.calls == [
            ("TerminateJobObject", 555, _windows._TERMINATE_EXIT_CODE),
            ("TerminateJobObject", 555, _windows._TERMINATE_EXIT_CODE),
        ]

    def test_kill_tree_walks_the_table_root_first_without_a_job(self, kernel32, monkeypatch):
        order: list[int] = []

        class Proc:
            def __init__(self, pid):
                self.pid = pid

            def children(self, recursive=False):
                assert recursive
                return [Proc(2), Proc(3)]

            def kill(self):
                order.append(self.pid)

        monkeypatch.setattr(_windows.psutil, "Process", Proc)
        _windows.process_tree.kill_tree(1, force=True)
        assert order == [1, 2, 3]

    # Both force values are TerminateProcess: Windows has no graceful signal.
    def test_kill_ignores_force_and_translates_psutil_errors(self, monkeypatch):
        killed: list[int] = []

        class Proc:
            def __init__(self, pid):
                self.pid = pid

            def kill(self):
                if self.pid == 2:
                    raise psutil.NoSuchProcess(self.pid)
                if self.pid == 3:
                    raise psutil.AccessDenied(self.pid)
                killed.append(self.pid)

        monkeypatch.setattr(_windows.psutil, "Process", Proc)
        _windows.process_tree.kill(1, force=False)
        _windows.process_tree.kill(1, force=True)
        assert killed == [1, 1]
        with pytest.raises(ProcessLookupError):
            _windows.process_tree.kill(2, force=True)
        with pytest.raises(PermissionError):
            _windows.process_tree.kill(3, force=True)

    def test_group_of_is_the_pid_or_lookup_error(self, monkeypatch):
        monkeypatch.setattr(_windows.psutil, "pid_exists", lambda pid: pid == 9)
        assert _windows.process_tree.group_of(9) == 9
        with pytest.raises(ProcessLookupError):
            _windows.process_tree.group_of(10)


# ---- identity and snapshot ---------------------------------------------------


class TestIdentity:
    def test_identity_is_pid_and_create_time(self, monkeypatch):
        class Proc:
            def __init__(self, pid):
                if pid == 404:
                    raise psutil.NoSuchProcess(pid)
                self.pid = pid

            def create_time(self):
                return 1700000000.25

        monkeypatch.setattr(_windows.psutil, "Process", Proc)
        assert _windows.process_tree.start_time(55) == "1700000000.25"
        assert _windows.process_tree.identity(55) == "55:1700000000.25"
        assert _windows.process_tree.start_time(404) == ""
        assert _windows.process_tree.identity(404) == "404:"

    def test_snapshot_uses_pid_as_group_and_orphans_stale_parents(self, monkeypatch):
        rows = [
            SimpleNamespace(pid=10, info={"ppid": 4, "create_time": 5.0}),   # parent gone
            SimpleNamespace(pid=20, info={"ppid": 10, "create_time": 6.0}),  # real child
            SimpleNamespace(pid=30, info={"ppid": 99, "create_time": 7.0}),  # parent gone
            SimpleNamespace(pid=40, info={"ppid": 10, "create_time": 4.0}),  # recycled ppid
            SimpleNamespace(pid=50, info={"ppid": 20, "create_time": None}),  # access denied
        ]
        monkeypatch.setattr(_windows.psutil, "process_iter", lambda attrs: iter(rows))
        snap = _windows.process_tree.snapshot()
        assert snap == {
            10: ProcInfo(0, 10, "5.0"),
            20: ProcInfo(10, 20, "6.0"),
            30: ProcInfo(0, 30, "7.0"),
            40: ProcInfo(0, 40, "4.0"),
            50: ProcInfo(20, 50, ""),
        }
        assert sorted(_windows.process_tree.descendants(10)) == [20, 50]

    # The sweep in `terminals` asks the tree what an orphan's ppid looks like:
    # here it is the 0 that `snapshot` writes for a stale parent, never 1.
    def test_is_orphan_parent_is_the_normalised_zero_or_this_process(self):
        tree = _windows.process_tree
        assert tree.is_orphan_parent(0, 500)
        assert tree.is_orphan_parent(500, 500)
        assert not tree.is_orphan_parent(1, 500)
        assert not tree.is_orphan_parent(4, 500)

    def test_command_of_distinguishes_gone_from_unreadable(self, monkeypatch):
        class Proc:
            def __init__(self, pid):
                if pid == 1:
                    raise psutil.NoSuchProcess(pid)
                self.pid = pid

            def cmdline(self):
                if self.pid == 2:
                    raise psutil.AccessDenied(self.pid)
                return [r"C:\navide\agent_team_backend.exe", "--port", "1"]

        monkeypatch.setattr(_windows.psutil, "Process", Proc)
        assert _windows.process_tree.command_of(1) == ""
        assert _windows.process_tree.command_of(2) is None
        assert "agent_team_backend" in (_windows.process_tree.command_of(3) or "")


# ---- the handle --------------------------------------------------------------


def _handle(pty: _FakePTY) -> _windows.WindowsTerminalHandle:
    return _windows.WindowsTerminalHandle(pty, pty.pid, None, 0)


class TestHandle:
    async def test_pump_delivers_chunks_then_eof_on_the_loop(self):
        pty = _FakePTY(80, 24)
        pty.reads = ["héllo", ""]
        pty.alive = False  # the "" read: reader channel gone, child exited
        handle = _handle(pty)
        loop = asyncio.get_running_loop()
        collected: list[bytes] = []
        done = asyncio.Event()
        thread_ids: set[int] = set()

        def on_readable() -> None:
            import threading

            thread_ids.add(threading.get_ident())
            while True:
                try:
                    chunk = handle.read(3)  # bounded drain, like _on_readable
                except BlockingIOError:
                    return
                if chunk is None:
                    done.set()
                    return
                collected.append(chunk)

        handle.start_reading(loop, on_readable)
        await asyncio.wait_for(done.wait(), 2)
        assert b"".join(collected) == "héllo".encode("utf-8")
        assert len(collected) == 2  # 6 bytes served in 3-byte slices, re-armed
        import threading

        assert thread_ids == {threading.get_ident()}  # never off the loop thread

    async def test_pause_holds_callbacks_until_resume(self):
        pty = _FakePTY(80, 24)
        pty.reads = ["a"]
        pty.alive = False
        handle = _handle(pty)
        loop = asyncio.get_running_loop()
        calls: list[bytes | None] = []

        def on_readable() -> None:
            try:
                calls.append(handle.read(64))
            except BlockingIOError:
                pass

        # Pause right after starting: a wake-up the pump has already queued
        # must find the pause and hold, the way a removed reader would.
        handle.start_reading(loop, on_readable)
        handle.pause_reading()
        await asyncio.sleep(0.05)
        assert calls == []
        handle.resume_reading()
        await asyncio.sleep(0.05)
        assert calls[0] == b"a"
        handle.stop_reading()
        before = list(calls)
        handle.resume_reading()  # stopped: nothing may arrive any more
        await asyncio.sleep(0.02)
        assert calls == before

    # A pause stops the callback, not the pump: pywinpty's own reader thread
    # drains the pipe into an unbounded channel regardless, so holding the
    # pump would only move the queue. What matters is that nothing is lost
    # and EOF still comes after every chunk that preceded it.
    async def test_pause_keeps_queueing_and_resume_replays_in_order_before_eof(self):
        pty = _FakePTY(80, 24)
        pty.reads = ["a", "b", ""]
        pty.alive = False
        handle = _handle(pty)
        loop = asyncio.get_running_loop()
        got: list[bytes | None] = []

        def on_readable() -> None:
            while True:
                try:
                    chunk = handle.read(64)
                except BlockingIOError:
                    return
                got.append(chunk)
                if chunk is None:
                    return

        handle.start_reading(loop, on_readable)
        handle.pause_reading()  # before the loop runs the queued wake-up
        await asyncio.sleep(0.05)
        assert got == [] and handle._eof
        assert b"".join(handle._chunks) == b"ab"
        handle.resume_reading()
        await asyncio.sleep(0.05)
        assert got == [b"a", b"b", None]

    # ConPTY never closes the conout pipe on the child's behalf: the exit has
    # to be watched and turned into EOF, or the session outlives its process.
    async def test_child_exit_becomes_eof_while_conpty_keeps_the_pipe_open(
        self, monkeypatch
    ):
        import threading

        pty = _FakePTY(80, 24)
        parked = threading.Event()  # ReadFile on a pipe nobody closes

        def read(blocking: bool = False) -> str:
            if pty.reads:
                return pty.reads.pop(0)
            parked.wait()
            raise RuntimeError("I/O cancelled")

        def cancel_io() -> bool:
            pty.cancelled = True
            parked.set()
            return True

        pty.read = read  # type: ignore[method-assign]
        pty.cancel_io = cancel_io  # type: ignore[method-assign]
        pty.reads = ["bye"]
        exited = threading.Event()

        class Kernel:
            def WaitForSingleObject(self, handle, millis):
                assert handle == 77
                return _windows.WAIT_OBJECT_0 if exited.wait(millis / 1000) else WAIT_TIMEOUT

        monkeypatch.setattr(_windows, "_kernel32", lambda: Kernel())
        handle = _windows.WindowsTerminalHandle(pty, pty.pid, None, 77)
        loop = asyncio.get_running_loop()
        collected: list[bytes] = []
        done = asyncio.Event()

        def on_readable() -> None:
            while True:
                try:
                    chunk = handle.read(64)
                except BlockingIOError:
                    return
                if chunk is None:
                    done.set()
                    return
                collected.append(chunk)

        handle.start_reading(loop, on_readable)
        await asyncio.sleep(0.05)
        assert collected == [b"bye"] and not done.is_set()  # alive: no EOF invented
        started = loop.time()
        exited.set()
        await asyncio.wait_for(done.wait(), 2)
        assert loop.time() - started < 0.5
        assert pty.cancelled
        handle._watcher.join(1)
        assert not handle._watcher.is_alive()

    async def test_close_ends_the_exit_watcher_without_an_exit(self, monkeypatch):
        import threading

        pty = _FakePTY(80, 24)
        parked = threading.Event()

        def read(blocking: bool = False) -> str:
            parked.wait()
            raise RuntimeError("I/O cancelled")

        pty.read = read  # type: ignore[method-assign]
        pty.cancel_io = lambda: parked.set() or True  # type: ignore[method-assign]
        monkeypatch.setattr(_windows, "_EXIT_WATCH_MS", 10)

        class Kernel:
            def WaitForSingleObject(self, handle, millis):
                threading.Event().wait(millis / 1000)
                return WAIT_TIMEOUT

        monkeypatch.setattr(_windows, "_kernel32", lambda: Kernel())
        monkeypatch.setattr(_windows.process_tree, "kill_tree", lambda pid, force: None)
        handle = _windows.WindowsTerminalHandle(pty, pty.pid, None, 77)
        handle.start_reading(asyncio.get_running_loop(), lambda: None)
        handle.close()
        handle._watcher.join(1)
        handle._pump.join(1)
        assert not handle._watcher.is_alive() and not handle._pump.is_alive()

    def test_read_without_data_blocks_and_none_at_eof(self):
        handle = _handle(_FakePTY(80, 24))
        with pytest.raises(BlockingIOError):
            handle.read(1)
        handle._eof = True
        assert handle.read(1) is None

    def test_write_holds_a_split_utf8_tail_until_it_completes(self):
        pty = _FakePTY(80, 24)
        handle = _handle(pty)
        assert handle.write(b"\xe4\xbd") == 2  # first two bytes of 你
        assert pty.written == []
        assert handle.write(b"\xa0!") == 2
        assert pty.written == ["你!"]

    def test_write_errors_become_oserror(self):
        pty = _FakePTY(80, 24)

        def boom(text):
            raise RuntimeError("pipe gone")

        pty.write = boom  # type: ignore[method-assign]
        with pytest.raises(OSError):
            _handle(pty).write(b"x")

    def test_resize_passes_cols_then_rows(self):
        pty = _FakePTY(80, 24)
        _handle(pty).resize(50, 120)
        assert pty.size == (120, 50)

    async def test_watch_writable_retries_after_a_delay_and_unwatch_cancels(self):
        handle = _handle(_FakePTY(80, 24))
        loop = asyncio.get_running_loop()
        fired: list[int] = []
        handle.watch_writable(loop, lambda: fired.append(1))
        await asyncio.sleep(_windows._WRITE_RETRY_S * 3)
        assert fired == [1]
        handle.watch_writable(loop, lambda: fired.append(2))
        handle.unwatch_writable()
        await asyncio.sleep(_windows._WRITE_RETRY_S * 3)
        assert fired == [1]

    def test_close_releases_the_job_and_cancels_pending_io(
        self, kernel32, winpty, which_cmd_shim
    ):
        handle = _windows.terminal_backend.spawn(
            ["claude"], cwd="C:\\", env={}, rows=1, cols=1
        )
        job = _windows._jobs[4242]
        kernel32.calls.clear()
        pty = _FakePTY.last
        handle.close()
        # KILL_ON_JOB_CLOSE does the killing; the process handle stays open
        # while the child is still going down, so the exit code can be read.
        assert kernel32.calls == [
            ("CloseHandle", job),
            ("WaitForSingleObject", handle._process_handle, 0),
        ]
        assert _windows._jobs == {}
        assert pty.cancelled
        handle.close()  # idempotent
        assert kernel32.names() == ["CloseHandle", "WaitForSingleObject"]
        with pytest.raises(OSError):
            handle.write(b"x")
        # The caller polls after close: the first look at the exit releases
        # the handle, and nothing afterwards touches it again.
        kernel32.wait_result = _windows.WAIT_OBJECT_0
        kernel32.exit_code = 9
        assert handle.proc.poll() == 9
        assert handle.proc.wait(timeout=0.01) == 9
        assert handle.proc.poll() == 9
        assert kernel32.calls.count(("CloseHandle", handle._process_handle)) == 1

    def test_close_releases_the_process_handle_of_an_exited_child(
        self, kernel32, winpty, which_cmd_shim
    ):
        handle = _windows.terminal_backend.spawn(
            ["claude"], cwd="C:\\", env={}, rows=1, cols=1
        )
        job = _windows._jobs[4242]
        kernel32.calls.clear()
        kernel32.wait_result = _windows.WAIT_OBJECT_0
        kernel32.exit_code = 3
        handle.close()
        assert kernel32.calls == [
            ("CloseHandle", job),
            ("WaitForSingleObject", handle._process_handle, 0),
            ("CloseHandle", handle._process_handle),
        ]
        assert handle.proc.returncode == 3
        assert handle.proc.poll() == 3 and handle.proc.wait() == 3
        handle.close()
        assert kernel32.calls.count(("CloseHandle", handle._process_handle)) == 1


class TestChild:
    def test_poll_and_wait_read_the_exit_code_through_the_handle(self, kernel32):
        child = _windows._WindowsChild(5, 99)
        assert child.poll() is None
        with pytest.raises(subprocess.TimeoutExpired):
            child.wait(timeout=0.01)
        assert ("WaitForSingleObject", 99, 10) in kernel32.calls
        kernel32.wait_result = _windows.WAIT_OBJECT_0
        kernel32.exit_code = 3
        assert child.wait(timeout=1.0) == 3
        assert child.returncode == 3
        assert child.poll() == 3
        assert kernel32.calls.count(("CloseHandle", 99)) == 1


class TestResourceProbe:
    def test_peak_rss_uses_the_peak_working_set(self, monkeypatch):
        monkeypatch.setattr(
            _windows.psutil, "Process",
            lambda: SimpleNamespace(memory_info=lambda: SimpleNamespace(peak_wset=123)),
        )
        assert _windows.resource_probe.peak_rss_bytes() == 123

    def test_the_probe_reports_itself_usable_and_names_its_counter(self):
        assert _windows.resource_probe.available() is True
        assert _windows.resource_probe.memory_kind() == "private_bytes"

    # Bytes and seconds, the same units the Darwin and Linux probes report:
    # the private working set as-is, and user plus system CPU added up.
    def test_sample_reports_private_bytes_and_total_cpu_seconds(self, monkeypatch):
        _fake_processes(monkeypatch, {
            10: _proc(private=4096, rss=999_999, user=1.5, system=0.25),
            11: _proc(private=8192, rss=999_999, user=600.0, system=0.0),
        })
        assert _windows.resource_probe.sample([10, 11]) == {
            10: (4096, 1.75),
            11: (8192, 600.0),
        }

    # RSS on Windows is the working set, which charges a shared DLL to every
    # process mapping it; it is the fallback only, for a psutil that does not
    # carry the Windows-only field.
    def test_sample_falls_back_to_rss_without_a_private_counter(self, monkeypatch):
        _fake_processes(monkeypatch, {12: _proc(private=None, rss=2048, user=1.0, system=0.0)})
        assert _windows.resource_probe.sample([12]) == {12: (2048, 1.0)}

    # A pid that died mid-sweep, or that belongs to another user, is absent
    # rather than zero — so the caller can tell "not measured" from "nothing".
    def test_a_dead_or_foreign_pid_is_absent_not_zero(self, monkeypatch):
        _fake_processes(
            monkeypatch,
            {13: _proc(private=1024, rss=1024, user=0.0, system=0.0)},
            missing={14: psutil.NoSuchProcess(14), 15: psutil.AccessDenied(15)},
        )
        assert _windows.resource_probe.sample([13, 14, 15]) == {13: (1024, 0.0)}

    def test_impossible_pids_are_never_looked_up(self, monkeypatch):
        def must_not_run(_pid):
            raise AssertionError("pid 0 and below are not processes")

        monkeypatch.setattr(_windows.psutil, "Process", must_not_run)
        assert _windows.resource_probe.sample([0, -1]) == {}
        assert _windows.resource_probe.sample([]) == {}


def _proc(*, private, rss, user, system) -> SimpleNamespace:
    """One psutil.Process as this probe uses it: memory_info + cpu_times."""
    memory = SimpleNamespace(rss=rss)
    if private is not None:
        memory.private = private
    return SimpleNamespace(
        memory_info=lambda: memory,
        cpu_times=lambda: SimpleNamespace(user=user, system=system),
    )


def _fake_processes(monkeypatch, alive: dict, missing: dict | None = None) -> None:
    def factory(pid):
        if missing and pid in missing:
            raise missing[pid]
        return alive[pid]

    monkeypatch.setattr(_windows.psutil, "Process", factory)
