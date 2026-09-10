"""Linux implementations of the platform seams.

Everything here reads `/proc`. That is deliberate: the Darwin probe exists
because spawning `footprint(1)` per sweep turned out to be superlinear in the
pid count, and shelling out to `ps` on Linux would reintroduce the same shape
of problem — one fork per sweep, a timeout to tune, and a number that counts
shared pages once per process.

`/proc` has neither cost: it is a read of already-materialised kernel state,
so a sweep of a hundred and fifty pids is a hundred and fifty small file
reads with no process creation at all.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path

log = logging.getLogger(__name__)

_PROC = Path("/proc")

#: `Pss:              12345 kB` in `/proc/<pid>/smaps_rollup`.
#:
#: PSS is the Linux analogue of Darwin's `phys_footprint`: a page mapped by N
#: processes is charged 1/N to each, so a fleet of same-binary CLIs sums to
#: roughly what the machine actually spends rather than N copies of the shared
#: text. RSS — what `ps` prints — charges the full page to every process, which
#: is the over-reporting the Darwin path was written to avoid (measured at
#: ~40% for a screenful of `claude` processes).
_PSS_PREFIX = "Pss:"

#: `smaps_rollup` is the kernel doing the summation, added in 4.14. Walking
#: `smaps` by hand instead would mean parsing thousands of mapping records per
#: process, which is the superlinear sweep again in a different costume — so a
#: kernel without it reports unavailable rather than falling back to RSS.
#: Mixing PSS for some panes and RSS for others would make the column
#: incomparable across rows, which is worse than an empty panel.
_ROLLUP = "smaps_rollup"

#: Clock ticks per second, for converting `/proc/<pid>/stat` CPU fields. POSIX
#: fixes this at 100 on Linux in practice, but reading it is free and the
#: hard-coded constant is exactly the kind of thing that is wrong on the one
#: machine nobody tested.
try:
    _CLK_TCK = float(os.sysconf("SC_CLK_TCK"))
except (AttributeError, ValueError, OSError):  # pragma: no cover - non-POSIX
    _CLK_TCK = 100.0


def _probe_pss_readable() -> bool:
    """Whether this kernel exposes `smaps_rollup` and lets us read our own.

    Resolved once at import, against our own pid: if the kernel is too old, or
    a hardening policy blocks the file, no amount of retrying per sweep will
    change the answer, and a panel that probes on every tick would pay for the
    failure repeatedly.
    """
    try:
        with open(_PROC / str(os.getpid()) / _ROLLUP, encoding="utf-8") as handle:
            for line in handle:
                if line.startswith(_PSS_PREFIX):
                    return True
    except (OSError, ValueError):
        return False
    return False


_PSS_AVAILABLE = _probe_pss_readable()


def _read_pss_bytes(pid: int) -> int | None:
    """Proportional set size for one pid, or None when it cannot be read."""
    try:
        with open(_PROC / str(pid) / _ROLLUP, encoding="utf-8") as handle:
            for line in handle:
                if not line.startswith(_PSS_PREFIX):
                    continue
                parts = line.split()
                # `Pss:  12345 kB` — the kernel always prints kB here.
                if len(parts) >= 2:
                    return int(parts[1]) * 1024
    except (OSError, ValueError):
        return None
    return None


def _read_cpu_seconds(pid: int) -> float | None:
    """Accumulated user+system CPU for one pid, or None when it cannot be read.

    `comm` (field 2) is the process name, unquoted and free to contain both
    spaces and parentheses, so the fields after it can only be found by
    splitting from the *last* `)` — the usual `line.split()[13]` is wrong for
    any process whose name has a space in it, which on this machine includes
    several of the CLIs being measured.
    """
    try:
        with open(_PROC / str(pid) / "stat", encoding="utf-8") as handle:
            raw = handle.read()
    except (OSError, ValueError):
        return None
    close = raw.rfind(")")
    if close < 0:
        return None
    # rest[0] is `state`, which is field 3, so field N is at rest[N - 3].
    rest = raw[close + 2 :].split()
    if len(rest) < 13:
        return None
    try:
        utime = float(rest[11])  # field 14
        stime = float(rest[12])  # field 15
    except ValueError:
        return None
    return (utime + stime) / _CLK_TCK


class LinuxPaths:
    """XDG base directories, with the spec's own defaults when unset.

    The environment variables are only consulted when the caller did not name
    a home: a per-pane home exists precisely to point a CLI somewhere other
    than the real user directory, and honouring `$XDG_CONFIG_HOME` there would
    send it straight back.
    """

    def app_support_dir(self, app_name: str, *, home: Path | None = None) -> Path:
        if home is not None:
            return home / ".config" / app_name
        configured = os.environ.get("XDG_CONFIG_HOME")
        base = Path(configured) if configured else Path.home() / ".config"
        return base / app_name

    def cache_dir(self, *, home: Path | None = None) -> Path:
        if home is not None:
            return home / ".cache"
        configured = os.environ.get("XDG_CACHE_HOME")
        return Path(configured) if configured else Path.home() / ".cache"


class LinuxResourceProbe:
    """Memory and CPU from `/proc`, one directory read per pid."""

    def available(self) -> bool:
        return _PSS_AVAILABLE

    def sample(self, pids: list[int]) -> dict[int, tuple[int, float]]:
        if not _PSS_AVAILABLE or not pids:
            return {}
        out: dict[int, tuple[int, float]] = {}
        for pid in pids:
            if pid <= 0:
                continue
            memory = _read_pss_bytes(pid)
            if memory is None:
                # Died mid-sweep, or belongs to another user. Same contract as
                # the Darwin probe: absent rather than zero, so the caller can
                # tell "not measured" from "measured as nothing".
                continue
            cpu = _read_cpu_seconds(pid)
            out[pid] = (memory, cpu if cpu is not None else 0.0)
        return out

    def memory_kind(self) -> str:
        return "pss"


paths = LinuxPaths()
resource_probe = LinuxResourceProbe()
