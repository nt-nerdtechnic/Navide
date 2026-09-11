"""Darwin implementations of the platform seams.

Every seam here delegates to the module that already held the Darwin branch,
so moving a caller onto the seam cannot change what macOS does. That is the
acceptance condition for the extraction: the shipped platform keeps running
exactly the code it ran before, and the seam only decides *which* module gets
asked.
"""

from __future__ import annotations

import resource
from pathlib import Path

from .. import proc_rusage
from ._posix import process_tree, terminal_backend


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

    def peak_rss_bytes(self) -> int | None:
        # Darwin's ru_maxrss is already in bytes.
        return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss


paths = DarwinPaths()
resource_probe = DarwinResourceProbe()
# PTY and process-group handling are plain POSIX; see `_posix`.
__all__ = ["paths", "process_tree", "resource_probe", "terminal_backend"]


# ---- appended: the Paths members added for the Windows port -----------------
#
# A subclass rather than edits to `DarwinPaths` above, so this lands as a pure
# append; `paths` is rebound below to the complete implementation.

from . import _posix_paths, _posix_secrets  # noqa: E402


class DarwinLayout(DarwinPaths):
    def state_dir(self, app_name: str) -> Path:
        return self.app_support_dir(app_name)

    def config_home(self, home: Path) -> Path:
        return home / "Library" / "Application Support"

    def roaming_app_data(self) -> Path | None:
        return _posix_paths.roaming_app_data()

    def home_env_var(self) -> str:
        return _posix_paths.home_env_var()

    def isolated_home_env(self, home_dir: Path) -> dict[str, str]:
        return _posix_paths.isolated_home_env(home_dir)

    def askpass_launcher(self, helper_py: Path, python_exe: str | None) -> Path:
        return _posix_paths.askpass_launcher(helper_py, python_exe)


paths = DarwinLayout()
secret_files = _posix_secrets.secret_files
