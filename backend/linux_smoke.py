"""Does the backend actually work on Linux? One answer per capability.

The pytest suite runs without a terminal, a window server, or a real process
tree, so it can pass on a platform the app cannot actually start on. This
script asks the questions the suite structurally cannot: does the package
import where four POSIX-only stdlib modules are involved, can a PTY be opened
and driven, does `/proc` answer the resource probe, and does the HTTP server
come up.

Run it directly (`uv --project backend run python backend/linux_smoke.py`);
CI runs it as the last step of the Linux backend job. It exits non-zero if any
capability fails, and prints one line per check either way.

Isolation: starting the app installs agent hooks into the user's home — it
rewrites `~/.claude/settings.json` among others. This script therefore points
HOME at a throwaway directory *before* importing anything from the backend, so
running it on a development machine cannot disturb the real one.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import time
import traceback

# Must happen before the first backend import: the package resolves its data
# and hook locations from the environment at import time.
_SANDBOX = tempfile.mkdtemp(prefix="navide-linux-smoke-")
os.environ["HOME"] = _SANDBOX
os.environ["USERPROFILE"] = _SANDBOX
os.environ["AGENT_TEAM_DATA_DIR"] = os.path.join(_SANDBOX, "data")
os.environ.setdefault("XDG_DATA_HOME", os.path.join(_SANDBOX, ".local", "share"))
os.environ.setdefault("XDG_CONFIG_HOME", os.path.join(_SANDBOX, ".config"))
os.environ.setdefault("XDG_CACHE_HOME", os.path.join(_SANDBOX, ".cache"))

results: list[tuple[str, str, str]] = []


def check(name: str, fn) -> None:
    try:
        results.append((name, "PASS", fn() or ""))
    except Exception as err:  # noqa: BLE001 - a failed check is the output
        results.append((name, "FAIL", f"{type(err).__name__}: {err}"))
        if os.environ.get("SMOKE_TRACE"):
            traceback.print_exc()


def imports() -> str:
    """The four POSIX-only stdlib modules the Windows port has to replace.

    On Linux they are all present, which is the single biggest reason the
    Linux port is a fraction of the Windows one — but "should be present" is
    not evidence, and this is.
    """
    import agent_team_backend.mem_probe  # noqa: F401  (needs `resource`)
    import agent_team_backend.terminals  # noqa: F401  (needs pty/fcntl/termios)
    from agent_team_backend import app  # noqa: F401

    return "terminals + mem_probe + app"


def probe() -> str:
    """The `/proc` resource probe, against this very process."""
    from agent_team_backend import osplat

    if osplat.impl_name != "_linux":
        raise AssertionError(f"selected {osplat.impl_name}, expected _linux")
    if not osplat.resource_probe.available():
        return "impl=_linux, but this kernel exposes no smaps_rollup"
    pid = os.getpid()
    sampled = osplat.resource_probe.sample([pid])
    if pid not in sampled:
        raise AssertionError("the probe could not measure its own process")
    memory, cpu = sampled[pid]
    if memory <= 0:
        raise AssertionError(f"memory read back as {memory}")
    kind = osplat.resource_probe.memory_kind()
    return f"impl=_linux kind={kind} mem={memory // 1024}KiB cpu={cpu:.3f}s"


def paths() -> str:
    """Where state lands. XDG on Linux, and honouring the explicit override.

    The override this script pins at the top is the dev-launcher contract; a
    packaged app never sets it, so the second half asks the question CI could
    not see for a whole release: with no override, does the backend land under
    ``$XDG_DATA_HOME`` — the directory main's ``resolveBackendDataDir`` reads
    the ws token from — and not under ``$XDG_CONFIG_HOME``, which is where
    Electron's ``appData`` points on Linux and where main once looked?
    """
    from agent_team_backend import applog, osplat

    data = applog.app_data_dir()
    config = osplat.paths.app_support_dir("Cursor")

    override = os.environ.pop("AGENT_TEAM_DATA_DIR")
    try:
        packaged = applog.app_data_dir()
    finally:
        os.environ["AGENT_TEAM_DATA_DIR"] = override
    expected = os.path.join(os.environ["XDG_DATA_HOME"], "Agent-Team")
    if str(packaged) != expected:
        raise AssertionError(f"no-override data dir is {packaged}, expected {expected}")
    if str(packaged).startswith(os.environ["XDG_CONFIG_HOME"]):
        raise AssertionError(f"no-override data dir {packaged} sits under XDG_CONFIG_HOME")
    return f"data={data} packaged={packaged} cursor={config}"


def pty_round_trip() -> str:
    """The primitives `terminals.py` is built on, end to end.

    If openpty, a ctty-claiming child, the window-size ioctl and a
    process-group kill all work, the PTY layer works: it uses nothing else
    that is platform specific.
    """
    import fcntl
    import pty
    import signal
    import struct
    import termios

    master, slave = pty.openpty()

    def claim_ctty() -> None:
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)

    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 24, 80, 0, 0))
    proc = subprocess.Popen(
        ["/bin/sh", "-c", "echo navide-pty-ok; sleep 5"],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        preexec_fn=claim_ctty,  # noqa: PLW1509 - the point of the check
    )
    os.close(slave)
    time.sleep(0.5)
    try:
        out = os.read(master, 4096)
    finally:
        os.close(master)
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            pass
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:  # pragma: no cover - defensive
            proc.kill()
    if b"navide-pty-ok" not in out:
        raise AssertionError(f"unexpected pty output: {out!r}")
    return "openpty + TIOCSCTTY + TIOCSWINSZ + killpg"


def ps_fields() -> str:
    """The `ps` invocation `pty_registry` uses to recognise its own children.

    The flags are POSIX but the `lstart` column is not universal, and its
    format differs enough between platforms to be worth reading once.
    """
    proc = subprocess.run(
        ["ps", "-Ao", "pid=,ppid=,pgid=,lstart="],
        capture_output=True,
        text=True,
        timeout=5,
    )
    if proc.returncode != 0:
        raise AssertionError(proc.stderr.strip() or f"exit {proc.returncode}")
    first = (proc.stdout or "").strip().splitlines()[0].strip()
    return f"ok, e.g. {first[:56]!r}"


def health() -> str:
    """The app actually serving, not just importing."""
    import socket
    import threading
    import urllib.request

    import uvicorn

    from agent_team_backend.app import app as fastapi_app

    probe_socket = socket.socket()
    probe_socket.bind(("127.0.0.1", 0))
    port = probe_socket.getsockname()[1]
    probe_socket.close()

    server = uvicorn.Server(
        uvicorn.Config(fastapi_app, host="127.0.0.1", port=port, log_level="error")
    )
    threading.Thread(target=server.run, daemon=True).start()
    deadline = time.time() + 45
    last: Exception | None = None
    try:
        while time.time() < deadline:
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/health", timeout=2
                ) as response:
                    return f"HTTP {response.status} {response.read().decode()[:60]}"
            except Exception as err:  # noqa: BLE001 - still starting
                last = err
                time.sleep(0.5)
    finally:
        server.should_exit = True
    raise AssertionError(f"never became healthy: {last}")


def main() -> int:
    if not sys.platform.startswith("linux"):
        print(f"skipped: this smoke test is for Linux, not {sys.platform}")
        return 0

    check("backend imports", imports)
    check("osplat resource probe", probe)
    check("platform paths", paths)
    check("PTY round trip", pty_round_trip)
    check("ps lstart parsing", ps_fields)
    check("/health endpoint", health)

    print()
    print(f"{'CHECK':<24} {'RESULT':<6} DETAIL")
    print("-" * 96)
    for name, status, detail in results:
        print(f"{name:<24} {status:<6} {detail}")
    failed = [row for row in results if row[1] == "FAIL"]
    print("-" * 96)
    print(f"{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    finally:
        shutil.rmtree(_SANDBOX, ignore_errors=True)
