"""Run the backend suite on the Windows CI runner and always come back.

A step on the GitHub runner ends only when every handle to its stdout pipe is
closed. Fourteen rounds of the Windows job showed the "Backend tests" step
outliving both python and its own `timeout-minutes`, and the job timeout
discards the step log — so we never saw which test was responsible. The
mechanism fits a pseudo-console host (conhost.exe) or any other grandchild
that inherited the pipe handle and outlived the python that spawned it:
`taskkill /T` walks parent links, and an orphan has none.

Two things fix that structurally, both done here:

* pytest runs in a child that inherits nothing but a log file (`close_fds`
  restricts the handle list on Windows), so no descendant can ever hold the
  runner's pipe;
* this process joins a Job Object with kill-on-close first, so every
  descendant — orphaned or not — dies when this process exits, and can be
  listed while the suite runs.

Round 15 then hung with exactly that in place, so the script no longer
touches the step's pipe at all: `--detach` starts a copy of itself with a log
file as its only inherited handle and returns at once, the workflow polls the
log from a shell with no children, and a `.done` marker carries the exit
code. Whatever hangs, the log is readable.
"""

from __future__ import annotations

import base64
import ctypes
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from ctypes import wintypes

import psutil

LOG = "pytest.log"
WRAPPER_LOG = "ci-windows-tests.log"
HEARTBEAT_LOG = "ci-windows-heartbeat.log"
DONE = "ci-windows-tests.done"
# Rounds 16-17: even a childless pwsh poll step never ended, so the runner
# agent itself goes dark and the job's log blob is never uploaded. The only
# record that survives is one that leaves the machine before that happens:
# each minute the log so far is committed to this branch of the repo through
# the REST API (GH_TOKEN and GITHUB_REPOSITORY come from the workflow).
UPLOAD_BRANCH = "ci-logs"
CAP_SECONDS = 20 * 60
REPORT_EVERY = 60
RESULT_RE = re.compile(r" (PASSED|FAILED|SKIPPED|ERROR|XFAIL|XPASS)")

JOB_OBJECT_LIMIT_ACTIVE_PROCESS = 0x0008
JOB_OBJECT_LIMIT_JOB_MEMORY = 0x0200
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
# Round 16: a pwsh loop with no children stayed "in progress" past its own
# deadline and its step timeout, so the runner agent itself had stopped
# responding — the shape of a process storm or a memory bomb, not a pipe.
# Fence the suite in: a spawn or allocation past these fails inside the job,
# with a traceback that names the test, while the runner stays alive.
MAX_PROCESSES = 48
MAX_JOB_MEMORY = 4 * 1024 ** 3
DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
JobObjectBasicProcessIdList = 3
JobObjectExtendedLimitInformation = 9


class _IO_COUNTERS(ctypes.Structure):
    _fields_ = [(name, ctypes.c_ulonglong) for name in (
        "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
        "ReadTransferCount", "WriteTransferCount", "OtherTransferCount",
    )]


class _JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", wintypes.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wintypes.DWORD),
        ("Affinity", ctypes.c_size_t),
        ("PriorityClass", wintypes.DWORD),
        ("SchedulingClass", wintypes.DWORD),
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


def _pid_list_struct(capacity: int):
    class _JOBOBJECT_BASIC_PROCESS_ID_LIST(ctypes.Structure):
        _fields_ = [
            ("NumberOfAssignedProcesses", wintypes.DWORD),
            ("NumberOfProcessIdsInList", wintypes.DWORD),
            ("ProcessIdList", ctypes.c_size_t * capacity),
        ]

    return _JOBOBJECT_BASIC_PROCESS_ID_LIST()


