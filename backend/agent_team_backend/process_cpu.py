"""CPU time of the CLI processes Navide runs.

`ps -o %cpu` is the obvious source and the wrong one: on macOS that column is
the process's *lifetime* average, so a CLI that has been resident for an hour
and is right now pinning a core still reads close to zero. `top -l 2` reports
the live figure but bakes in a one-second sample interval and caps the pids it
will take, which makes it unusable for a panel that has to open instantly.

What is both cheap and correct is the accumulated CPU time the kernel has
charged the process. Two readings divided by the wall time between them give
the average utilisation over that interval — which is what a resource panel
actually wants to show. This module only takes the readings; the differencing
lives in the caller, so that two windows sampling at different rates each get
their own interval instead of fighting over one shared previous sample.

The counter is read straight from the kernel through the platform probe (see
`osplat.resource_probe`) — `proc_pid_rusage` on macOS, `/proc` on Linux,
psutil on Windows — costing no subprocess to spawn or time out, and giving
the same figure `ps -o time=` prints. `ps` stays as the fallback for a machine
where the probe cannot be resolved at all, taking the whole pid list in one
call.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import time

from . import osplat

log = logging.getLogger(__name__)

#: `  22751   1:02.34` — pid then accumulated CPU time, one process per line.
_ROW_RE = re.compile(r"^\s*(\d+)\s+(\S+)\s*$")

#: `ps` reads /proc-equivalent state and returns immediately; a timeout this
#: short still leaves room for a machine deep in swap.
_SWEEP_TIMEOUT_S = 5.0

#: Whether this machine has a `ps` for the fallback path, resolved on first
#: use. None until then.
_HAS_PS: bool | None = None

#: Same cap as the footprint sweep — beyond this the panel is an audit, not a
#: summary, and the `ps` fallback's argv gets unwieldy.
_MAX_PIDS = 4000


def available() -> bool:
    """Whether the CPU sweep can be expected to work.

    The platform probe answers first; only when there is none does it matter
    whether this machine has a `ps` to fall back on. Asking `shutil.which` is
    what replaced the platform branch that used to live here: Windows has no
    `ps`, and neither does a stripped container, so the question the sweep
    actually has is whether the command exists — not which OS this is.
    """
    if osplat.resource_probe.available():
        return True
    global _HAS_PS
    if _HAS_PS is None:
        # Cached: `available()` runs once per sweep and the sweep is on a
        # timer, while a PATH scan is filesystem work.
        _HAS_PS = shutil.which("ps") is not None
    return _HAS_PS


def parse_cpu_time(raw: str) -> float | None:
    """Seconds from a `ps` TIME field, or None when it is not one.

    The field widens as the number grows: `1:02.34`, `12:34:56`,
    `2-03:04:05`. Anything else (a header that slipped through, a dash for a
    process that vanished mid-sweep) is not worth guessing at.
    """
    text = raw.strip()
    if not text:
        return None
    days = 0.0
    if "-" in text:
        head, _, text = text.partition("-")
        try:
            days = float(head)
        except ValueError:
            return None
    parts = text.split(":")
    if len(parts) > 3:
        return None
    total = 0.0
    try:
        for part in parts:
            total = total * 60.0 + float(part)
    except ValueError:
        return None
    return days * 86400.0 + total


def cpu_times(pids: list[int]) -> tuple[dict[int, float], float]:
    """Accumulated CPU seconds per pid, plus the wall clock of the reading.

    Missing pids are simply absent. Never raises: a panel that cannot measure
    shows nothing, which is honest, while an exception here would take down the
    request that asked.

    The timestamp is returned alongside because the caller differences two
    sweeps — pairing the reading with a clock read on its own would attribute
    the subprocess's own duration to the interval.
    """
    taken_at = time.time()
    if not available() or not pids:
        return {}, taken_at
    unique = sorted({p for p in pids if p > 0})
    if not unique or len(unique) > _MAX_PIDS:
        if unique:
            log.info("cpu sweep skipped: %d pids over the cap", len(unique))
        return {}, taken_at
    sampled = osplat.resource_probe.sample(unique)
    if sampled:
        return {pid: cpu for pid, (_bytes, cpu) in sampled.items()}, time.time()
    # Either the probe is unavailable on this platform, or every target died
    # between the caller listing them and the sweep. `ps` answers both the same
    # way it always did.
    if osplat.resource_probe.available():
        return {}, time.time()
    try:
        proc = subprocess.run(
            ["ps", "-o", "pid=,time=", "-p", ",".join(str(p) for p in unique)],
            capture_output=True,
            text=True,
            timeout=_SWEEP_TIMEOUT_S,
        )
    except (OSError, subprocess.SubprocessError) as err:
        log.info("cpu sweep failed: %s", err)
        return {}, taken_at
    taken_at = time.time()
    # A non-zero exit is normal when every requested pid has died; whatever
    # printed is still valid, so the output is parsed either way.
    out: dict[int, float] = {}
    for line in (proc.stdout or "").splitlines():
        match = _ROW_RE.match(line)
        if not match:
            continue
        seconds = parse_cpu_time(match.group(2))
        if seconds is None:
            continue
        out[int(match.group(1))] = seconds
    return out, taken_at


def machine_capacity() -> tuple[int, int]:
    """(logical CPU count, total physical memory in bytes) for this machine.

    The per-pane figures are relative to a single core, the way Activity
    Monitor reports them, so a summary that says "how much of this machine is
    Navide using" needs the denominators. Both come from POSIX sysconf; a
    platform that will not answer gets zeros, and the caller then shows the raw
    totals instead of a share.
    """
    try:
        cpus = os.cpu_count() or 0
    except NotImplementedError:  # pragma: no cover - platform specific
        cpus = 0
    try:
        memory = os.sysconf("SC_PAGE_SIZE") * os.sysconf("SC_PHYS_PAGES")
    except (AttributeError, ValueError, OSError):  # pragma: no cover - non-POSIX
        memory = 0
    return cpus, max(0, memory)


def sum_by_group(groups: dict[str, list[int]], measured: dict[int, float]) -> dict[str, float]:
    """Total each group's pids.

    A pane is a tree — the PTY child is a shell, and the CLI, its MCP servers
    and anything else it spawned hang below it — so the number a user reads
    next to a pane name has to be the whole tree, not the shell that happens to
    own the tty.
    """
    return {
        key: sum(measured.get(pid, 0.0) for pid in pids)
        for key, pids in groups.items()
    }
