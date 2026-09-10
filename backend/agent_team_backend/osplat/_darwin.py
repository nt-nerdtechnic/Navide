"""Darwin implementations of the platform seams.

Every seam here delegates to the module that already held the Darwin branch,
so moving a caller onto the seam cannot change what macOS does. That is the
acceptance condition for the extraction: the shipped platform keeps running
exactly the code it ran before, and the seam only decides *which* module gets
asked.
"""

from __future__ import annotations

from pathlib import Path

from .. import proc_rusage


class DarwinPaths:
    """`~/Library/...`, the layout every macOS desktop app follows."""

    def app_support_dir(self, app_name: str, *, home: Path | None = None) -> Path:
        return (home or Path.home()) / "Library" / "Application Support" / app_name

    def cache_dir(self, *, home: Path | None = None) -> Path:
        return (home or Path.home()) / "Library" / "Caches"


class DarwinResourceProbe:
    """`proc_pid_rusage`, unchanged — see `proc_rusage` for why it is a syscall."""

    def available(self) -> bool:
        return proc_rusage.available()

    def sample(self, pids: list[int]) -> dict[int, tuple[int, float]]:
        return proc_rusage.sample(pids)

    def memory_kind(self) -> str:
        return "phys_footprint"


paths = DarwinPaths()
resource_probe = DarwinResourceProbe()