def _kernel32():
    k = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
    k.CreateJobObjectW.argtypes = [ctypes.c_void_p, wintypes.LPCWSTR]
    k.CreateJobObjectW.restype = wintypes.HANDLE
    k.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    k.SetInformationJobObject.restype = wintypes.BOOL
    k.QueryInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD, ctypes.c_void_p]
    k.QueryInformationJobObject.restype = wintypes.BOOL
    k.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    k.AssignProcessToJobObject.restype = wintypes.BOOL
    k.GetCurrentProcess.argtypes = []
    k.GetCurrentProcess.restype = wintypes.HANDLE
    return k


def _join_job():
    """Put this process in a fresh kill-on-close job; return (kernel32, job) or None."""
    k32 = _kernel32()
    job = k32.CreateJobObjectW(None, None)
    if not job:
        print(f"--- job object: CreateJobObjectW failed ({ctypes.get_last_error()})")
        return None
    info = _JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_JOB_MEMORY
    info.BasicLimitInformation.ActiveProcessLimit = MAX_PROCESSES
    info.JobMemoryLimit = MAX_JOB_MEMORY
    if not k32.SetInformationJobObject(job, JobObjectExtendedLimitInformation, ctypes.byref(info), ctypes.sizeof(info)):
        print(f"--- job object: SetInformationJobObject failed ({ctypes.get_last_error()})")
        return None
    if not k32.AssignProcessToJobObject(job, k32.GetCurrentProcess()):
        # Nested jobs need Windows 8+; the runner has that, but say so if not.
        print(f"--- job object: AssignProcessToJobObject failed ({ctypes.get_last_error()}); running unjailed")
        return None
    print(f"--- job object: joined, kill-on-close, max {MAX_PROCESSES} processes, {MAX_JOB_MEMORY >> 30} GiB")
    return k32, job


def _job_pids(job) -> list[int]:
    k32, handle = job
    info = _pid_list_struct(256)
    k32.QueryInformationJobObject(handle, JobObjectBasicProcessIdList, ctypes.byref(info), ctypes.sizeof(info), None)
    return [int(pid) for pid in info.ProcessIdList[: info.NumberOfProcessIdsInList]]


class _Uploader:
    """Commits the wrapper log to UPLOAD_BRANCH after every report."""

    def __init__(self, local: str = WRAPPER_LOG, suffix: str = "") -> None:
        self.repo = os.environ.get("GITHUB_REPOSITORY", "")
        self.token = os.environ.get("GH_TOKEN", "")
        run = os.environ.get("GITHUB_RUN_ID", "local")
        attempt = os.environ.get("GITHUB_RUN_ATTEMPT", "1")
        self.local = local
        self.path = f"windows/{run}-{attempt}{suffix}.log"
        self.sha: str | None = None
        self.enabled = bool(self.repo and self.token)
        if self.enabled:
            self._ensure_branch()

    def _call(self, method: str, url: str, body: dict | None = None) -> dict:
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"https://api.github.com{url}", data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.token}")
        req.add_header("Accept", "application/vnd.github+json")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read() or b"{}")

    def _ensure_branch(self) -> None:
        try:
            self._call("GET", f"/repos/{self.repo}/git/ref/heads/{UPLOAD_BRANCH}")
            return
        except urllib.error.HTTPError as exc:
            if exc.code != 404:
                self.enabled = False
                print(f"--- upload: branch check failed ({exc.code}); uploads off")
                return
        try:
            self._call("POST", f"/repos/{self.repo}/git/refs", {"ref": f"refs/heads/{UPLOAD_BRANCH}", "sha": os.environ.get("GITHUB_SHA", "")})
        except (urllib.error.URLError, OSError) as exc:
            self.enabled = False
            print(f"--- upload: branch create failed ({exc}); uploads off")

    def push(self, note: str) -> None:
        if not self.enabled:
            return
        sys.stdout.flush()
        try:
            with open(self.local, "rb") as fh:
                content = base64.b64encode(fh.read()).decode()
            body = {"message": f"ci-log: {self.path} {note}", "content": content, "branch": UPLOAD_BRANCH}
            if self.sha:
                body["sha"] = self.sha
            elif self.sha is None:
                try:
                    body["sha"] = self._call("GET", f"/repos/{self.repo}/contents/{self.path}?ref={UPLOAD_BRANCH}")["sha"]
                except urllib.error.HTTPError as exc:
                    if exc.code != 404:
                        raise
            self.sha = self._call("PUT", f"/repos/{self.repo}/contents/{self.path}", body)["content"]["sha"]
        except (urllib.error.URLError, OSError, KeyError) as exc:
            print(f"--- upload failed: {exc}")


