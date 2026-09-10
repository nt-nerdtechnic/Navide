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

from pathlib import Path
from typing import Protocol


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
