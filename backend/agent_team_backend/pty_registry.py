"""On-disk registry of live PTY child process groups.

PTY children are spawned with start_new_session=True (own process group), so
a backend that dies without running its shutdown sweep (SIGKILL, crash) leaves
them behind as orphans. Every spawn is recorded here and removed on close; at
startup, entries left over from a previous run are identity-checked and their
process groups killed.

Identity is the process start time (ps lstart), not the command line: shells
spawned as `zsh -lc <cmd>` exec the final command, so the visible command
never matches the spawn argv, while pid+start-time survives exec and defeats
pid recycling. Each entry also records the owning backend pid so a second
backend sharing the data dir never reaps a live sibling's children.
"""

from __future__ import annotations

import json
import logging
import os
import signal
import subprocess
import threading
import time
from pathlib import Path

from .applog import app_data_dir

log = logging.getLogger(__name__)

# Force a fixed locale so the lstart string captured at register time compares
# equal to the one read back at reap time.
_PS_ENV = {**os.environ, "LC_ALL": "C"}

# register/unregister run on executor threads (terminals.py keeps their ps +
# file I/O off the event loop), so every load-modify-save must be atomic.
_lock = threading.Lock()


def _registry_path() -> Path:
    return app_data_dir() / "pty-registry.json"


def _load() -> dict[str, dict]:
    try:
        data = json.loads(_registry_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _save(entries: dict[str, dict]) -> None:
    path = _registry_path()
    tmp = path.with_name(path.name + ".tmp")
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp.write_text(json.dumps(entries), encoding="utf-8")
        os.replace(tmp, path)
    except OSError as err:
        log.warning("pty registry write failed: %s", err)
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass


def _ps(pid: int, fields: str) -> str | None:
    """One-line ps probe; None means the probe itself failed (not "no such
    process" — that returns an empty string)."""
    try:
        out = subprocess.run(
            ["ps", "-p", str(pid), "-o", fields],
            capture_output=True,
            text=True,
            timeout=5,
            env=_PS_ENV,
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.strip()


def register(pid: int, argv: list[str]) -> None:
    lstart = _ps(pid, "lstart=") or ""  # probe outside the lock (up to 5s)
    with _lock:
        entries = _load()
        entries[str(pid)] = {
            "argv0": argv[0],  # diagnostic only; identity is lstart
            "lstart": lstart,
            "owner": os.getpid(),
        }
        _save(entries)


def unregister(pid: int) -> None:
    with _lock:
        entries = _load()
        if entries.pop(str(pid), None) is not None:
            _save(entries)


def _backend_alive(pid: int) -> bool:
    """Is `pid` a live agent_team_backend process (a sibling sharing this
    data dir)? A recycled pid running something else counts as dead."""
    out = _ps(pid, "command=")
    if out is None:
        return True  # can't tell — err on the side of not touching its children
    return "agent_team_backend" in out


_MATCH, _GONE, _ERROR = "match", "gone", "error"


def _classify(pid: int, info: dict) -> str:
    out = _ps(pid, "pgid=,lstart=")
    if out is None:
        return _ERROR
    if not out:
        return _GONE
    parts = out.split(None, 1)
    if len(parts) != 2 or parts[0] != str(pid):
        return _GONE  # not a session/group leader → recycled pid
    recorded = info.get("lstart") or ""
    if recorded and parts[1].strip() == recorded:
        return _MATCH
    return _GONE  # different start time (recycled pid) or unverifiable entry


def scan_orphans() -> list[int]:
    """Pids of live PTY children recorded by a now-dead backend run — exactly the
    ones reap_stale would kill. Read-only: never signals a process or rewrites
    the registry, so it is safe to poll for a "how many leftovers?" status check
    (the pileup that silently exhausted RAM was invisible until now)."""
    with _lock:
        entries = _load()
        if not entries:
            return []
        me = os.getpid()
        orphans: list[int] = []
        for pid_s, info in entries.items():
            owner = info.get("owner")
            if isinstance(owner, int) and (owner == me or _backend_alive(owner)):
                continue  # a live backend (this one or a sibling) owns it — not an orphan
            if _classify(int(pid_s), info) == _MATCH:
                orphans.append(int(pid_s))
        return orphans


def reap_stale(grace: float = 1.0) -> list[int]:
    """Kill process groups recorded by a dead backend run.

    Blocking (ps + grace sleep) — call via asyncio.to_thread. Entries owned by
    a live sibling backend are left untouched; entries whose ps probe failed
    are kept for the next startup; everything else is killed or confirmed
    gone and dropped. Returns the pids that were signalled.

    Holds the registry lock for its whole run: _save(keep) rewrites the file
    from the entries loaded at the top, so an interleaved register would be
    lost if the load→save window were left open.
    """
    with _lock:
        entries = _load()
        if not entries:
            return []
        me = os.getpid()
        kill: list[int] = []
        keep: dict[str, dict] = {}
        for pid_s, info in entries.items():
            owner = info.get("owner")
            if isinstance(owner, int) and (owner == me or _backend_alive(owner)):
                keep[pid_s] = info
                continue
            verdict = _classify(int(pid_s), info)
            if verdict == _MATCH:
                kill.append(int(pid_s))
            elif verdict == _ERROR:
                keep[pid_s] = info
            # _GONE → drop
        for pid in kill:
            try:
                os.killpg(pid, signal.SIGTERM)
            except (ProcessLookupError, PermissionError):
                pass
        if kill:
            time.sleep(grace)
            for pid in kill:
                try:
                    os.killpg(pid, signal.SIGKILL)
                except (ProcessLookupError, PermissionError):
                    pass
            log.info("reaped %d orphaned PTY process group(s): %s", len(kill), kill)
        _save(keep)
        return kill