def _runner_procs() -> str:
    """The runner agent and the poll step's shell, by name: round 19 finished
    the suite and wrote the marker, yet the step never ended, so the report
    now says each minute whether those processes are still there."""
    found = []
    for proc in psutil.process_iter(["name"]):
        name = proc.info.get("name") or ""
        if name.lower().startswith(("runner.", "pwsh", "powershell")):
            found.append(f"{name}({proc.pid})")
    return ", ".join(sorted(found)) or "(none)"


def _describe(pids: list[int]) -> str:
    names = []
    for pid in pids:
        if pid == os.getpid():
            continue
        try:
            names.append(f"{psutil.Process(pid).name()}({pid})")
        except psutil.Error:
            names.append(f"?({pid})")
    return ", ".join(names) or "(none)"


def _progress() -> str:
    try:
        with open(LOG, encoding="utf-8", errors="replace") as fh:
            lines = fh.readlines()
    except OSError:
        return "0 results"
    done = sum(1 for line in lines if RESULT_RE.search(line))
    last = next((line.strip()[:140] for line in reversed(lines) if "::" in line), "")
    return f"{done} results; last: {last}"


def _detach() -> int:
    """Start the real run with a log file as its only inherited handle."""
    for stale in (WRAPPER_LOG, HEARTBEAT_LOG, DONE, LOG):
        try:
            os.remove(stale)
        except OSError:
            pass
    runner = _spawn_detached("--run", WRAPPER_LOG)
    # Round 20: the runner's own reports stopped mid-suite while every process
    # it had listed was still alive, so a second, independent process now
    # says every 30 s whether the runner, pytest and the agent are alive and
    # uploads that separately — a stopped heartbeat means the machine or its
    # network went, a live one with a silent runner means the runner is stuck.
    heartbeat = _spawn_detached("--heartbeat", HEARTBEAT_LOG, str(runner.pid))
    print(f"--- detached runner pid {runner.pid}, heartbeat pid {heartbeat.pid}; log in {WRAPPER_LOG}, marker {DONE}")
    return 0


def _spawn_detached(mode: str, log_path: str, *extra: str) -> subprocess.Popen:
    args = [sys.executable, os.path.abspath(__file__), mode, *extra]
    flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    with open(log_path, "wb") as log:
        try:
            return subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, close_fds=True, creationflags=flags | CREATE_BREAKAWAY_FROM_JOB)
        except OSError as exc:
            # The runner may hold the step in a job that forbids breakaway.
            print(f"--- breakaway refused ({exc}); detaching inside the runner's job")
            return subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, close_fds=True, creationflags=flags)


def _heartbeat(runner_pid: int) -> int:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    uploader = _Uploader(HEARTBEAT_LOG, "-heartbeat")
    started = time.monotonic()
    while time.monotonic() - started < CAP_SECONDS + 600:
        try:
            runner = psutil.Process(runner_pid)
            state = f"runner {runner.status()}, cpu {runner.cpu_times().user:.1f}s user, children {[c.name() for c in runner.children(recursive=True)]}"
        except psutil.Error as exc:
            state = f"runner gone ({exc.__class__.__name__})"
        print(f"--- {int(time.monotonic() - started)}s: {state}; marker {'present' if os.path.exists(DONE) else 'absent'}; {len(psutil.pids())} processes; agent: {_runner_procs()}", flush=True)
        if os.path.exists(DONE) and time.monotonic() - started > 60:
            uploader.push("marker seen")
            # Keep going a little: the step should end once the marker exists.
            for i in range(6):
                time.sleep(30)
                print(f"--- after marker {i * 30 + 30}s: agent: {_runner_procs()}", flush=True)
                uploader.push(f"after marker {i * 30 + 30}s")
            return 0
        uploader.push(f"{int(time.monotonic() - started)}s")
        time.sleep(30)
    return 0


