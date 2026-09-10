"""Windows implementations of the platform seams.

Deliberately a set of "not available" answers rather than an empty module: the
Windows port is a later phase, and this file is where its implementations will
land. Reporting unavailable is the contract's own way of saying "not ported
yet", so the backend can be imported and reasoned about on Windows before any
of it works there.
"""

from __future__ import annotations

import os
from pathlib import Path


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
    """Not ported. `GetProcessMemoryInfo`/`GetProcessTimes` go here."""

    def available(self) -> bool:
        return False

    def sample(self, pids: list[int]) -> dict[int, tuple[int, float]]:
        return {}

    def memory_kind(self) -> str:
        return "unavailable"


paths = WindowsPaths()
resource_probe = WindowsResourceProbe()