def main() -> int:
    if "--detach" in sys.argv:
        return _detach()
    if "--heartbeat" in sys.argv:
        return _heartbeat(int(sys.argv[sys.argv.index("--heartbeat") + 1]))
    # stdout is a file: line-buffer it so the poller sees progress as it
    # happens, and never let one non-cp1252 byte from a test crash the report.
    sys.stdout.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    uploader = _Uploader()
    print(f"--- upload: {'on, ' + uploader.path if uploader.enabled else 'off'}")
    job = _join_job()
    args = [
        sys.executable, "-X", "faulthandler", "-m", "pytest", "backend/tests", "-v",
        "-p", "no:cacheprovider", "--timeout=90", "--timeout-method=thread",
        "-o", "faulthandler_timeout=120",
    ]
    with open(LOG, "wb") as log:
        # close_fds restricts the child's handle list to exactly these three.
        child = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, close_fds=True)
    print(f"--- pytest pid {child.pid}, cap {CAP_SECONDS}s", flush=True)
    uploader.push("started")

    started = time.monotonic()
    rc: int | None = None
    while time.monotonic() - started < CAP_SECONDS:
        rc = child.poll()
        if rc is not None:
            break
        time.sleep(REPORT_EVERY)
        elapsed = int(time.monotonic() - started)
        peers = _describe(_job_pids(job)) if job else "(no job)"
        vm = psutil.virtual_memory()
        print(f"--- {elapsed}s: {_progress()}\n    in job: {peers}\n    vm: {vm.percent}% of {vm.total >> 20} MiB used, cpu {psutil.cpu_percent()}%, {len(psutil.pids())} processes\n    runner: {_runner_procs()}", flush=True)
        uploader.push(f"{elapsed}s")

    survivors = [pid for pid in (_job_pids(job) if job else []) if pid != os.getpid()]
    print(f"--- pytest exit: {rc if rc is not None else 'still running at cap'}")
    print(f"--- still in job: {_describe(survivors)}")
    for pid in survivors:
        try:
            psutil.Process(pid).kill()
        except psutil.Error:
            pass

    with open(LOG, encoding="utf-8", errors="replace") as fh:
        lines = fh.readlines()
    print("--- last 200 lines of pytest.log:")
    sys.stdout.write("".join(lines[-200:]))
    print("--- summary:")
    for line in lines:
        if line.startswith(("FAILED ", "ERROR ")) or re.match(r"=+ .*(passed|failed|error).* =+", line):
            sys.stdout.write(line)
    sys.stdout.flush()
    rc = 1 if rc is None else rc
    uploader.push(f"finished rc={rc}")
    # The tail above is the human summary; the whole pytest log goes up too
    # so a failure's traceback can be read without another round.
    _Uploader(LOG, "-pytest").push(f"finished rc={rc}")
    with open(DONE, "w") as marker:
        marker.write(str(rc))
    # Stay a few minutes past the marker: if the poll step still does not
    # end, this shows whether its shell and the runner agent are even alive.
    for i in range(1, 7):
        time.sleep(30)
        print(f"--- after marker {i * 30}s: runner: {_runner_procs()}; marker {'consumed' if not os.path.exists(DONE) else 'present'}", flush=True)
        uploader.push(f"after marker {i * 30}s")
    return rc


if __name__ == "__main__":
    sys.exit(main())
